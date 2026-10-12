"""The Supervisor's two-step operations over the session socket keep every binding their routes had (ADR-0114).

Deleting a Routine, replacing the recovery codes, and rotating the Supervisor key each start with the Supervisor
password, within sign-in's own limiter, lockout, and journal, and complete with one second factor. The one-use ticket
keeps its purpose, its exact operation and Team or Routine subject, its Origin, the factor generation, its 180-second
expiry, and single consumption, and is bound to the socket and its session as well: the socket keeps it, and it dies
with either. The session, the socket, and its Origin are checked again after the factor and immediately before the
operation reaches Team or Admin's state.
"""

import asyncio
import contextlib
import hashlib
import json
import threading
from unittest import mock

from tests.mfa_helper import NOW, code, recovery_codes
from tests.session_socket_case import SessionSocketCase

from tests import chat_socket_fixtures

PASSWORD = "violet otter lantern quartz 92"
WRONG = "not the supervisor passphrase"
ORIGIN = "http://localhost:7777"
TEAM = "team_1"
ROUTINE = "c" * 32
OTHER = "d" * 32
DELETED = {"team_id": TEAM, "routine_id": ROUTINE, "deleted": True}


def _deletion(routine: str = ROUTINE, password: str = PASSWORD) -> tuple[str, dict]:
    return "routines.deletion", {"team_id": TEAM, "routine_id": routine, "body": {"password": password}}


def _delete(proof: dict, routine: str = ROUTINE) -> tuple[str, dict]:
    return "routines.delete", {"team_id": TEAM, "routine_id": routine, "body": proof}


class StepUpCase(SessionSocketCase):
    def setUp(self) -> None:
        super().setUp()
        self.state = self.admin_app.state
        self.local_auth = self.admin_app.local_auth
        self.tickets = __import__("mfa.tickets", fromlist=["tickets"])
        self.totp = __import__("mfa.totp", fromlist=["totp"])
        self.passkeys = __import__("mfa.passkeys", fromlist=["passkeys"])
        self.stepup = __import__("session.stepup", fromlist=["stepup"])
        self.manage = __import__("routine.manage", fromlist=["manage"])
        # Every test begins with a fresh sign-in limiter and ticket store, which the socket's gate takes as it opens.
        self.now = [0.0]
        self.context = self.local_auth.Context(ticket_store=self.tickets.TicketStore(clock=lambda: self.now[0]))
        self.admin_app.audit.path().unlink(missing_ok=True)
        context = mock.patch.object(self.admin_app, "_LOCAL_AUTH_CONTEXT", self.context)
        context.start()
        self.addCleanup(context.stop)
        opens = mock.patch.object(self.budget, "OPENS", self.budget.SessionBudget(1000))
        opens.start()
        self.addCleanup(opens.stop)
        # Admin's TOTP clock stands past the fixture's enrollment; each code takes the next step.
        self.clock = [NOW + 60]
        clock = mock.patch.object(
            self.totp, "_timestamp", side_effect=lambda now: self.clock[0] if now is None else now
        )
        clock.start()
        self.addCleanup(clock.stop)
        self.team_delete = mock.patch.object(
            self.manage, "delete", return_value=self.team.TeamResponse(200, DELETED)
        ).start()
        self.addCleanup(mock.patch.stopall)

    def code(self) -> str:
        self.clock[0] += self.totp.PERIOD_SECONDS
        return code(str(self.state.get()["totp"]["secret"]), self.clock[0])

    def wrong(self) -> str:
        current = code(str(self.state.get()["totp"]["secret"]), self.clock[0])
        return f"{(int(current) + 1) % 1_000_000:06d}"

    def run_calls(self, *calls: tuple[str, dict], **options) -> list[dict]:
        """Answer each call in order on one socket, returning every result."""

        async def scenario() -> list[dict]:
            websocket = await self._connect(**options)
            results = [await websocket.result(method, params) for method, params in calls]
            await websocket.disconnect()
            return results

        return asyncio.run(scenario())

    @staticmethod
    def answer(result: dict) -> tuple[int, dict]:
        return result["status"], result["body"]

    def journal(self) -> list[dict]:
        path = self.admin_app.audit.path()
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []


class RoutineDeletionTests(StepUpCase):
    def test_password_and_code_bound_to_this_routine_delete_it_once(self) -> None:
        first = self.code()
        with self.assertLogs("shimpz-admin", level="INFO") as captured:
            offer, deleted, replayed = self.run_calls(
                _deletion(), _delete({"code": first}), _delete({"code": self.code()})
            )
        self.assertEqual(self.answer(offer), (202, {"methods": ["totp"]}))
        self.assertEqual(self.answer(deleted), (200, DELETED))
        # The ticket is spent: the same proof never deletes again, even with a fresh code.
        self.assertEqual(self.answer(replayed), (401, {"code": "authentication-expired"}))
        self.team_delete.assert_called_once_with(TEAM, ROUTINE)
        logged = " ".join(captured.output)
        self.assertNotIn(PASSWORD, logged)
        self.assertNotIn(first, logged)
        # The page never held the ticket: neither the offer nor any result carries it.
        self.assertEqual(self.context.ticket_store._records, {})
        events = [(entry["event"], entry["origin"]) for entry in self.journal()]
        self.assertIn(("operation-confirmed", ORIGIN), events)

    def test_a_ticket_for_one_operation_never_completes_another_and_is_spent(self) -> None:
        results = self.run_calls(
            _deletion(ROUTINE),
            _delete({"code": self.code()}, OTHER),
            _delete({"code": self.code()}, ROUTINE),
            ("supervisor_key.confirmation", {"body": {"password": PASSWORD}}),
            ("recovery_codes.replace", {"body": {"code": self.code()}}),
            _delete({"code": self.code()}, ROUTINE),
        )
        self.assertEqual([result["status"] for result in results], [202, 401, 401, 202, 401, 401])
        self.assertEqual(results[1]["body"], {"code": "authentication-expired"})
        self.team_delete.assert_not_called()

    def test_a_confirmation_begun_again_replaces_the_one_before_it(self) -> None:
        offer = {"challenge": "x"}

        async def scenario() -> tuple[list[int], int, int]:
            websocket = await self._connect()
            statuses = [(await websocket.result(*_deletion(routine)))["status"] for routine in (OTHER, ROUTINE)]
            pending = (len(self.context.ticket_store._records), len(self.context.challenge_store._records))
            await websocket.disconnect()
            return statuses, *pending

        with (
            mock.patch.object(self.local_auth, "passkey_registered", return_value=True),
            mock.patch.object(self.state, "active_passkeys", return_value=[{"credential_id": "credential"}]),
            mock.patch.object(self.passkeys, "authentication_options", return_value=offer),
        ):
            statuses, tickets, challenges = asyncio.run(scenario())
        self.assertEqual(statuses, [202, 202])
        # The first ticket and its passkey challenge are spent; only the second is pending, until the socket closes.
        self.assertEqual((tickets, challenges), (1, 1))
        self.assertEqual((self.context.ticket_store._records, self.context.challenge_store._records), ({}, {}))

    def test_a_ticket_belongs_to_its_socket_and_dies_with_it(self) -> None:
        async def scenario() -> tuple[dict, dict, dict, int]:
            first = await self._connect()
            second = await self._connect()
            offered = await first.result(*_deletion())
            elsewhere = await second.result(*_delete({"code": self.code()}))
            pending = len(self.context.ticket_store._records)
            await first.disconnect()
            again = await second.result(*_delete({"code": self.code()}))
            await second.disconnect()
            return offered, elsewhere, again, pending

        offered, elsewhere, again, pending = asyncio.run(scenario())
        self.assertEqual(offered["status"], 202)
        self.assertEqual(self.answer(elsewhere), (401, {"code": "authentication-expired"}))
        self.assertEqual(self.answer(again), (401, {"code": "authentication-expired"}))
        # Another socket's attempt never touched the ticket; the closed socket's close revoked it.
        self.assertEqual(pending, 1)
        self.assertEqual(self.context.ticket_store._records, {})
        self.team_delete.assert_not_called()

    def test_a_ticket_presented_for_another_socket_or_session_is_refused_and_spent(self) -> None:
        store = self.context.ticket_store
        own = self.tickets.Binding("s" * 64, "a" * 32)
        subject = self.manage.deletion_subject(TEAM, ROUTINE)
        for presented in (None, self.tickets.Binding("s" * 64, "b" * 32), self.tickets.Binding("t" * 64, "a" * 32)):
            with self.subTest(presented=presented):
                token = store.issue("operation", ORIGIN, self.state.factor_generation(), subject, own)
                with self.assertRaises(self.tickets.TicketError):
                    store.consume(token, "operation", subject, presented)
                with self.assertRaises(self.tickets.TicketError):
                    store.consume(token, "operation", subject, own)

    def test_a_ticket_expires_after_its_180_seconds(self) -> None:
        async def scenario() -> list[dict]:
            websocket = await self._connect()
            results = [await websocket.result(*_deletion())]
            self.now[0] += self.tickets.TICKET_TTL_SECONDS
            results.append(await websocket.result(*_delete({"code": self.code()})))
            results.append(await websocket.result(*_deletion()))
            self.now[0] += self.tickets.TICKET_TTL_SECONDS - 1
            results.append(await websocket.result(*_delete({"code": self.code()})))
            await websocket.disconnect()
            return results

        results = asyncio.run(scenario())
        self.assertEqual([result["status"] for result in results], [202, 401, 202, 200])
        self.team_delete.assert_called_once_with(TEAM, ROUTINE)

    def test_no_ticket_or_a_wrong_code_never_reaches_team_and_a_wrong_code_spends_the_ticket(self) -> None:
        results = self.run_calls(
            _delete({"code": self.code()}), _deletion(), _delete({"code": self.wrong()}), _delete({"code": self.code()})
        )
        self.assertEqual(
            [self.answer(result) for result in results],
            [
                (401, {"code": "authentication-expired"}),
                (202, {"methods": ["totp"]}),
                (401, {"code": "code-incorrect"}),
                (401, {"code": "authentication-expired"}),
            ],
        )
        self.team_delete.assert_not_called()

    def test_wrong_passwords_share_the_sign_in_lockout_and_journal_with_the_sockets_origin(self) -> None:
        limit = self.admin_app.auth.LOGIN_FAILURE_LIMIT
        wrong = [_deletion(ROUTINE, WRONG)] * limit
        results = self.run_calls(*wrong, _deletion())
        self.assertEqual([result["status"] for result in results], [401] * (limit - 1) + [429, 429])
        self.assertEqual(results[0]["body"], {"code": "password-incorrect"})
        self.assertEqual(
            results[-1]["body"],
            {"code": "authentication-locked", "retry_after": self.admin_app.auth.LOGIN_LOCK_SECONDS},
        )
        entries = self.journal()
        self.assertEqual(
            [entry["event"] for entry in entries], ["password-rejected"] * (limit - 1) + ["password-locked"]
        )
        self.assertEqual({entry["origin"] for entry in entries}, {ORIGIN})
        # Sign-in shares the one budget: the right password is locked there too.
        with self.assertRaises(self.admin_app.HTTPException) as locked:
            asyncio.run(self.local_auth._verify_password(PASSWORD, self.context))
        self.assertEqual(locked.exception.status_code, 429)
        self.assertEqual(self.context.ticket_store._records, {})
        self.team_delete.assert_not_called()

    def test_wrong_codes_share_the_durable_totp_lockout(self) -> None:
        calls = []
        for _attempt in range(self.totp.FAILURE_LIMIT - 1):
            calls += [_deletion(), _delete({"code": self.wrong()})]
        calls += [_deletion(), _delete({"code": self.wrong()}), _deletion(), _delete({"code": self.code()})]
        results = self.run_calls(*calls)
        completions = [self.answer(result) for result in results[1::2]]
        self.assertEqual(completions[: self.totp.FAILURE_LIMIT - 1], [(401, {"code": "code-incorrect"})] * 4)
        self.assertEqual(completions[-2:], [(429, {"code": "code-locked"})] * 2)
        self.team_delete.assert_not_called()

    def test_changed_factors_or_a_revoked_session_stop_the_deletion(self) -> None:
        def bump() -> None:
            data = self.state.get()
            self.state._write({**data, "factor_generation": int(data["factor_generation"]) + 1})

        async def changed_factors() -> dict:
            websocket = await self._connect()
            await websocket.result(*_deletion())
            await asyncio.to_thread(bump)
            result = await websocket.result(*_delete({"code": self.code()}))
            await websocket.disconnect()
            return result

        self.assertEqual(self.answer(asyncio.run(changed_factors())), (401, {"code": "authentication-expired"}))

        verify = self.state.verify_totp

        def accept_then_log_out(*args, **kwargs):
            result = verify(*args, **kwargs)
            self.state.revoke_sessions_for_logout(self.token)
            return result

        async def logged_out() -> int:
            websocket = await self._connect()
            await websocket.result(*_deletion())
            with mock.patch.object(self.state, "verify_totp", side_effect=accept_then_log_out):
                await websocket.call(*_delete({"code": self.code()}))
                return await self._closed(websocket)

        # The session that asked ends while the factor is checked: Team is never asked, and the socket closes.
        self.assertEqual(asyncio.run(logged_out()), 4401)
        self.team_delete.assert_not_called()

    def test_a_socket_that_closes_while_the_factor_is_checked_never_reaches_team(self) -> None:
        verify = self.state.verify_totp

        def accept_then_close(*args, **kwargs):
            result = verify(*args, **kwargs)
            for handle in self.registry.REGISTRY.handles():
                handle.end(1000)
            return result

        real = self.stepup._current
        checks = []
        checked = threading.Event()

        def current(socket) -> bool:
            checks.append(real(socket))
            checked.set()
            return checks[-1]

        async def scenario() -> None:
            websocket = await self._connect()
            await websocket.result(*_deletion())
            with (
                mock.patch.object(self.state, "verify_totp", side_effect=accept_then_close),
                mock.patch.object(self.stepup, "_current", side_effect=current),
            ):
                await websocket.call(*_delete({"code": self.code()}))
                await self._closed(websocket)
                await chat_socket_fixtures.wait_for_thread(checked)
            await websocket.finish()

        asyncio.run(scenario())
        # The check right before dispatch found the socket closed, so Team was never asked.
        self.assertEqual(checks, [False])
        self.team_delete.assert_not_called()

    def test_a_ticket_issued_as_its_socket_closes_is_revoked(self) -> None:
        offer = self.local_auth.offer_operation

        def offer_while_closing(asker, context, subject):
            for handle in self.registry.REGISTRY.handles():
                self.registry.REGISTRY.remove(handle)
            context.ticket_store.revoke(asker.binding)
            return offer(asker, context, subject)

        with (
            mock.patch.object(self.local_auth, "offer_operation", side_effect=offer_while_closing),
            mock.patch.object(self.local_auth, "passkey_registered", return_value=True),
            mock.patch.object(self.state, "active_passkeys", return_value=[{"credential_id": "credential"}]),
            mock.patch.object(self.passkeys, "authentication_options", return_value={"challenge": "x"}),
        ):
            self.assertEqual(self.run_calls(_deletion())[0]["status"], 202)
        # Neither the ticket nor its passkey challenge outlives the socket.
        self.assertEqual((self.context.ticket_store._records, self.context.challenge_store._records), ({}, {}))

    def test_an_origin_admin_does_not_admit_is_refused_before_the_password(self) -> None:
        binding = self.tickets.Binding("s" * 64, "a" * 32)
        for origin in (None, "https://admin.example", "http://evil.example"):
            asker = self.local_auth.Asker(origin, "session", binding)
            with self.subTest(origin=origin), mock.patch.object(self.local_auth, "_verify_password") as verify:
                with self.assertRaises(self.local_auth.OperationRefusedError) as refused:
                    asyncio.run(self.local_auth.verify_operation_password(asker, self.context, PASSWORD))
                self.assertEqual(
                    (refused.exception.status, refused.exception.code), (403, "authentication-origin-refused")
                )
                verify.assert_not_called()
                with self.assertRaises(self.local_auth.OperationRefusedError):
                    self.local_auth.offer_operation(asker, self.context, "recovery-codes")
                confirmation = self.local_auth.Confirmation("t" * 43, "totp", "123456")
                with self.assertRaises(self.local_auth.OperationRefusedError):
                    self.local_auth.confirm_operation(
                        asker, self.context, "recovery-codes", confirmation, lambda: True, self.fail
                    )
        self.assertEqual(self.state.browser_origin(), None)

    def test_authentication_state_failures_are_unavailable_at_every_step(self) -> None:
        def unreadable(*_args, **_kwargs):
            raise OSError("unreadable store")

        unavailable = (503, {"code": "authentication-unavailable"})
        with (
            mock.patch.object(self.local_auth, "passkey_registered", return_value=True),
            mock.patch.object(self.state, "active_passkeys", side_effect=unreadable),
        ):
            self.assertEqual(self.answer(self.run_calls(_deletion())[0]), unavailable)
        self.assertEqual(self.context.ticket_store._records, {})
        with mock.patch.object(self.context.ticket_store, "issue", side_effect=self.tickets.TicketError("full")):
            self.assertEqual(self.answer(self.run_calls(_deletion())[0]), unavailable)
        with (
            mock.patch.object(
                self.context.challenge_store, "issue", side_effect=self.passkeys.PasskeyUnavailableError("capacity")
            ),
            mock.patch.object(self.local_auth, "passkey_registered", return_value=True),
        ):
            self.assertEqual(self.answer(self.run_calls(_deletion())[0]), unavailable)

        # Reading the ticket's factor generation.
        async def scenario() -> dict:
            websocket = await self._connect()
            await websocket.result(*_deletion())
            with (
                mock.patch.object(self.state, "factor_generation", side_effect=unreadable),
                self.assertLogs("shimpz-admin", level="WARNING"),
            ):
                result = await websocket.result(*_delete({"code": self.code()}))
            await websocket.disconnect()
            return result

        self.assertEqual(self.answer(asyncio.run(scenario())), unavailable)
        self.team_delete.assert_not_called()

    def test_an_unreadable_or_unconfigured_authentication_state_is_refused_inside_the_ceremony(self) -> None:
        """The socket's own session check reads the same state, so these run against the ceremony itself."""
        asker = self.local_auth.Asker(ORIGIN, self.token, self.tickets.Binding("s" * 64, "a" * 32))
        subject = self.local_auth.RECOVERY_CODES_SUBJECT
        for effect, expected in (
            ({"side_effect": OSError("unreadable")}, (503, "authentication-unavailable")),
            ({"return_value": self.admin_app.auth.RECORD_STATE_RECOVERY_REQUIRED}, (409, "authentication-unavailable")),
        ):
            with (
                self.subTest(effect=effect),
                mock.patch.object(self.state, "authentication_state", **effect),
                self.assertRaises(self.local_auth.OperationRefusedError) as refused,
            ):
                asyncio.run(self.local_auth.verify_operation_password(asker, self.context, PASSWORD))
            self.assertEqual((refused.exception.status, refused.exception.code), expected)
        # The session read after an accepted code.
        _offer, token = self.local_auth.offer_operation(asker, self.context, subject)
        confirmation = self.local_auth.Confirmation(token, "totp", self.code())
        with (
            mock.patch.object(self.local_auth.auth, "verify_session", side_effect=OSError("unreadable")),
            self.assertLogs("shimpz-admin", level="WARNING"),
            self.assertRaises(self.local_auth.OperationRefusedError) as refused,
        ):
            self.local_auth.confirm_operation(asker, self.context, subject, confirmation, lambda: True, self.fail)
        self.assertEqual((refused.exception.status, refused.exception.code), (503, "authentication-unavailable"))

    def test_bad_bodies_are_refused_before_the_ticket_is_spent(self) -> None:
        calls = [_deletion()]
        calls.extend(
            _delete(proof)
            for proof in ({}, {"code": 123456}, {"code": "123456", "credential": {}}, {"password": PASSWORD})
        )
        calls.append(_delete({"code": self.code()}))
        results = self.run_calls(*calls)
        self.assertEqual([result["status"] for result in results], [202, 400, 400, 400, 400, 200])
        self.assertEqual(results[1]["body"], {"detail": "request body must contain only code or credential"})
        for body in ({}, {"password": PASSWORD, "code": "123456"}):
            refused = self.run_calls(("routines.deletion", {"team_id": TEAM, "routine_id": ROUTINE, "body": body}))[0]
            self.assertEqual(self.answer(refused), (400, {"detail": "request body must contain only password"}))
        for routine in ("../x", ROUTINE.upper()):
            for method, params in (_deletion(routine), _delete({"code": "123456"}, routine)):
                with self.subTest(method=method, routine=routine):
                    self.assertEqual(
                        self.answer(self.run_calls((method, params))[0]), (400, {"detail": "Routine is invalid"})
                    )
        self.team_delete.assert_called_once_with(TEAM, ROUTINE)

    def test_a_passkey_confirms_the_deletion_and_a_suspension_refuses_it(self) -> None:
        options = {"challenge": "x"}
        with (
            mock.patch.object(self.local_auth, "passkey_registered", return_value=True),
            mock.patch.object(self.state, "active_passkeys", return_value=[{"credential_id": "credential"}]),
            mock.patch.object(self.passkeys, "authentication_options", return_value=options),
            mock.patch.object(self.local_auth, "_passkey_assertion", return_value=("s" * 64, None)) as assertion,
        ):
            offer, deleted = self.run_calls(_deletion(), _delete({"credential": {"id": "credential"}}))
        self.assertEqual(self.answer(offer), (202, {"methods": ["totp", "passkey"], "passkey_options": options}))
        self.assertEqual(deleted["status"], 200)
        self.assertEqual(assertion.call_args.args[2], {"id": "credential"})
        self.team_delete.assert_called_once_with(TEAM, ROUTINE)
        self.team_delete.reset_mock()
        for outcome, expected in (
            (("s" * 64, "counter-regression"), (401, {"code": "passkey-suspended"})),
            (self.admin_app.HTTPException(401, "invalid"), (401, {"code": "passkey-failed"})),
            (self.admin_app.HTTPException(409, "changed"), (401, {"code": "authentication-expired"})),
        ):
            effect = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
            with (
                self.subTest(outcome=outcome),
                mock.patch.object(self.local_auth, "_passkey_assertion", **effect),
                mock.patch.object(self.context.ticket_store, "clear", wraps=self.context.ticket_store.clear) as clear,
            ):
                self.assertEqual(self.answer(self.run_calls(_deletion(), _delete({"credential": {}}))[1]), expected)
                self.assertEqual(clear.called, expected[1]["code"] == "passkey-suspended")
        self.team_delete.assert_not_called()

    def test_a_completed_deletion_raises_the_teams_routines_and_a_refused_one_does_not(self) -> None:
        async def scenario(proof) -> set[str]:
            websocket = await self._connect()
            await websocket.result("subscribe", {"topics": [f"team/{TEAM}/routines"]})
            await websocket.result(*_deletion())
            await websocket.call(*_delete(proof))
            raised = set()
            while (frame := await websocket.next_frame())["type"] != "result":
                raised.add(frame["topic"])
            with contextlib.suppress(TimeoutError):
                raised.add((await websocket.next_frame(0.2))["topic"])
            await websocket.disconnect()
            return raised

        self.assertEqual(asyncio.run(scenario({"code": self.code()})), {f"team/{TEAM}/routines"})
        self.assertEqual(asyncio.run(scenario({"code": self.wrong()})), set())


