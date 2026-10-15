"""The Admin session socket's chat channel (ADR-0114): attach, detach, waiting frames, halting, and authority."""

import asyncio
from unittest import mock

from tests.session_socket_case import SessionSocketCase

from tests import chat_socket_fixtures


class SessionSocketChatChannelTests(SessionSocketCase):
    def test_a_socket_attaches_at_most_four_teams_each_once(self) -> None:
        async def scenario() -> None:
            websocket = await self._open()
            for team_id in ("team_2", "team_3", "team_4"):
                websocket.team_id = team_id
                await websocket.attach()
            refused = await websocket.result("chat.attach", {"team_id": "team_5", "locale": "en"})
            self.assertEqual(refused["status"], 409)
            again = await websocket.result("chat.attach", {"team_id": "team_1", "locale": "en"})
            self.assertEqual(again["status"], 409)
            for params, status in (
                ({"team_id": "Team 5", "locale": "en"}, 400),
                ({"team_id": "team_5", "locale": "xx"}, 400),
            ):
                self.assertEqual((await websocket.result("chat.attach", params))["status"], status)
            self.assertEqual((await websocket.result("chat.detach", {"team_id": "team_9"}))["status"], 409)
            self.assertEqual((await websocket.result("chat.detach", {"team_id": "team_4"}))["status"], 200)
            websocket.team_id = "team_5"
            await websocket.attach()
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_a_frame_for_a_team_that_is_not_attached_closes_the_socket(self) -> None:
        async def scenario() -> None:
            websocket = await self._open()
            await websocket.send_json({"type": "stop", "team_id": "team_2"})
            self.assertEqual(await self._closed(websocket), 1008)
            await websocket.finish()

        asyncio.run(scenario())

    def test_detaching_stops_the_teams_active_turn_and_keeps_the_others(self) -> None:
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
                self.assertEqual((await websocket.result("chat.detach", {"team_id": "team_1"}))["status"], 200)
                for _ in range(100):
                    if stop.called:
                        break
                    await asyncio.sleep(0.02)
                release.set()
                stop.assert_called_once_with("team_1")
                # The socket stays open for its other work.
                self.assertEqual((await websocket.result("subscribe", {"topics": ["teams"]}))["status"], 200)
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_no_chat_frame_renews_the_session(self) -> None:
        # A turn under way or a request waiting for the person keeps nothing alive; the person's input does.
        auth = self.admin_app.auth

        async def scenario() -> None:
            websocket = await self._open()
            with mock.patch.object(auth.SESSIONS, "current", wraps=auth.SESSIONS.current) as current:
                await websocket.send_json({"type": "stop"})
                with mock.patch.object(self.chat_socket, "_dispatch_sync", new=mock.AsyncMock()):
                    await websocket.send_json({"type": "sync", "locale": "en"})
                    await asyncio.sleep(0.1)
            self.assertTrue(current.call_args_list)
            self.assertEqual({call.kwargs["activity"] for call in current.call_args_list}, {False})
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_chat_frames_spend_the_call_budget_and_stop_never_does(self) -> None:
        async def scenario() -> None:
            websocket = await self._open()
            with (
                mock.patch.object(self.budget, "CALL_BUDGET", self.budget.SessionBudget(0)),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                await websocket.send_json(chat_socket_fixtures.chat_frame("over budget"))
                self.assertEqual(
                    await websocket.next_json(),
                    {"type": "error", "status": 429, "detail": "session call budget reached"},
                )
                turn.assert_not_called()
                # Stop is exempt: it always reaches the channel, which answers a Stop with nothing to stop by silence.
                await websocket.send_json({"type": "stop"})
                with self.assertRaises(TimeoutError):
                    await websocket.next_frame(0.2)
            await websocket.disconnect()

        asyncio.run(scenario())


class SessionSocketWaitingTests(SessionSocketCase):
    def test_a_channel_holds_a_bounded_number_of_waiting_frames_stop_included(self) -> None:
        release = asyncio.Event()

        async def held(*_args):
            await release.wait()

        async def scenario() -> None:
            websocket = await self._open()
            with mock.patch.object(self.chat_socket, "_dispatch", side_effect=held):
                # One frame dispatches and blocks; eight more wait; one more beyond the bound closes the socket.
                for _ in range(1 + self.chat_socket.MAX_WAITING_FRAMES):
                    await websocket.send_json({"type": "stop"})
                await asyncio.sleep(0.1)
                await websocket.send_json({"type": "stop"})
                self.assertEqual(await self._closed(websocket), 1008)
                release.set()
            await websocket.finish()

        asyncio.run(scenario())

    def test_a_closing_socket_ends_its_authority_before_its_channels_finish_stopping(self) -> None:
        turn, started, release = chat_socket_fixtures.held_turn()
        observed = {}

        def stop(_team_id):
            # Team is slow to answer the Stop: the socket's binding and close already happened.
            observed["live"] = self.registry.REGISTRY.handles()
            release.set()
            return self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})

        async def scenario() -> None:
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", side_effect=stop),
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("work"))
                await chat_socket_fixtures.wait_for_thread(started)
                await asyncio.to_thread(self.admin_app.state.revoke_sessions_for_logout, self.token)
                self.assertEqual(await self._closed(websocket), 4401)
                await websocket.finish()
            self.assertEqual(observed["live"], ())

        asyncio.run(scenario())


