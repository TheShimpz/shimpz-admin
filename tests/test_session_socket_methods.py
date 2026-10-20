"""Every Admin operation a session call names keeps exactly the checks its HTTP route had (ADR-0114 tranche (b)).

Each method runs only while the socket's bound Origin and session are current, at receipt and again when its turn
comes on a lane worker; its body keeps the route's own bound; a full lane answers as the route's executor did; no call
renews the session; and Team identity, the Team deletion password, its limiter, and its journal are the route's own.
"""

import asyncio
import importlib
import json
from unittest import mock

from tests.session_socket_case import SessionSocketCase

from tests import chat_socket_fixtures

_Socket = chat_socket_fixtures.Socket
PASSWORD = "violet otter lantern quartz 92"
DIGEST = "sha256:" + "a" * 64
IMAGE = "sha256:" + "c" * 64
CHALLENGE = "a" * 32
PAIR = {"assistant_id": "shimpz-cloudflare", "integration_id": "cloudflare"}
CODE = "c1." + "b" * 43 + "." + "d" * 64
EXTERNAL = "https://developer.example.test"
TRACE = "a" * 32
INFERENCE = {"team_id": "team_1", "provider": "openai", "model": "gpt-6.1-sol", "trace_id": TRACE}
ROUTINE = "c" * 32
RUN = "d" * 32


def _provider_url(callback: str) -> str:
    """Team's strict Cloudflare authorization URL for one callback mode."""
    query = (
        "scope=dns.read+dns.write+offline_access+zone.read&state="
        + "b" * 43
        + "&code_challenge="
        + "c" * 43
        + "&callback="
        + callback
    )
    return "https://shimpz.com/api/oauth/cloudflare/start?" + query


# One valid call of every method that reads or changes Admin's or Team's state.
SAMPLES = {
    "teams.list": {},
    "teams.create": {"body": {"team_name": "Growth"}},
    "teams.rename": {"team_id": "team_1", "body": {"team_name": "Growth"}},
    "teams.reorder": {"body": {"team_ids": ["team_1"]}},
    "teams.delete": {"team_id": "team_1", "body": {"team_name": "Marketing", "password": PASSWORD}},
    "history.page": {"team_id": "team_1"},
    "routines.list": {"team_id": "team_1"},
    "platform.release": {},
    "security.summary": {},
    "inference.read": {"team_id": "team_1"},
    "inference.save": {"team_id": "team_1", "body": {"provider": "openai", "model": "gpt-6.1-sol"}},
    "assistants.registry": {},
    "assistants.list": {"team_id": "team_1"},
    "assistants.install": {"team_id": "team_1", "body": {"assistant_id": "hello-pulse", "source_digest": DIGEST}},
    "assistants.install_local": {"team_id": "team_1", "body": {"image_id": IMAGE}},
    "assistants.uninstall": {"team_id": "team_1", "assistant_id": "hello-pulse"},
    "assistants.summary": {"team_id": "team_1", "assistant_id": "hello-pulse", "locale": "en"},
    "assistants.details": {"team_id": "team_1", "assistant_id": "hello-pulse", "locale": "en"},
    "snapshots.list": {},
    "snapshots.summary": {"image_id": IMAGE, "locale": "en"},
    "snapshots.details": {"image_id": IMAGE, "locale": "en"},
    "models.list": {},
    "models.save": {"provider": "openai", "body": {"api_key": "test-api-key-for-models"}},
    "decision.read": {},
    "decision.save": {"body": {"api_key": "test-api-key-for-models"}},
    "decision.remove": {},
    "chat_limit.read": {},
    "chat_limit.save": {"body": {"limit": 1}},
    "integrations.list": {"team_id": "team_1"},
    "integrations.authorize": {"team_id": "team_1", "challenge_id": CHALLENGE, "body": PAIR},
    "integrations.complete": {"team_id": "team_1", "challenge_id": CHALLENGE, "body": {"completion_code": CODE}},
    "integrations.cancel": {"team_id": "team_1", "challenge_id": CHALLENGE},
    "stored_inputs.list": {"team_id": "team_1"},
    "stored_inputs.clear": {"team_id": "team_1", "assistant_id": "whatsapp", "stored_input_id": "whatsapp-token"},
    "files.acknowledge": {"team_id": "team_1", "file_id": "f" * 32},
    "browser.view": {"team_id": "team_1"},
    "sign_in.start": {"team_id": "team_1", "body": {"url": "https://example.com/", "locale": "en"}},
    "sign_in.save": {"team_id": "team_1", "body": {"sign_in_session_id": "a" * 32, "label": "Work"}},
    "sign_in.cancel": {"team_id": "team_1", "body": {"sign_in_session_id": "a" * 32}},
    "sign_ins.list": {"team_id": "team_1"},
    "sign_ins.forget": {"team_id": "team_1", "body": {"sign_in_id": "b" * 32}},
    "store.catalog": {"locale": "en"},
    "routines.pause": {"team_id": "team_1", "routine_id": ROUTINE},
    "routines.resume": {"team_id": "team_1", "routine_id": ROUTINE},
    "routines.deletion": {"team_id": "team_1", "routine_id": ROUTINE, "body": {"password": PASSWORD}},
    "routines.delete": {"team_id": "team_1", "routine_id": ROUTINE, "body": {"code": "123456"}},
    "routines.plan_steps": {"team_id": "team_1", "routine_id": ROUTINE, "revision": "2", "offset": "0"},
    "routines.run_steps": {"team_id": "team_1", "run_id": RUN, "snapshot": "latest", "offset": "0"},
    "routines.diagnostics": {"team_id": "team_1", "run_id": RUN},
    "routines.card": {"team_id": "team_1", "run_id": ROUTINE},
    "routines.card_answer": {"team_id": "team_1", "run_id": ROUTINE, "body": {"tag": "e" * 64}},
    "routines.challenge": {"team_id": "team_1", "run_id": RUN, "body": {"locale": "en"}},
    "routines.human": {
        "team_id": "team_1",
        "run_id": RUN,
        "body": {"type": "human-response", "challenge_id": CHALLENGE, "decision": "deny"},
    },
    "routines.integrations": {"team_id": "team_1", "run_id": RUN},
    "routines.proposal_confirm": {"team_id": "team_1", "proposal_id": ROUTINE},
    "routines.proposal_revoke": {"team_id": "team_1", "proposal_id": ROUTINE},
    "security.acknowledge": {"body": {"acknowledged": 1}},
    "recovery_codes.confirmation": {"body": {"password": PASSWORD}},
    "recovery_codes.replace": {"body": {"code": "123456"}},
    "supervisor_key.confirmation": {"body": {"password": PASSWORD}},
    "supervisor_key.rotate": {"body": {"code": "123456"}},
}
# What a full lane answers for each method: 429, except the Store catalog's own single-worker executor, which always
# answered 503.
FULL = dict.fromkeys(SAMPLES, 429) | {"store.catalog": 503}