class SecurityOperationTests(StepUpCase):
    def test_replacing_the_recovery_codes_needs_the_password_and_a_second_factor(self) -> None:
        offer, wrong, again, replaced = self.run_calls(
            ("recovery_codes.confirmation", {"body": {"password": PASSWORD}}),
            ("recovery_codes.replace", {"body": {"code": self.wrong()}}),
            ("recovery_codes.confirmation", {"body": {"password": PASSWORD}}),
            ("recovery_codes.replace", {"body": {"code": self.code()}}),
        )
        self.assertEqual(self.answer(offer), (202, {"methods": ["totp"]}))
        self.assertEqual(self.answer(wrong), (401, {"code": "code-incorrect"}))
        self.assertEqual(again["status"], 202)
        self.assertEqual(replaced["status"], 200)
        fresh = replaced["body"]["recovery_codes"]
        self.assertEqual(len(set(fresh)), 10)
        self.assertFalse(set(fresh) & set(recovery_codes()))
        self.assertIn(
            ("recovery-codes-generated", ORIGIN), [(entry["event"], entry["origin"]) for entry in self.journal()]
        )
        password = self.run_calls(("recovery_codes.confirmation", {"body": {"password": "wrong password value"}}))[0]
        self.assertEqual(self.answer(password), (401, {"code": "password-incorrect"}))

    def _rotation(self, factor: dict) -> dict:
        return self.run_calls(
            ("supervisor_key.confirmation", {"body": {"password": PASSWORD}}),
            ("supervisor_key.rotate", {"body": factor}),
        )[1]

    def test_rotating_the_supervisor_key_needs_the_password_and_a_second_factor(self) -> None:
        app = self.admin_app
        original = self.state.local_supervisor()
        team = mock.Mock(return_value=None)

        def pinned(method, path, payload):
            raw = app.supervisor_key.base64.urlsafe_b64decode(payload["public_key"] + "=")
            team(method, path)
            return self.team.TeamResponse(200, {"rotated": True, "key_sha256": hashlib.sha256(raw).hexdigest()})

        with mock.patch.object(app.supervisor_key.transport, "_call", side_effect=pinned):
            self.assertEqual(self.answer(self._rotation({"code": self.wrong()})), (401, {"code": "code-incorrect"}))
            team.assert_not_called()
            self.assertEqual(self.answer(self._rotation({"code": self.code()})), (200, {"rotated": True}))
        team.assert_called_once_with("POST", "/v1/space/supervisor-key")
        self.assertNotEqual(self.state.local_supervisor(), original)
        # The session stays: the key changes, not the Supervisor.
        self.assertEqual(self.run_calls(("security.summary", {}))[0]["status"], 200)
        events = [(entry["event"], entry["origin"]) for entry in self.journal()]
        self.assertIn(("supervisor-key-rotation-started", ORIGIN), events)
        self.assertEqual(events[-1], ("supervisor-key-rotated", None))

    def test_a_rotation_team_did_not_settle_answers_its_outcome(self) -> None:
        app = self.admin_app
        retry = mock.Mock()
        app.app.state.supervisor_key_recovery = retry
        self.addCleanup(delattr, app.app.state, "supervisor_key_recovery")
        unavailable = self.team.TeamResponse(502, {"detail": "team unavailable"})
        with mock.patch.object(app.supervisor_key.transport, "_call", return_value=unavailable):
            pending = self._rotation({"code": self.code()})
        self.assertEqual(self.answer(pending), (503, {"code": "supervisor-key-rotation-pending"}))
        retry.wake.assert_called_once_with()
        refused = self.team.TeamResponse(403, {"code": "invalid-supervisor"})
        with mock.patch.object(app.supervisor_key.transport, "_call", return_value=refused):
            abandoned = self._rotation({"code": self.code()})
        self.assertEqual(self.answer(abandoned), (409, {"code": "supervisor-key-rotation-refused"}))
        self.assertIsNone(self.state.pending_supervisor_key())
        with mock.patch.object(app.supervisor_key, "rotate", side_effect=self.state.SupervisorKeyRotationError("x")):
            busy = self._rotation({"code": self.code()})
        self.assertEqual(self.answer(busy), (409, {"code": "supervisor-key-rotation-busy"}))
        with mock.patch.object(app.supervisor_key, "rotate", side_effect=OSError("x")):
            failed = self._rotation({"code": self.code()})
        self.assertEqual(self.answer(failed), (503, {"code": "supervisor-key-unavailable"}))
        stale = self.run_calls(("supervisor_key.rotate", {"body": {"code": "123456"}}))[0]
        self.assertEqual(self.answer(stale), (401, {"code": "authentication-expired"}))

    def test_a_completed_security_change_raises_the_sessions_security_summary(self) -> None:
        async def scenario() -> tuple[dict, set[str]]:
            websocket = await self._connect()
            await websocket.result("subscribe", {"topics": ["security/summary"]})
            await websocket.result("recovery_codes.confirmation", {"body": {"password": PASSWORD}})
            await websocket.call("recovery_codes.replace", {"body": {"code": self.code()}})
            raised = set()
            while (result := await websocket.next_frame())["type"] != "result":
                raised.add(result["topic"])
            with contextlib.suppress(TimeoutError):
                raised.add((await websocket.next_frame(0.3))["topic"])
            await websocket.disconnect()
            return result, raised

        result, raised = asyncio.run(scenario())
        self.assertEqual((result["status"], raised), (200, {"security/summary"}))


