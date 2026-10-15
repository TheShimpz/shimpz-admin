"""The Admin session socket (ADR-0114): admission, per-frame checks, calls, budgets, and closure."""

import asyncio
import importlib
import json
import threading
import time
from unittest import mock

from mfa_helper import passkey_record, unjournaled
from tests.session_socket_case import SessionSocketCase

from tests import chat_socket_fixtures

_Socket = chat_socket_fixtures.Socket
ADMIN_PAGE = [(b"sec-fetch-site", b"same-origin")]
TEAMS = {"teams": [{"team_id": "team_1", "team_name": "Marketing", "status": "running"}]}


class SessionSocketAdmissionTests(SessionSocketCase):
    def test_origin_fetch_metadata_subprotocol_and_session_are_required_before_accept(self) -> None:
        async def refused(code: int, **options) -> None:
            websocket = _Socket(self.admin_app.app, **options)
            self.assertEqual(await websocket.start(), self._refusal(code))
            await websocket.finish()

        async def scenario() -> None:
            with mock.patch.object(self.admin_app, "_session_current", side_effect=AssertionError("auth must not run")):
                for origin, headers in (
                    ("http://localhost:7777.evil.test", []),
                    (None, []),
                    ("null", []),
                    ("HTTP://LOCALHOST:7777", []),
                    ("http://localhost:7777/", []),
                    ("http://localhost:7777", [(b"origin", b"http://localhost:7777")]),
                    ("http://localhost:7777", [(b"sec-fetch-site", b"cross-site")]),
                    ("http://localhost:7777", [*ADMIN_PAGE, *ADMIN_PAGE]),
                ):
                    with self.subTest(origin=origin, headers=headers):
                        await refused(4403, token=self.token, origin=origin, headers=headers)
            for protocols in (["shimpz.chat.v7"], ["shimpz.admin.v1", "shimpz.admin.v2"], []):
                with self.subTest(protocols=protocols):
                    await refused(4406, token=self.token, protocols=protocols)
            await refused(4401)
            await refused(4401, token="v3:1:2:pwd+totp:" + "0" * 64)
            admitted = await self._connect(headers=ADMIN_PAGE)
            await admitted.disconnect()

        asyncio.run(scenario())

    def test_admission_checks_the_session_without_renewing_it(self) -> None:
        async def scenario() -> None:
            with mock.patch.object(
                self.admin_app.auth.SESSIONS, "current", wraps=self.admin_app.auth.SESSIONS.current
            ) as current:
                websocket = await self._connect()
            self.assertTrue(current.call_args_list)
            self.assertTrue(all(call.kwargs == {"activity": False} for call in current.call_args_list))
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_unavailable_authorities_refuse_with_a_retryable_close(self) -> None:
        async def scenario() -> None:
            with mock.patch.object(self.admin_app, "_allowed_browser_origins", side_effect=RuntimeError("unreadable")):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertEqual(await websocket.start(), self._refusal(1013))
            unavailable = self.admin_app.SessionEvidenceUnavailableError()
            with mock.patch.object(self.admin_app, "_session_current", new=mock.AsyncMock(side_effect=unavailable)):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertEqual(await websocket.start(), self._refusal(1013))

        asyncio.run(scenario())

    def test_a_password_bound_external_origin_is_resolved_for_each_handshake_and_frame(self) -> None:
        external = "https://developer.example.test"

        async def scenario() -> None:
            before = _Socket(self.admin_app.app, token=self.token, origin=external)
            self.assertEqual(await before.start(), self._refusal(4403))
            self.assertEqual(self.admin_app.state.bind_browser_origin(external), "learned")
            admitted = await self._connect(origin=external)
            loopback = await self._connect()
            # Replacing the learned origin closes the socket bound to it at its next frame, before the read runs.
            self.assertEqual(self.admin_app.state.bind_browser_origin("https://next.example.test"), "replaced")
            with mock.patch.object(self.methods.team_order, "listing", side_effect=AssertionError("must not read")):
                await admitted.call("teams.list", {})
                self.assertEqual(await self._closed(admitted), 4403)
            await admitted.finish()
            stale = _Socket(self.admin_app.app, token=self.token, origin=external)
            self.assertEqual(await stale.start(), self._refusal(4403))
            # A socket from a still admitted origin keeps working.
            with mock.patch.object(self.methods.team_order, "listing", return_value=self._listing()):
                self.assertEqual((await loopback.result("teams.list", {}))["status"], 200)
            await loopback.disconnect()

        asyncio.run(scenario())

    def test_a_session_holds_at_most_eight_sockets_and_a_limited_open_budget(self) -> None:
        async def scenario() -> None:
            sockets = [await self._connect() for _ in range(8)]
            ninth = _Socket(self.admin_app.app, token=self.token)
            self.assertEqual(await ninth.start(), self._refusal(1013))
            for websocket in sockets:
                await websocket.disconnect()
            again = await self._connect()
            await again.disconnect()
            # Reconnecting never replenishes the session's open budget.
            with mock.patch.object(self.budget, "OPENS", self.budget.SessionBudget(0)):
                refused = _Socket(self.admin_app.app, token=self.token)
                self.assertEqual(await refused.start(), self._refusal(1013))

        asyncio.run(scenario())

    @staticmethod
    def _listing():
        from fastapi.responses import JSONResponse

        return JSONResponse(TEAMS)