class SessionMethodCase(SessionSocketCase):
    def setUp(self) -> None:
        super().setUp()
        # Every test here opens many sockets for one session.
        opens = mock.patch.object(self.budget, "OPENS", self.budget.SessionBudget(1000))
        opens.start()
        self.addCleanup(opens.stop)
        order = mock.patch.object(self.methods.team_order, "ORDER_PATH", self.root / "team-order.json")
        order.start()
        self.addCleanup(order.stop)
        self.team_calls = []
        call = mock.patch.object(self.transport, "call", side_effect=self._team_call)
        call.start()
        self.addCleanup(call.stop)

    def _team_call(self, method: str, path: str, *_args, **_kwargs):
        self.team_calls.append((method, path))
        return self.transport.TeamResponse(503, {"detail": "Team is unavailable"})

    def _answers(self, method: str, params: dict, **options) -> dict:
        async def scenario() -> dict:
            websocket = await self._connect(**options)
            frame = await websocket.result(method, params)
            await websocket.disconnect()
            return frame

        return asyncio.run(scenario())


class SessionMethodTableTests(SessionMethodCase):
    def test_the_samples_name_every_method_that_reaches_admin_or_team_state(self) -> None:
        local = {"subscribe", "unsubscribe", "chat.attach", "chat.detach"}
        self.assertEqual(set(SAMPLES), set(self.methods.METHODS) - local | set(self.methods.LONG_METHODS))
        self.assertEqual(set(self.methods.METHODS) | set(self.methods.LONG_METHODS), set(self.calls.frames.METHODS))