class SessionSocketHaltTests(SessionSocketCase):
    def test_a_closing_socket_dispatches_no_waiting_chat_frame_even_while_its_close_is_slow(self) -> None:
        dispatched = []
        release = asyncio.Event()

        async def dispatch(_transport, _connection, _team_id, frame, _authenticate):
            dispatched.append(frame["type"])
            if len(dispatched) == 1:
                await release.wait()

        async def scenario() -> None:
            websocket = await self._open()
            socket = next(listener.__self__ for listener in self.topics._listeners)
            close = socket.websocket.close
            closing = asyncio.Event()

            async def slow_close(*args, **kwargs):
                closing.set()
                await asyncio.sleep(0.3)
                await close(*args, **kwargs)

            with (
                mock.patch.object(self.chat_socket, "_dispatch", side_effect=dispatch),
                mock.patch.object(socket.websocket, "close", side_effect=slow_close),
            ):
                await websocket.send_json({"type": "stop"})
                await websocket.send_json({"type": "stop"})
                await asyncio.sleep(0.1)
                await asyncio.to_thread(self.admin_app.state.revoke_sessions_for_logout, self.token)
                await closing.wait()
                release.set()
                self.assertEqual(await self._closed(websocket), 4401)
                await websocket.finish()
            # The frame that was dispatching ends; the one waiting behind it never starts.
            self.assertEqual(dispatched, ["stop"])

        asyncio.run(scenario())

    def test_a_waiting_chat_frame_dispatches_only_while_its_origin_and_session_are_still_current(self) -> None:
        external = "https://developer.example.test"
        dispatched = []
        release = asyncio.Event()

        async def dispatch(_transport, _connection, _team_id, frame, _authenticate):
            dispatched.append(frame["type"])
            if len(dispatched) == 1:
                await release.wait()

        async def scenario() -> None:
            self.assertEqual(self.admin_app.state.bind_browser_origin(external), "learned")
            websocket = await self._open(origin=external)
            with mock.patch.object(self.chat_socket, "_dispatch", side_effect=dispatch):
                await websocket.send_json({"type": "stop"})
                await websocket.send_json(chat_socket_fixtures.chat_frame("admitted while the origin was"))
                await asyncio.sleep(0.1)
                # The admitted origin is replaced while the second frame waits: it must never run under it.
                self.assertEqual(self.admin_app.state.bind_browser_origin("https://next.example.test"), "replaced")
                release.set()
                self.assertEqual(await self._closed(websocket), 4403)
                await websocket.finish()
            self.assertEqual(dispatched, ["stop"])

        asyncio.run(scenario())


class SessionSocketAuthorityTests(SessionSocketCase):
    def test_a_chat_frame_without_current_supervisor_authority_is_refused_and_the_channel_ends_cleanly(self) -> None:
        unavailable = self.admin_app.supervisor.SupervisorAuthorityError("signing key unreadable")

        async def scenario() -> None:
            websocket = await self._open()
            with (
                mock.patch.object(self.admin_app.state, "local_supervisor", side_effect=unavailable),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                self.assertLogs("shimpz-admin", "WARNING"),
            ):
                await websocket.send_json(chat_socket_fixtures.chat_frame("must not run"))
                self.assertEqual(
                    await websocket.next_json(),
                    {"type": "error", "status": 503, "detail": "Supervisor authority is unavailable"},
                )
                turn.assert_not_called()
                # Detaching needs no authority, and the channel still ends every operation it ran.
                self.assertEqual((await websocket.result("chat.detach", {"team_id": "team_1"}))["status"], 200)
                await asyncio.sleep(0.1)
            await websocket.disconnect()

        asyncio.run(scenario())