class SessionSocketFrameTests(SessionSocketCase):
    def _listing(self):
        from fastapi.responses import JSONResponse

        return JSONResponse(TEAMS)

    def test_a_call_is_answered_with_exactly_one_result_and_its_topic_revision(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            revision = self.topics.changed("teams")
            with mock.patch.object(self.methods.team_order, "listing", return_value=self._listing()):
                result = await websocket.result("teams.list", {})
            self.assertEqual(
                result,
                {
                    "type": "result",
                    "id": "call-1",
                    "status": 200,
                    "body": TEAMS,
                    "topic": "teams",
                    "epoch": self.topics.EPOCH,
                    "revision": revision,
                },
            )
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_malformed_unknown_and_oversized_frames_close_the_socket(self) -> None:
        async def closes(code: int, *, text: str | None = None, data: bytes | None = None) -> None:
            websocket = await self._connect()
            if data is not None:
                await websocket.send_bytes(data)
            else:
                await websocket.send_text(text)
            self.assertEqual(await self._closed(websocket), code)
            await websocket.finish()

        async def scenario() -> None:
            await closes(1007, text='{"type":"call","id":"a","id":"b","method":"teams.list","params":{}}')
            await closes(1007, text="not json")
            await closes(1009, text="x" * (128 * 1024 + 1))
            await closes(1003, data=b"{}")
            for frame in (
                {"type": "done"},
                {"type": "call", "id": "c1", "method": "teams.delete", "params": {}},
                {"type": "call", "id": "c1", "method": "teams.list", "params": {"extra": 1}},
                {"type": "stop", "team_id": "team_1"},
                {"type": "stop"},
            ):
                with self.subTest(frame=frame):
                    await closes(1008, text=json.dumps(frame))

        asyncio.run(scenario())

    def test_duplicate_in_flight_ids_close_and_more_than_sixteen_calls_are_refused(self) -> None:
        release = asyncio.Event()

        async def held(*_args):
            await release.wait()
            return 200, TEAMS

        async def scenario() -> None:
            websocket = await self._connect()
            with mock.patch.dict(self.methods.METHODS, {"teams.list": held}):
                for index in range(16):
                    await websocket.send_json({"type": "call", "id": f"c{index}", "method": "teams.list", "params": {}})
                await websocket.send_json({"type": "call", "id": "c16", "method": "teams.list", "params": {}})
                refused = await websocket.next_frame()
                self.assertEqual((refused["id"], refused["status"]), ("c16", 429))
                release.set()
                answered = {(await websocket.next_frame())["id"] for _ in range(16)}
                self.assertEqual(answered, {f"c{index}" for index in range(16)})
                release.clear()
                await websocket.send_json({"type": "call", "id": "same", "method": "teams.list", "params": {}})
                await websocket.send_json({"type": "call", "id": "same", "method": "teams.list", "params": {}})
                self.assertEqual(await self._closed(websocket), 1008)
                release.set()
            await websocket.finish()

        asyncio.run(scenario())

    def test_session_budgets_refuse_calls_and_changes_beyond_their_minute(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            with mock.patch.object(self.budget, "CHANGE_BUDGET", self.budget.SessionBudget(1)):
                self.assertEqual((await websocket.result("subscribe", {"topics": ["teams"]}))["status"], 200)
                self.assertEqual((await websocket.result("unsubscribe", {"topics": ["teams"]}))["status"], 429)
            with mock.patch.object(self.budget, "CALL_BUDGET", self.budget.SessionBudget(0)):
                refused = await websocket.result("teams.list", {})
                self.assertEqual((refused["status"], refused["body"]), (429, {"detail": "session call budget reached"}))
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_a_full_call_lane_answers_429_as_the_chat_lanes_do(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            with mock.patch.object(
                self.lane, "submit_in_context", side_effect=self.lane.ExecutorSaturatedError("full")
            ):
                refused = await websocket.result("teams.list", {})
            self.assertEqual(refused["status"], 429)
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_a_waiting_read_runs_only_while_its_origin_and_session_are_still_current(self) -> None:
        external = "https://developer.example.test"
        workers = 4
        started = []
        busy = threading.Event()
        release = threading.Event()

        def listing():
            started.append(True)
            if len(started) == workers:
                busy.set()
            release.wait(5)
            return self._listing()

        async def scenario() -> None:
            self.assertEqual(self.admin_app.state.bind_browser_origin(external), "learned")
            websocket = await self._connect(origin=external)
            with mock.patch.object(self.methods.team_order, "listing", side_effect=listing):
                # The lane's four workers are busy, so a fifth read waits for one.
                for _ in range(workers + 1):
                    await websocket.call("teams.list", {})
                await chat_socket_fixtures.wait_for_thread(busy)
                # The admitted origin is replaced while the fifth read waits: it must never run under it.
                self.assertEqual(self.admin_app.state.bind_browser_origin("https://next.example.test"), "replaced")
                release.set()
                self.assertEqual(await self._closed(websocket), 4403)
                await websocket.finish()
            self.assertEqual(len(started), workers)

        asyncio.run(scenario())

    def test_a_result_too_large_for_one_frame_is_answered_as_a_failure(self) -> None:
        async def large(*_args):
            return 200, {"teams": ["x" * (1024 * 1024)]}

        async def scenario() -> None:
            websocket = await self._connect()
            with mock.patch.dict(self.methods.METHODS, {"teams.list": large}):
                result = await websocket.result("teams.list", {})
            self.assertEqual(
                (result["status"], result["body"]), (502, {"detail": "the result exceeds the session frame bound"})
            )
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_an_overflowing_outbound_queue_closes_the_socket(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            socket = next(iter(self._sockets()))
            with self.assertRaises(self.session_socket.OutboundOverflowError):
                for _ in range(1100):
                    socket.send({"type": "changed-test", "padding": "x" * 1024})
            self.assertEqual(await self._closed(websocket), 1013)
            await websocket.finish()

        asyncio.run(scenario())

    def _sockets(self):
        """The open session sockets, through the listeners their topics registered."""
        return [listener.__self__ for listener in self.topics._listeners]

    def test_authority_is_bound_again_for_every_call(self) -> None:
        scopes = []
        real_scope = self.admin_app._team_session_scope

        def counted(cookies, **kwargs):
            scopes.append(dict(cookies))
            return real_scope(cookies, **kwargs)

        async def scenario() -> None:
            with mock.patch.object(self.admin_app, "_team_session_scope", side_effect=counted):
                websocket = await self._connect()
                with mock.patch.object(self.methods.team_order, "listing", return_value=self._listing()):
                    await websocket.result("teams.list", {})
                    await websocket.result("teams.list", {})
                await websocket.disconnect()

        asyncio.run(scenario())
        self.assertEqual(scopes, [{"shimpz_admin": self.token}, {"shimpz_admin": self.token}])

    def test_an_unavailable_supervisor_identity_answers_503_as_the_http_gate_does(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            with mock.patch.object(
                self.admin_app.state, "local_supervisor", side_effect=self.admin_app.supervisor.SupervisorAuthorityError
            ):
                result = await websocket.result("teams.list", {})
            self.assertEqual(
                (result["status"], result["body"]), (503, {"detail": "Supervisor authority is unavailable"})
            )
            await websocket.disconnect()

        asyncio.run(scenario())


class SessionSocketClosureTests(SessionSocketCase):
    """Every session-ending event closes the session's sockets at once with 4401, without waiting for a frame."""

    def _ends_every_socket(self, event) -> None:
        async def scenario() -> None:
            other = self.admin_app.auth.issue_session(self.admin_app.state.get()["session_secret"], "webauthn")
            first = await self._connect()
            second = _Socket(self.admin_app.app, token=other)
            self.assertTrue(self._accepted(await second.start()))
            await asyncio.to_thread(event)
            self.assertEqual(await self._closed(first), 4401)
            self.assertEqual(await self._closed(second), 4401)
            await first.finish()
            await second.finish()
            self.assertEqual(self.registry.REGISTRY.handles(), ())

        asyncio.run(scenario())

    def test_logout_closes_every_socket_at_once(self) -> None:
        self._ends_every_socket(lambda: self.admin_app.state.revoke_sessions_for_logout(self.token))

    def test_a_passkey_suspension_closes_every_socket_at_once(self) -> None:
        state = self.admin_app.state
        state.add_passkey(passkey_record(), state.factor_generation(), journal=unjournaled)
        self.token = self.admin_app.auth.issue_session(state.get()["session_secret"], "webauthn")
        passkeys = importlib.import_module("mfa.passkeys")

        def regress() -> None:
            original = state.passkey_for_authentication("credential_A", "http://localhost:7777")
            # A signature counter that went backwards suspends the passkey and rotates every session.
            result = passkeys.Authentication("credential_A", 1, False, False)
            self.assertEqual(
                state.commit_passkey_authentication(
                    original, result, state.factor_generation(), now=1_800_000_100, journal=unjournaled
                )[1],
                "counter-regression",
            )

        self._ends_every_socket(regress)

    def test_a_recovery_code_spent_closes_every_socket_at_once(self) -> None:
        state = self.admin_app.state
        mfa_helper = importlib.import_module("tests.mfa_helper")

        def spend() -> None:
            candidate = state.recovery_candidate(mfa_helper.recovery_codes()[0])
            verification, _enrollment = state.spend_recovery_code(
                candidate, generation=state.factor_generation(), journal=unjournaled
            )
            self.assertEqual(verification.value, "accepted")

        self._ends_every_socket(spend)

    def test_tracking_eviction_closes_the_evicted_sessions_sockets(self) -> None:
        auth = self.admin_app.auth

        async def scenario() -> None:
            websocket = await self._connect()
            secret = self.admin_app.state.get()["session_secret"]
            for _ in range(auth.MAX_TRACKED_SESSIONS):
                auth.issue_session(secret, "totp")
            self.assertEqual(await self._closed(websocket), 4401)
            await websocket.finish()

        asyncio.run(scenario())

    def test_a_quiet_socket_closes_at_its_sessions_absolute_expiry(self) -> None:
        auth = self.admin_app.auth
        secret = self.admin_app.state.get()["session_secret"]
        # A session signed in almost a day ago ends in a moment; its quiet socket closes then, with no frame sent.
        self.token = auth.issue_session(secret, "totp", issued_at=int(time.time()) - auth.TTL + 1)

        async def scenario() -> None:
            websocket = await self._connect()
            self.assertEqual(await self._closed(websocket), 4401)
            await websocket.finish()

        asyncio.run(scenario())

    def test_a_quiet_socket_closes_at_its_sessions_idle_expiry(self) -> None:
        auth = self.admin_app.auth
        sessions = auth.SessionActivity(idle_seconds=1)
        sessions.listen(self.registry.REGISTRY.end_sessions)
        sessions.register(self.token)

        async def scenario() -> None:
            websocket = await self._connect()
            started = asyncio.get_running_loop().time()
            self.assertEqual(await self._closed(websocket), 4401)
            self.assertLess(asyncio.get_running_loop().time() - started, 3)
            await websocket.finish()

        with mock.patch.object(auth, "SESSIONS", sessions):
            asyncio.run(scenario())

    def test_no_call_renews_the_session(self) -> None:
        auth = self.admin_app.auth

        async def scenario() -> None:
            websocket = await self._connect()
            with (
                mock.patch.object(auth.SESSIONS, "current", wraps=auth.SESSIONS.current) as current,
                mock.patch.object(
                    self.methods.team_order, "listing", return_value=SessionSocketFrameTests._listing(None)
                ),
            ):
                await websocket.result("teams.list", {})
                await websocket.result("subscribe", {"topics": ["teams"]})
            self.assertTrue(current.call_args_list)
            self.assertEqual({call.kwargs["activity"] for call in current.call_args_list}, {False})
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_closing_stops_the_active_turn(self) -> None:
        turn, started, release = chat_socket_fixtures.held_turn()

        async def scenario() -> None:
            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped) as stop,
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("work"))
                await chat_socket_fixtures.wait_for_thread(started)
                await asyncio.to_thread(self.admin_app.state.revoke_sessions_for_logout, self.token)
                self.assertEqual(await self._closed(websocket), 4401)
                await websocket.finish()
                release.set()
                stop.assert_called_once_with("team_1")

        asyncio.run(scenario())


class SessionSocketTopicTests(SessionSocketCase):
    async def _subscribed(self, *named: str) -> _Socket:
        websocket = await self._connect()
        result = await websocket.result("subscribe", {"topics": list(named)})
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"]["epoch"], self.topics.EPOCH)
        self.assertEqual(set(result["body"]["topics"]), set(named))
        return websocket

    async def _changed(self, websocket: _Socket, topic: str) -> dict:
        frame = await websocket.next_frame()
        self.assertEqual((frame["type"], frame["topic"], frame["epoch"]), ("changed", topic, self.topics.EPOCH))
        self.assertEqual(frame["revision"], self.topics.revision(topic))
        return frame

    def test_a_change_reaches_only_sockets_subscribed_to_its_topic(self) -> None:
        async def scenario() -> None:
            subscribed = await self._subscribed("teams")
            other = await self._subscribed("assistants/registry")
            self.topics.changed("teams")
            await self._changed(subscribed, "teams")
            with self.assertRaises(TimeoutError):
                await other.next_frame(0.2)
            await subscribed.result("unsubscribe", {"topics": ["teams"]})
            self.topics.changed("teams")
            with self.assertRaises(TimeoutError):
                await subscribed.next_frame(0.2)
            await subscribed.disconnect()
            await other.disconnect()

        asyncio.run(scenario())

    def test_a_socket_subscribes_to_at_most_64_topics(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            named = [f"team/team_{index}/history" for index in range(64)]
            self.assertEqual((await websocket.result("subscribe", {"topics": named}))["status"], 200)
            self.assertEqual((await websocket.result("subscribe", {"topics": ["teams"]}))["status"], 409)
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_queued_changes_coalesce_to_the_newest_revision(self) -> None:
        outbound = importlib.import_module("session.outbound").Outbound(limit=4096)
        outbound.put('{"type":"result"}')
        for revision in range(1, 6):
            outbound.put(json.dumps({"type": "changed", "topic": "teams", "revision": revision}), topic="teams")
        outbound.put('{"type":"done"}')

        async def drain() -> list[str]:
            return [await outbound.take() for _ in range(3)]

        frames = asyncio.run(drain())
        self.assertEqual(frames[0], '{"type":"result"}')
        self.assertEqual(json.loads(frames[1])["revision"], 5)
        self.assertEqual(frames[2], '{"type":"done"}')
        self.assertEqual(outbound.queued, 0)

    def test_admin_raises_the_topics_its_own_writes_change(self) -> None:
        async def scenario() -> None:
            websocket = await self._subscribed("team/team_1/history", "security/summary", "session")
            await asyncio.to_thread(self.history_store.append_user, "team_1", "c" * 32, "hello")
            await self._changed(websocket, "team/team_1/history")
            await asyncio.to_thread(self.admin_app.audit.record, "logout", outcome="ok", origin=None)
            await self._changed(websocket, "security/summary")
            await asyncio.to_thread(self.admin_app.state.bind_browser_origin, "https://admin.example.test")
            await self._changed(websocket, "session")
            await asyncio.to_thread(self.history_store.clear_team, "team_1")
            await self._changed(websocket, "team/team_1/history")
            # A write that commits nothing changes nothing.
            await asyncio.to_thread(self.history_store.append_user, "team_1", "d" * 32, "first")
            await self._changed(websocket, "team/team_1/history")
            self.assertFalse(await asyncio.to_thread(self.history_store.append_user, "team_1", "d" * 32, "conflicting"))
            with self.assertRaises(TimeoutError):
                await websocket.next_frame(0.2)
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_routine_notices_and_runs_raise_the_teams_routines(self) -> None:
        delivery = importlib.import_module("routine.delivery")
        changed = []
        notice = {"team_id": "team_1", "notice_id": "n", "version": 1}
        with (
            mock.patch.object(delivery.team, "notices", return_value={"notices": [notice], "more": False}),
            mock.patch.object(delivery.history, "append_routine_notice", return_value=True),
            mock.patch.object(delivery.team, "acknowledge"),
            mock.patch.object(delivery.topics, "team_changed", side_effect=lambda *args: changed.append(args)),
        ):
            self.assertEqual(delivery.deliver(), 1)
        self.assertEqual(changed, [("team_1", "routines")])


class SessionSocketWatcherTests(SessionSocketCase):
    def setUp(self) -> None:
        super().setUp()
        watcher_module = importlib.import_module("session.watcher")
        self.values = {"local-assistants": [1, 1, 2]}
        self.reads = []

        def read(topic):
            def value():
                self.reads.append(topic)
                values = self.values[topic]
                return values.pop(0) if len(values) > 1 else values[0]

            return value

        watched = {"local-assistants": watcher_module.Watched(0.05, read("local-assistants"))}
        self.watcher = watcher_module.Watcher(watched, tick=0.01)
        patch = mock.patch.object(watcher_module, "WATCHER", self.watcher)
        patch.start()
        self.addCleanup(patch.stop)

    def test_the_watcher_reads_only_while_subscribed_and_raises_only_a_changed_value(self) -> None:
        auth = self.admin_app.auth

        async def scenario() -> None:
            websocket = await self._connect()
            await asyncio.sleep(0.1)
            self.assertEqual(self.reads, [])
            with mock.patch.object(auth.SESSIONS, "current", wraps=auth.SESSIONS.current) as current:
                await websocket.result("subscribe", {"topics": ["local-assistants"]})
                # The first sample is no silent baseline: a change made before it, after the page's own read, is
                # announced, so the page reads the value the watcher compares against.
                first = await websocket.next_frame()
                self.assertEqual((first["type"], first["topic"]), ("changed", "local-assistants"))
                frame = await websocket.next_frame()
                self.assertEqual((frame["type"], frame["topic"]), ("changed", "local-assistants"))
                self.assertEqual(frame["revision"], first["revision"] + 1)
                # The value changed once (1 -> 2); later identical reads raise nothing.
                with self.assertRaises(TimeoutError):
                    await websocket.next_frame(0.3)
                self.assertEqual({call.kwargs["activity"] for call in current.call_args_list}, {False})
            await websocket.result("unsubscribe", {"topics": ["local-assistants"]})
            reads = len(self.reads)
            await asyncio.sleep(0.2)
            self.assertEqual(len(self.reads), reads)
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_the_watcher_reads_nothing_without_a_current_subscriber(self) -> None:
        current = mock.AsyncMock(return_value=False)
        handle = self.registry.Handle(
            "s" * 64, "a" * 32, {}, lambda _code: None, {"local-assistants"}.__contains__, current, None, lambda: None
        )

        async def scenario() -> None:
            self.assertTrue(self.registry.REGISTRY.add(handle))
            try:
                self.watcher.refresh()
                await asyncio.sleep(0.2)
            finally:
                self.registry.REGISTRY.remove(handle)
                self.watcher.refresh()
            self.assertTrue(current.await_count)
            self.assertEqual(self.reads, [])

        asyncio.run(scenario())


class SessionSocketWatchedValueTests(SessionSocketCase):
    def test_a_watched_read_compares_only_what_the_page_sees_never_teams_per_request_trace(self) -> None:
        watcher_module = importlib.import_module("session.watcher")
        bridge = self.methods.team_order.bridge
        listed = [{"team_id": "team_1", "team_name": "Marketing", "status": "running"}]
        failed = {"detail": "Team is unavailable"}
        for topic, owner, patched, status, body in (
            ("teams", bridge, "list_teams", 200, {"teams": listed}),
            ("teams", bridge, "list_teams", 503, failed),
            ("local-assistants", self.transport, "call", 200, {"assistants": []}),
            ("local-assistants", self.transport, "call", 503, failed),
        ):
            with self.subTest(topic=topic, status=status):
                answers = [
                    self.transport.TeamResponse(status, {**body, "trace_id": trace}) for trace in ("a" * 32, "b" * 32)
                ]
                with (
                    mock.patch.object(owner, patched, side_effect=answers),
                    mock.patch.object(self.methods.team_order, "load", return_value=None),
                ):
                    first = watcher_module.WATCHED[topic].read()
                    second = watcher_module.WATCHED[topic].read()
                # Two reads of an unchanged value differ only in their trace, so the watcher raises nothing.
                self.assertEqual(first, second)
                self.assertNotIn("a" * 32, json.dumps(first))


class SessionSocketReadParityTests(SessionSocketCase):
    """Each read answers what its HTTP route answered: the same handler, validation, and failures."""

    def test_history_page_keeps_its_route_validation_and_failures(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            page = await websocket.result("history.page", {"team_id": "team_1"})
            self.assertEqual((page["status"], page["body"]), (200, {"entries": [], "before": None}))
            self.assertEqual(page["topic"], "team/team_1/history")
            for params, status in (
                ({"team_id": "Team 1"}, 400),
                ({"team_id": "team_1", "before": "not-a-cursor"}, 400),
                ({"team_id": "team_1", "routine": "NOT"}, 400),
            ):
                with self.subTest(params=params):
                    self.assertEqual((await websocket.result("history.page", params))["status"], status)
            missing = self.transport.TeamResponse(404, {"detail": "Team not found"})
            with mock.patch.object(self.methods.history_http.team, "resolve_team_name", return_value=missing):
                result = await websocket.result("history.page", {"team_id": "team_1"})
            self.assertEqual((result["status"], result["body"]), (404, {"detail": "Team not found"}))
            self.assertNotIn("revision", result)
            unavailable = self.methods.history_http.store.HistoryUnavailableError("down")
            with (
                mock.patch.object(self.methods.history_http.store, "page", side_effect=unavailable),
                self.assertLogs("shimpz-admin", "ERROR"),
            ):
                result = await websocket.result("history.page", {"team_id": "team_1"})
            self.assertEqual((result["status"], result["body"]), (503, {"detail": "Admin chat history is unavailable"}))
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_the_other_reads_answer_as_their_routes_did(self) -> None:
        team_response = self.transport.TeamResponse

        async def scenario() -> None:
            websocket = await self._connect()
            with mock.patch.object(
                self.methods.routines.manage,
                "list_routines",
                return_value=team_response(503, {"detail": "Team is unavailable"}),
            ):
                result = await websocket.result("routines.list", {"team_id": "team_1"})
            self.assertEqual((result["status"], result["body"]), (503, {"detail": "Team is unavailable"}))
            self.assertEqual((await websocket.result("routines.list", {"team_id": "Team 1"}))["status"], 400)
            with mock.patch.object(
                self.methods.platform_release,
                "read_status",
                side_effect=self.methods.platform_release.PlatformReleaseUnavailableError,
            ):
                result = await websocket.result("platform.release", {})
            self.assertEqual(
                (result["status"], result["body"]), (503, {"detail": "Local platform release status is unavailable"})
            )
            summary = await websocket.result("security.summary", {})
            self.assertEqual(summary["status"], 200)
            self.assertEqual(
                set(summary["body"]), {"failed_second_factor_attempts", "recovery_codes_remaining", "sign_in_history"}
            )
            with mock.patch.object(
                self.methods.team_order, "listing", side_effect=self.methods.HTTPException(400, "Team id is invalid")
            ):
                result = await websocket.result("teams.list", {})
            self.assertEqual((result["status"], result["body"]), (400, {"detail": "Team id is invalid"}))
            await websocket.disconnect()

        asyncio.run(scenario())


class StepUpFoundationTests(SessionSocketCase):
    """A step-up ticket issued over a socket keeps every binding it has and also dies with its socket or session."""

    def test_a_socket_bound_ticket_is_spent_only_by_its_own_socket_and_session(self) -> None:
        tickets = importlib.import_module("mfa.tickets")
        store = tickets.TicketStore()
        own = tickets.Binding("s" * 64, "a" * 32)
        for presented in (None, tickets.Binding("s" * 64, "b" * 32), tickets.Binding("t" * 64, "a" * 32)):
            token = store.issue("operation", "http://localhost:7777", 1, "recovery-codes", own)
            with self.subTest(presented=presented), self.assertRaises(tickets.TicketError):
                store.consume(token, "operation", "recovery-codes", presented)
            # A refused presentation spends the ticket all the same.
            with self.assertRaises(tickets.TicketError):
                store.consume(token, "operation", "recovery-codes", own)
        token = store.issue("operation", "http://localhost:7777", 1, "recovery-codes", own)
        with self.assertRaises(tickets.TicketError):
            store.consume(token, "operation", "supervisor-key", own)
        token = store.issue("operation", "http://localhost:7777", 1, "recovery-codes", own)
        ticket = store.consume(token, "operation", "recovery-codes", own)
        self.assertEqual((ticket.origin, ticket.generation, ticket.binding), ("http://localhost:7777", 1, own))
        with self.assertRaises(tickets.TicketError):
            store.consume(token, "operation", "recovery-codes", own)
        token = store.issue("operation", "http://localhost:7777", 1, "recovery-codes", own)
        store.revoke(own)
        with self.assertRaises(tickets.TicketError):
            store.consume(token, "operation", "recovery-codes", own)

    def test_closing_a_socket_revokes_its_tickets_and_ends_its_live_binding(self) -> None:
        context = self.admin_app._LOCAL_AUTH_CONTEXT

        async def scenario() -> None:
            websocket = await self._connect()
            socket = next(listener.__self__ for listener in self.topics._listeners)
            binding = socket.step_up
            token = context.ticket_store.issue("operation", "http://localhost:7777", 1, "recovery-codes", binding)
            self.assertTrue(self.registry.REGISTRY.live(binding))
            await websocket.disconnect()
            self.assertFalse(self.registry.REGISTRY.live(binding))
            with self.assertRaises(importlib.import_module("mfa.tickets").TicketError):
                context.ticket_store.consume(token, "operation", "recovery-codes", binding)

        asyncio.run(scenario())