class SessionMethodAuthorityTests(SessionMethodCase):
    """Origin and session: checked at receipt, and again on the lane worker when the call's turn comes."""

    def test_every_method_closes_a_socket_whose_bound_origin_is_no_longer_admitted_before_it_runs(self) -> None:
        async def scenario() -> None:
            with mock.patch.object(self.lane, "http", side_effect=AssertionError("must not run")):
                for method, params in SAMPLES.items():
                    with self.subTest(method=method):
                        self.assertIn(self.admin_app.state.bind_browser_origin(EXTERNAL), {"learned", "replaced"})
                        websocket = await self._connect(origin=EXTERNAL)
                        self.admin_app.state.bind_browser_origin("https://next.example.test")
                        await websocket.call(method, params)
                        self.assertEqual(await self._closed(websocket), 4403)
                        await websocket.finish()
            self.assertEqual(self.team_calls, [])

        with mock.patch.object(self.admin_app.local_auth, "check_password", side_effect=AssertionError("no check")):
            asyncio.run(scenario())

    def test_every_method_closes_a_socket_whose_session_ended_before_it_runs(self) -> None:
        async def scenario() -> None:
            with mock.patch.object(self.lane, "http", side_effect=AssertionError("must not run")):
                for method, params in SAMPLES.items():
                    with self.subTest(method=method):
                        self.token = self.admin_app.auth.issue_session(
                            self.admin_app.state.get()["session_secret"], "totp"
                        )
                        websocket = await self._connect()
                        await asyncio.to_thread(self.admin_app.state.revoke_sessions_for_logout, self.token)
                        self.assertEqual(await self._closed(websocket), 4401)
                        await websocket.call(method, params)
                        await websocket.finish()
            self.assertEqual(self.team_calls, [])

        asyncio.run(scenario())

    def test_no_method_runs_when_its_socket_is_refused_on_the_lane_worker_whose_turn_came(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            for method, params in SAMPLES.items():
                with self.subTest(method=method):
                    await websocket.call(method, params)
                    with self.assertRaises(TimeoutError):
                        await websocket.next_frame(0.2)
            await websocket.disconnect()

        with (
            mock.patch.object(self.lane, "current", return_value=False),
            mock.patch.object(self.lane, "http", side_effect=AssertionError("must not run")),
            # No password derivation still holds sign-in's one slot when the next method asks for it.
            mock.patch.object(self.admin_app.local_auth, "check_password", new=mock.AsyncMock()),
        ):
            asyncio.run(scenario())
        self.assertEqual(self.team_calls, [])

    def test_no_method_renews_the_session(self) -> None:
        auth = self.admin_app.auth

        async def scenario() -> None:
            websocket = await self._connect()
            for method, params in SAMPLES.items():
                with self.subTest(method=method):
                    await websocket.result(method, params)
            await websocket.disconnect()

        with (
            mock.patch.object(self.lane, "http", return_value=(200, {})),
            mock.patch.object(self.admin_app.local_auth, "recheck_password", new=mock.AsyncMock()),
            mock.patch.object(auth.SESSIONS, "current", wraps=auth.SESSIONS.current) as current,
        ):
            asyncio.run(scenario())
        self.assertTrue(current.call_args_list)
        self.assertEqual({call.kwargs["activity"] for call in current.call_args_list}, {False})

    def test_a_full_lane_answers_every_method_as_its_route_executor_did(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            for method, params in SAMPLES.items():
                with self.subTest(method=method):
                    self.assertEqual((await websocket.result(method, params))["status"], FULL[method])
            await websocket.disconnect()

        with (
            mock.patch.object(self.lane, "submit_in_context", side_effect=self.lane.ExecutorSaturatedError("full")),
            mock.patch.object(self.admin_app.local_auth, "recheck_password", new=mock.AsyncMock()),
        ):
            asyncio.run(scenario())
        self.assertEqual(self.team_calls, [])

    def test_every_body_keeps_its_routes_bound(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            for method, limit in self.calls.frames.BODY_BYTES.items():
                params = SAMPLES[method]
                for size, expected in ((limit, 200), (limit + 1, 413)):
                    with self.subTest(method=method, size=size):
                        body = {"pad": "x" * (size - len('{"pad":""}'))}
                        self.assertEqual(self.calls.frames.body_bytes(body), size)
                        result = await websocket.result(method, {**params, "body": body})
                        self.assertEqual(result["status"], expected)
                        if expected == 413:
                            self.assertEqual(result["body"], {"detail": "request body too large"})
            await websocket.disconnect()

        dispatched = mock.AsyncMock(return_value=(200, {}))
        with mock.patch.object(self.methods, "dispatch", new=dispatched):
            asyncio.run(scenario())
        self.assertEqual(dispatched.await_count, len(self.calls.frames.BODY_BYTES))
        # The bounds the routes had: a Team name 1 KiB, a Team order or deletion 8 KiB, every other body J16.
        self.assertEqual(self.calls.frames.BODY_BYTES["teams.create"], 1024)
        self.assertEqual(self.calls.frames.BODY_BYTES["teams.reorder"], 8 * 1024)
        self.assertEqual(self.calls.frames.BODY_BYTES["models.save"], self.team.transport.MAX_JSON_BODY_BYTES)
        # A confirmation's password and the recovery codes' or signing key's second factor kept the ceremony's 8 KiB, a
        # Routine deletion's second factor J16, and an acknowledgment 1 KiB.
        bounds = self.calls.frames.BODY_BYTES
        for method in (
            "routines.deletion",
            "recovery_codes.confirmation",
            "recovery_codes.replace",
            "supervisor_key.rotate",
        ):
            self.assertEqual(bounds[method], self.admin_app.local_auth.MAX_BODY_BYTES)
        for method in ("routines.delete", "routines.challenge", "routines.card_answer"):
            self.assertEqual(bounds[method], self.team.transport.MAX_JSON_BODY_BYTES)
        # A held run's text answer is as long as a chat answer may be.
        self.assertEqual(bounds["routines.human"], 96 * 1024)
        self.assertEqual(bounds["security.acknowledge"], 1024)

    def test_every_team_method_refuses_an_invalid_team_id_before_team(self) -> None:
        team_methods = {method: params for method, params in SAMPLES.items() if "team_id" in params}

        async def scenario() -> None:
            # From the loopback page, the one an OAuth authorization may start from.
            websocket = await self._connect(origin="http://127.0.0.1:7777")
            for method, params in team_methods.items():
                with self.subTest(method=method):
                    result = await websocket.result(method, {**params, "team_id": "Team 1"})
                    self.assertEqual(result["status"], 400)
            await websocket.disconnect()

        asyncio.run(scenario())
        self.assertEqual(self.team_calls, [])


class SecurityAcknowledgmentTests(SessionMethodCase):
    """Acknowledging refused sign-in attempts keeps its route's validation and answers the summary after it."""

    def test_an_acknowledgment_names_a_positive_count_and_raises_the_summary(self) -> None:
        async def scenario() -> tuple[list[dict], dict, dict]:
            websocket = await self._connect()
            await websocket.result("subscribe", {"topics": ["security/summary"]})
            refused = [
                await websocket.result("security.acknowledge", {"body": body})
                for body in (
                    {},
                    {"acknowledged": 0},
                    {"acknowledged": True},
                    {"acknowledged": "1"},
                    {"acknowledged": 1, "x": 1},
                )
            ]
            await websocket.call("security.acknowledge", {"body": {"acknowledged": 1}})
            frames = [await websocket.next_frame(), await websocket.next_frame()]
            await websocket.disconnect()
            changed, result = sorted(frames, key=lambda frame: frame["type"])
            return refused, changed, result

        refused, changed, result = asyncio.run(scenario())
        detail = {"detail": "request body must contain only a positive acknowledged count"}
        self.assertEqual(
            {(frame["status"], json.dumps(frame["body"])) for frame in refused}, {(400, json.dumps(detail))}
        )
        self.assertEqual((changed["type"], changed["topic"]), ("changed", "security/summary"))
        self.assertEqual((result["status"], result["body"]["failed_second_factor_attempts"]), (200, 0))

    def test_a_session_that_ended_meanwhile_is_signed_out(self) -> None:
        for read in (
            lambda: self.methods.security_summary("v3:not-a-session"),
            lambda: self.methods.acknowledge_failures("v3:not-a-session", {"acknowledged": 1}),
        ):
            with self.assertRaises(self.methods.HTTPException) as refused:
                read()
            self.assertEqual((refused.exception.status_code, refused.exception.detail), (401, "unauthenticated"))


class TeamDeletionTests(SessionMethodCase):
    """A Team deletion confirms the Supervisor password within sign-in's own budget, lockout, and journal."""

    def _journal(self) -> list[dict]:
        path = self.admin_app.audit.path()
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def test_wrong_passwords_spend_the_sign_in_budget_and_are_journaled_with_the_sockets_origin(self) -> None:
        limit = self.admin_app.auth.LOGIN_FAILURE_LIMIT
        wrong = {"team_name": "Marketing", "password": "definitely wrong"}

        async def scenario() -> list[int]:
            websocket = await self._connect()
            statuses = [
                (await websocket.result("teams.delete", {"team_id": "team_1", "body": wrong}))["status"]
                for _ in range(limit)
            ]
            # The lock is sign-in's own: the right password is refused while it lasts.
            right = {"team_name": "Marketing", "password": PASSWORD}
            statuses.append((await websocket.result("teams.delete", {"team_id": "team_1", "body": right}))["status"])
            await websocket.disconnect()
            return statuses

        before = len(self._journal())
        self.assertEqual(asyncio.run(scenario()), [403] * (limit - 1) + [429, 429])
        entries = self._journal()[before:]
        self.assertEqual(
            [entry["event"] for entry in entries], ["password-rejected"] * (limit - 1) + ["password-locked"]
        )
        self.assertEqual({entry["origin"] for entry in entries}, {"http://localhost:7777"})
        self.assertEqual(self.team_calls, [])

    def test_a_malformed_confirmation_is_refused_before_the_password_check(self) -> None:
        for body, detail in (
            ({"team_name": "Marketing"}, "request body must contain only team_name and password"),
            ({"team_name": 1, "password": PASSWORD}, "Team name and password must be strings"),
            ({"team_name": "Marketing", "password": ""}, "Supervisor password is invalid"),
        ):
            with (
                self.subTest(body=body),
                mock.patch.object(self.admin_app.local_auth, "check_password") as verify,
            ):
                result = self._answers("teams.delete", {"team_id": "team_1", "body": body})
            self.assertEqual((result["status"], result["body"]), (400, {"detail": detail}))
            verify.assert_not_called()

    def test_the_right_password_lets_team_confirm_the_name_and_raises_the_team_list(self) -> None:
        destroyed = self.transport.TeamResponse(200, {"team_id": "team_1", "destroyed": True})

        async def scenario() -> tuple[dict, dict]:
            websocket = await self._connect()
            await websocket.result("subscribe", {"topics": ["teams"]})
            await websocket.call(
                "teams.delete", {"team_id": "team_1", "body": {"team_name": "Marketing", "password": PASSWORD}}
            )
            frames = [await websocket.next_frame(), await websocket.next_frame()]
            await websocket.disconnect()
            return tuple(sorted(frames, key=lambda frame: frame["type"]))

        with mock.patch.object(self.team, "destroy_confirmed", return_value=destroyed) as confirmed:
            changed, result = asyncio.run(scenario())
        confirmed.assert_called_once_with("team_1", "Marketing")
        self.assertEqual((result["status"], changed["topic"]), (200, "teams"))


class SessionMethodTopicTests(SessionMethodCase):
    """Admin raises the topics its own changes made, for the sockets that show them, and only on success."""

    async def _changed_by(self, method: str, params: dict, topics: list[str]) -> tuple[dict, set[str]]:
        websocket = await self._connect()
        await websocket.result("subscribe", {"topics": topics})
        await websocket.call(method, params)
        raised, result = set(), None
        while result is None:
            frame = await websocket.next_frame()
            if frame["type"] == "changed":
                raised.add(frame["topic"])
            elif frame["type"] == "result":
                result = frame
        # A change raised after the result still arrives before anything else the socket sends.
        while True:
            try:
                frame = await websocket.next_frame(0.2)
            except TimeoutError:
                break
            raised.add(frame["topic"])
        await websocket.disconnect()
        return result, raised

    def test_each_change_raises_exactly_its_topics(self) -> None:
        topics = ["teams", "team/team_1/inventory", "team/team_1/inference", "assistants/registry"]
        installed = self.transport.TeamResponse(200, {"assistant": "hello-pulse", "installed": True})
        for method, answer, expected in (
            ("teams.rename", {"team_id": "team_1", "team_name": "Growth"}, {"teams"}),
            (
                "teams.reorder",
                {"teams": [{"team_id": "team_1", "team_name": "Marketing", "status": "running"}]},
                {"teams"},
            ),
            ("assistants.install", installed.body, {"team/team_1/inventory", "assistants/registry"}),
            ("assistants.install_local", None, {"team/team_1/inventory", "assistants/registry"}),
            (
                "assistants.uninstall",
                {"assistant": "hello-pulse", "uninstalled": True},
                {"team/team_1/inventory", "assistants/registry"},
            ),
            ("inference.save", INFERENCE, {"team/team_1/inference"}),
        ):
            body = (
                answer
                if answer is not None
                else {
                    "assistant": "hello-pulse",
                    "image_id": IMAGE,
                    "installed": True,
                    "provenance": "local",
                    "unpublished": True,
                }
            )
            ok = self.transport.TeamResponse(200, body)
            with self.subTest(method=method), mock.patch.object(self.transport, "call", return_value=ok):
                if method == "teams.reorder":
                    with mock.patch.object(self.team, "list_teams", return_value=ok):
                        result, raised = asyncio.run(self._changed_by(method, SAMPLES[method], topics))
                else:
                    result, raised = asyncio.run(self._changed_by(method, SAMPLES[method], topics))
                self.assertEqual((result["status"], raised), (200, expected))
            # A refused change raises nothing.
            with self.subTest(method=method, refused=True):
                result, raised = asyncio.run(self._changed_by(method, SAMPLES[method], topics))
                self.assertNotEqual(result["status"], 200)
                self.assertEqual(raised, set())

    def test_the_space_chat_limit_is_teams_and_only_a_committed_save_raises_its_topic(self) -> None:
        trace = {"trace_id": "a" * 32}
        answers = {"GET": (200, {"limit": 2, **trace}), "PUT": (200, {"limit": 1, **trace})}

        def team(method: str, path: str, *_args, **_kwargs):
            self.assertEqual(path, "/v1/chat/limit")
            return self.transport.TeamResponse(*answers[method])

        topics = ["space/chat-limit"]
        with mock.patch.object(self.transport, "call", side_effect=team):
            read, raised = asyncio.run(self._changed_by("chat_limit.read", {}, topics))
            self.assertEqual(
                (read["status"], read["body"], read["topic"], raised), (200, {"limit": 2}, topics[0], set())
            )
            saved, raised = asyncio.run(self._changed_by("chat_limit.save", SAMPLES["chat_limit.save"], topics))
            self.assertEqual((saved["status"], saved["body"], raised), (200, {"limit": 1}, set(topics)))
            # A limit Admin refuses never reaches Team, and an answer Team should not give is unavailable.
            refused, raised = asyncio.run(self._changed_by("chat_limit.save", {"body": {"limit": 3}}, topics))
            self.assertEqual((refused["status"], raised), (400, set()))
            # Team's answer carries its trace identifier; a limit out of range or an answer without it is refused.
            for answer in ({"limit": 9, **trace}, {"limit": 1}, {"limit": 1, "trace_id": "not-a-trace"}):
                answers["PUT"] = (200, answer)
                invalid, raised = asyncio.run(self._changed_by("chat_limit.save", SAMPLES["chat_limit.save"], topics))
                self.assertEqual((invalid["status"], raised), (502, set()), answer)
            # Team's own refusal reaches the page as it is.
            answers["GET"] = (503, {"detail": "Team is unavailable"})
            down, raised = asyncio.run(self._changed_by("chat_limit.read", {}, topics))
            self.assertEqual((down["status"], raised), (503, set()))

    def test_every_key_save_and_decision_removal_raises_its_space_topic_when_it_completes(self) -> None:
        models = self.methods.models
        for method, topic in (
            ("models.save", "space/models"),
            ("decision.save", "space/decision"),
            ("decision.remove", "space/decision"),
        ):
            params = SAMPLES[method]
            with (
                self.subTest(method=method),
                mock.patch.object(models, "probe_status", return_value=200),
                mock.patch.object(models, "_validate_api_key"),
            ):
                result, raised = asyncio.run(self._changed_by(method, params, ["space/models", "space/decision"]))
            self.assertEqual((result["status"], raised), (200, {topic}))
        # Removing a key that is already gone changes nothing, so it raises nothing.
        result, raised = asyncio.run(
            self._changed_by("decision.remove", SAMPLES["decision.remove"], ["space/models", "space/decision"])
        )
        self.assertEqual((result["status"], raised), (200, set()))

    def test_a_key_save_that_completes_after_its_socket_dropped_tells_the_reopened_socket(self) -> None:
        import threading

        started = threading.Event()
        release = threading.Event()
        real = self.methods.models.configure

        def slow(provider, api_key):
            started.set()
            release.wait(5)
            return real(provider, api_key)

        async def scenario() -> dict:
            first = await self._connect()
            await first.call("models.save", SAMPLES["models.save"])
            await chat_socket_fixtures.wait_for_thread(started)
            await first.disconnect()
            # The page reopens and reads the providers while the save still runs on its lane worker.
            reopened = await self._connect()
            await reopened.result("subscribe", {"topics": ["space/models"]})
            before = await reopened.result("models.list", {})
            release.set()
            changed = await reopened.next_frame()
            after = await reopened.result("models.list", {})
            await reopened.disconnect()
            return {"before": before, "changed": changed, "after": after}

        with (
            mock.patch.object(self.methods.models, "configure", side_effect=slow),
            mock.patch.object(self.methods.models, "_validate_api_key"),
        ):
            frames = asyncio.run(scenario())
        configured = {entry["id"]: entry["configured"] for entry in frames["after"]["body"]["providers"]}
        self.assertFalse(
            {entry["id"]: entry["configured"] for entry in frames["before"]["body"]["providers"]}["openai"]
        )
        self.assertEqual((frames["changed"]["type"], frames["changed"]["topic"]), ("changed", "space/models"))
        self.assertTrue(configured["openai"])
        self.assertEqual(frames["after"]["topic"], "space/models")

    def test_a_stored_input_clear_raises_the_teams_integrations(self) -> None:
        topics = ["team/team_1/integrations"]
        cleared = {
            "team_id": "team_1",
            "assistant_id": "whatsapp",
            "stored_input_id": "whatsapp-token",
            "cleared": True,
            "trace_id": TRACE,
        }
        sample = SAMPLES["stored_inputs.clear"]
        answered = self.transport.TeamResponse(200, cleared)
        with mock.patch.object(self.methods.integrations.transport, "call", return_value=answered):
            result, raised = asyncio.run(self._changed_by("stored_inputs.clear", sample, topics))
        self.assertEqual((result["status"], raised), (200, set(topics)))
        # A refused change raises nothing.
        result, raised = asyncio.run(self._changed_by("stored_inputs.clear", sample, topics))
        self.assertEqual(raised, set())

    def test_a_completed_authorization_and_a_human_answer_raise_the_teams_integrations(self) -> None:
        integrations = self.methods.integrations
        connected = {
            "connected": True,
            "team_id": "team_1",
            "assistant_id": "shimpz-cloudflare",
            "integration_id": "cloudflare",
            "trace_id": TRACE,
        }
        heard = []
        with (
            mock.patch.object(self.topics, "team_changed", side_effect=lambda *args: heard.append(args)),
            mock.patch.object(integrations.transport, "call", return_value=self.transport.TeamResponse(200, connected)),
        ):
            integrations.complete_cloudflare_oauth_callback(state="b" * 43, claim="a" * 64, session_binding="c" * 43)
        with (
            mock.patch.object(self.topics, "team_changed", side_effect=lambda *args: heard.append(args)),
            mock.patch.object(self.transport, "call_stream", return_value=self.transport.TeamResponse(200, {})),
        ):
            self.team.resume_chat_human(
                "team_1",
                {"challenge_id": "a" * 32, "decision": "deny"},
                provider="openai",
                api_key="test-api-key-for-models",
                progress=lambda _event: None,
            )
        # An answer that sealed its Input and paused again for the next request changed state too.
        with (
            mock.patch.object(self.topics, "team_changed", side_effect=lambda *args: heard.append(args)),
            mock.patch.object(self.transport, "call_stream", return_value=self.transport.TeamResponse(428, {})),
        ):
            self.team.resume_chat_human(
                "team_1",
                {"challenge_id": "a" * 32, "decision": "deny"},
                provider="openai",
                api_key="test-api-key-for-models",
                progress=lambda _event: None,
            )
        # A refused answer changed nothing.
        with (
            mock.patch.object(self.topics, "team_changed", side_effect=lambda *args: heard.append(args)),
            mock.patch.object(self.transport, "call_stream", return_value=self.transport.TeamResponse(409, {})),
        ):
            self.team.resume_chat_human(
                "team_1",
                {"challenge_id": "a" * 32, "decision": "deny"},
                provider="openai",
                api_key="test-api-key-for-models",
                progress=lambda _event: None,
            )
        self.assertEqual(heard, [("team_1", "integrations")] * 3)

    def test_a_created_team_raises_the_team_list(self) -> None:
        created = self.transport.TeamResponse(
            200, {"team_id": "growth", "team_name": "Growth", "status": "running", "created": True}
        )
        with mock.patch.object(self.team, "create", return_value=created):
            result, raised = asyncio.run(self._changed_by("teams.create", SAMPLES["teams.create"], ["teams"]))
        self.assertEqual((result["status"], raised), (200, {"teams"}))

    def test_a_read_carries_the_revision_of_its_new_topic(self) -> None:
        for method, topic in (
            ("assistants.list", "team/team_1/inventory"),
            ("inference.read", "team/team_1/inference"),
            ("assistants.registry", "assistants/registry"),
            ("snapshots.list", "local-assistants"),
        ):
            revision = self.topics.changed(topic)
            ok = self.transport.TeamResponse(200, {"assistants": []} if "inference" not in method else INFERENCE)
            with self.subTest(method=method), mock.patch.object(self.transport, "call", return_value=ok):
                result = self._answers(method, SAMPLES[method])
            self.assertEqual((result.get("topic"), result.get("revision")), (topic, revision))


class SessionMethodAnswerTests(SessionMethodCase):
    """Answers the routes gave, as call results: an install's progress, empty answers, and Team's own failures."""

    def test_an_install_says_once_that_it_started_and_then_answers_teams_result(self) -> None:
        installed = self.transport.TeamResponse(200, {"assistant": "hello-pulse", "installed": True})

        async def scenario() -> list[dict]:
            websocket = await self._connect()
            call_id = await websocket.call("assistants.install", SAMPLES["assistants.install"])
            frames = [await websocket.next_frame(), await websocket.next_frame()]
            await websocket.disconnect()
            self.assertEqual(frames[0], {"type": "progress", "id": call_id, "state": "running"})
            return frames

        with mock.patch.object(self.transport, "call", return_value=installed) as call:
            frames = asyncio.run(scenario())
        self.assertEqual((frames[1]["status"], frames[1]["body"]), (200, installed.body))
        self.assertEqual(
            call.call_args.args[:3], ("POST", "/v1/teams/team_1/assistants", SAMPLES["assistants.install"]["body"])
        )

    def test_an_empty_answer_is_an_empty_object(self) -> None:
        cancelled = self._answers("integrations.cancel", SAMPLES["integrations.cancel"])
        self.assertEqual((cancelled["status"], cancelled["body"]), (204, {}))

    def test_team_answers_and_admins_own_refusals_pass_through(self) -> None:
        cleared = self.transport.TeamResponse(200, {"cleared": True})
        stored_input = self.methods.stored_input
        with mock.patch.object(stored_input, "clear_assistant_stored_input", return_value=cleared) as clear:
            result = self._answers("stored_inputs.clear", SAMPLES["stored_inputs.clear"])
        clear.assert_called_once_with("team_1", "whatsapp", "whatsapp-token")
        self.assertEqual((result["status"], result["body"]), (200, {"cleared": True}))
        acknowledged = self.transport.TeamResponse(200, {"file_id": "f" * 32, "acknowledged": True})
        with mock.patch.object(self.methods.team, "acknowledge_file", return_value=acknowledged) as acknowledge:
            result = self._answers("files.acknowledge", SAMPLES["files.acknowledge"])
        acknowledge.assert_called_once_with("team_1", "f" * 32)
        self.assertEqual((result["status"], result["body"]), (200, acknowledged.body))
        opened = self.transport.TeamResponse(200, {"view_id": "a" * 32})
        with mock.patch.object(self.methods.team, "open_browser_view", return_value=opened) as open_view:
            result = self._answers("browser.view", SAMPLES["browser.view"])
        open_view.assert_called_once_with("team_1")
        self.assertEqual((result["status"], result["body"]), (200, opened.body))
        # A sign-in session's Save or Cancel that Team answered, or that finds it no longer running, is finished.
        for method, answer in (
            ("sign_in.cancel", self.transport.TeamResponse(200, {"cancelled": True})),
            ("sign_in.save", self.transport.TeamResponse(404, {"detail": "x", "code": "sign-in-not-running"})),
            ("sign_in.save", self.transport.TeamResponse(409, {"detail": "x", "code": "sign-in-windows"})),
        ):
            operation = method.split(".")[1]
            with (
                self.subTest(method=method),
                mock.patch.object(self.methods.team_sign_ins, operation, return_value=answer),
                mock.patch.object(self.methods.team_sign_ins, "finished") as finished,
            ):
                result = self._answers(method, SAMPLES[method])
                self.assertEqual(result["status"], answer.status)
                # A session a refusal leaves running is still its authority's to cancel.
                if answer.status == 409:
                    finished.assert_not_called()
                else:
                    finished.assert_called_once_with("team_1", "a" * 32)
        result = self._answers("stored_inputs.clear", {**SAMPLES["stored_inputs.clear"], "stored_input_id": "Bad"})
        self.assertEqual(result["status"], 400)
        result = self._answers("assistants.summary", {**SAMPLES["assistants.summary"], "locale": "it"})
        self.assertEqual((result["status"], result["body"]), (422, {"detail": "Assistant summary locale is invalid"}))
        with mock.patch.object(self.methods.chat_assets.store_catalog.CATALOG, "get", return_value=()):
            result = self._answers("store.catalog", {"locale": "en", "cursor": "not-a-cursor"})
        self.assertEqual((result["status"], result["body"]), (400, {"detail": "Assistant catalog cursor is invalid"}))
        with mock.patch.object(self.methods.decision, "status", return_value={"configured": False}):
            self.assertEqual(self._answers("decision.read", {})["body"], {"configured": False})


class IntegrationAuthorizationTests(SessionMethodCase):
    """The callback mode follows the Origin the socket is bound to, exactly as it followed the request's Origin."""

    def setUp(self) -> None:
        super().setUp()
        self.authorization = importlib.import_module("integrations.authorization")
        handoffs = mock.patch.object(
            self.authorization, "HANDOFFS", self.authorization.handoff_store.OAuthHandoffStore(ttl_seconds=30)
        )
        handoffs.start()
        self.addCleanup(handoffs.stop)

    def _authorized(self, origin: str, provider_url: str) -> dict:
        provider = self.transport.TeamResponse(200, {"authorization_url": provider_url})
        with mock.patch.object(
            self.authorization.integrations, "start_local_assistant_integration_authorization", return_value=provider
        ) as start:
            result = self._answers("integrations.authorize", SAMPLES["integrations.authorize"], origin=origin)
        if result["status"] == 200:
            self.assertEqual(start.call_args.args[:4], ("team_1", CHALLENGE, "shimpz-cloudflare", "cloudflare"))
        return result

    def test_a_loopback_page_completes_automatically_through_admins_own_start_route(self) -> None:
        result = self._authorized("http://127.0.0.1:7777", _provider_url("loopback"))
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"]["completion_mode"], "automatic")
        self.assertRegex(
            result["body"]["authorization_url"],
            r"^http://127\.0\.0\.1:7777/api/oauth/cloudflare/start\?handoff=[0-9a-f]{64}$",
        )

    def test_a_learned_https_page_completes_out_of_band_and_another_admitted_page_cannot_start(self) -> None:
        self.assertEqual(self.admin_app.state.bind_browser_origin(EXTERNAL), "learned")
        url = _provider_url("out-of-band")
        result = self._authorized(EXTERNAL, url)
        self.assertEqual(
            (result["status"], result["body"]), (200, {"authorization_url": url, "completion_mode": "code"})
        )
        # localhost is an admitted page, but no OAuth callback returns to it.
        self.assertEqual(self._authorized("http://localhost:7777", url)["status"], 409)
