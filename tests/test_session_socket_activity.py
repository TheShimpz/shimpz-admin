"""The Supervisor's own input, reported on the session socket, alone restarts its idle time (ADR-0114)."""

import asyncio
import time
from unittest import mock

from tests.session_socket_case import SessionSocketCase

from tests import chat_socket_fixtures

_Socket = chat_socket_fixtures.Socket
ACTIVITY = {"type": "activity"}


class SessionSocketActivityTests(SessionSocketCase):
    def setUp(self) -> None:
        super().setUp()
        self.auth = self.admin_app.auth
        self.now = [1_000.0]
        sessions = self.auth.SessionActivity(clock=lambda: self.now[0])
        sessions.listen(self.registry.REGISTRY.end_sessions)
        sessions.register(self.token)
        for target, name, value in (
            (self.auth, "SESSIONS", sessions),
            (self.budget, "RENEWALS", self.budget.SessionRenewals(30.0, clock=lambda: self.now[0])),
        ):
            patch = mock.patch.object(target, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def _idle(self) -> float:
        return self.auth.SESSIONS.idle_remaining(self.token)

    def test_a_socket_tells_the_page_its_deadlines_as_it_opens(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            deadlines = await websocket.next_session()
            self.assertEqual(set(deadlines), {"type", "idle_seconds", "absolute_seconds", "source_revision"})
            # A test runs no image build, so this Admin names no commit.
            self.assertIsNone(deadlines["source_revision"])
            self.assertEqual(deadlines["idle_seconds"], self.auth.IDLE_SECONDS)
            self.assertLessEqual(deadlines["absolute_seconds"], self.auth.TTL)
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_a_socket_names_the_commit_its_admin_was_built_from_as_it_opens(self) -> None:
        session_socket = __import__("session.socket", fromlist=["socket"])

        async def scenario() -> None:
            with mock.patch.object(session_socket, "SOURCE_REVISION", "a" * 40):
                websocket = await self._connect()
                self.assertEqual((await websocket.next_session())["source_revision"], "a" * 40)
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_only_the_activity_frame_renews_and_every_tab_of_the_session_hears_the_new_deadline(self) -> None:
        async def scenario() -> None:
            first = await self._connect()
            second = await self._connect()
            for websocket in (first, second):
                await websocket.next_session()
            self.now[0] += 600
            self.assertEqual(self._idle(), self.auth.IDLE_SECONDS - 600)
            await first.send_json(ACTIVITY)
            for websocket in (first, second):
                self.assertEqual((await websocket.next_session())["idle_seconds"], self.auth.IDLE_SECONDS)
            self.assertEqual(self._idle(), self.auth.IDLE_SECONDS)
            await first.disconnect()
            await second.disconnect()

        asyncio.run(scenario())

    def test_activity_from_another_tab_soon_after_a_renewal_changes_nothing(self) -> None:
        async def scenario() -> None:
            first = await self._connect()
            second = await self._connect()
            await first.send_json(ACTIVITY)
            await first.next_session()
            await first.next_session()
            self.now[0] += 20
            with mock.patch.object(self.auth.SESSIONS, "current", wraps=self.auth.SESSIONS.current) as current:
                await second.send_json(ACTIVITY)
                with self.assertRaises(TimeoutError):
                    await second.next_frame(0.2)
            self.assertNotIn(True, {call.kwargs["activity"] for call in current.call_args_list})
            self.assertEqual(self._idle(), self.auth.IDLE_SECONDS - 20)
            # Past the renewal interval, the session's next report renews it again.
            self.now[0] += 15
            await second.send_json(ACTIVITY)
            self.assertEqual((await second.next_session())["idle_seconds"], self.auth.IDLE_SECONDS)
            await first.disconnect()
            await second.disconnect()

        asyncio.run(scenario())

    def test_activity_never_revives_an_idle_session(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            # The socket's own expiry timer would close it too; the clock jumps past the idle window before it can.
            self.now[0] += self.auth.IDLE_SECONDS + 1
            await websocket.send_json(ACTIVITY)
            self.assertEqual(await self._closed(websocket), 4401)
            await websocket.finish()
            self.assertIsNone(self.auth.SESSIONS.idle_remaining(self.token))

        asyncio.run(scenario())

    def test_activity_never_moves_the_absolute_expiry(self) -> None:
        secret = self.admin_app.state.get()["session_secret"]
        self.token = self.auth.issue_session(secret, "totp", issued_at=int(time.time()) - self.auth.TTL + 2)
        self.auth.SESSIONS.register(self.token)

        async def scenario() -> None:
            websocket = await self._connect()
            before = (await websocket.next_session())["absolute_seconds"]
            self.now[0] += 60
            await websocket.send_json(ACTIVITY)
            renewed = await websocket.next_session()
            self.assertLessEqual(renewed["absolute_seconds"], before)
            # The session still ends at its absolute expiry, activity or not.
            self.assertEqual(await self._closed(websocket), 4401)
            await websocket.finish()

        asyncio.run(scenario())

    def test_activity_is_checked_as_every_frame_is_and_renews_nothing_from_a_refused_origin(self) -> None:
        external = "https://developer.example.test"

        async def scenario() -> None:
            self.assertEqual(self.admin_app.state.bind_browser_origin(external), "learned")
            websocket = await self._connect(origin=external)
            self.now[0] += 600
            self.assertEqual(self.admin_app.state.bind_browser_origin("https://next.example.test"), "replaced")
            await websocket.send_json(ACTIVITY)
            self.assertEqual(await self._closed(websocket), 4403)
            await websocket.finish()
            self.assertEqual(self._idle(), self.auth.IDLE_SECONDS - 600)

        asyncio.run(scenario())

    def test_an_activity_frame_that_carries_anything_else_closes_the_socket(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            await websocket.send_json({"type": "activity", "at": 1})
            self.assertEqual(await self._closed(websocket), 1008)
            await websocket.finish()

        asyncio.run(scenario())

    def test_activity_beyond_the_session_call_budget_renews_nothing(self) -> None:
        async def scenario() -> None:
            websocket = await self._connect()
            self.now[0] += 600
            with mock.patch.object(self.budget, "CALL_BUDGET", self.budget.SessionBudget(0)):
                await websocket.send_json(ACTIVITY)
                with self.assertRaises(TimeoutError):
                    await websocket.next_frame(0.2)
            self.assertEqual(self._idle(), self.auth.IDLE_SECONDS - 600)
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_activity_beyond_the_call_budget_still_closes_a_socket_whose_origin_was_replaced(self) -> None:
        external = "https://developer.example.test"

        async def scenario() -> None:
            self.assertEqual(self.admin_app.state.bind_browser_origin(external), "learned")
            websocket = await self._connect(origin=external)
            self.assertEqual(self.admin_app.state.bind_browser_origin("https://next.example.test"), "replaced")
            with mock.patch.object(self.budget, "CALL_BUDGET", self.budget.SessionBudget(0)):
                await websocket.send_json(ACTIVITY)
                self.assertEqual(await self._closed(websocket), 4403)
            await websocket.finish()

        asyncio.run(scenario())