class OperationTicketTests(StepUpCase):
    def test_operation_tickets_need_a_bounded_subject_and_others_take_none(self) -> None:
        store = self.tickets.TicketStore()
        for purpose, subject in (
            ("operation", ""),
            ("operation", " padded "),
            ("operation", "x" * (self.tickets.MAX_SUBJECT_CHARS + 1)),
            ("operation", "é"),
            ("login", "routine-delete:team_1:" + ROUTINE),
        ):
            with self.subTest(purpose=purpose, subject=subject), self.assertRaises(ValueError):
                store.issue(purpose, ORIGIN, 1, subject)
        token = store.issue("operation", ORIGIN, 1, "routine-delete:team_1:" + ROUTINE)
        ticket = store.consume(token, "operation", "routine-delete:team_1:" + ROUTINE)
        self.assertEqual((ticket.purpose, ticket.subject), ("operation", "routine-delete:team_1:" + ROUTINE))

    def test_the_subject_names_the_canonical_team_and_routine(self) -> None:
        self.assertEqual(self.manage.deletion_subject(TEAM, ROUTINE), f"routine-delete:{TEAM}:{ROUTINE}")
        for team_id, routine_id in (("Team", ROUTINE), (TEAM, "../x"), (TEAM, ROUTINE.upper())):
            with self.subTest(team_id=team_id, routine_id=routine_id), self.assertRaises(self.team.TeamRequestError):
                self.manage.deletion_subject(team_id, routine_id)
