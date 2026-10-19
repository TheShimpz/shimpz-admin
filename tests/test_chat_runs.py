"""Chat runs detached from their pages (ADR-0119): the queue, Team's busy answer, Stop, revocation, and endings."""

import asyncio
import threading
import unittest
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase

from tests import chat_socket_fixtures


def _done(team_id: str, reply: str) -> object:
    local = chat_socket_fixtures.importlib.import_module("chat.local")
    return local.PublicResponse(
        200, {"team_id": team_id, "team_name": "Marketing", "reply": reply, "clarification": None}
    )


async def _until(predicate, seconds: float = 5.0) -> None:
    for _ in range(int(seconds / 0.01)):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the expected state never came")


async def _next_of(websocket, kinds: set[str]) -> dict:
    while True:
        event = await websocket.next_json()
        if event["type"] in kinds:
            return event


class ChatRunTests(ChatWebSocketCase):
    def _held_turns(self) -> tuple[dict[str, threading.Event], dict[str, threading.Event], object]:
        started = {team: threading.Event() for team in ("team_1", "team_2", "team_3")}
        release = {team: threading.Event() for team in started}

        def turn(team_id, _payload, _conversation, _request, _progress):
            started[team_id].set()
            release[team_id].wait(5)
            return _done(team_id, f"reply for {team_id}")

        return started, release, turn

    def test_a_turn_beyond_the_limit_waits_told_its_place_and_runs_when_one_ends(self) -> None:
        started, release, turn = self._held_turns()

        async def scenario() -> None:
            with mock.patch.object(self.chat_socket.local, "turn", side_effect=turn):
                pages = {}
                for team in ("team_1", "team_2", "team_3"):
                    pages[team] = await self._open_team(team)
                    await pages[team].send_json(chat_socket_fixtures.chat_frame("work"))
                await chat_socket_fixtures.wait_for_thread(started["team_1"])
                await chat_socket_fixtures.wait_for_thread(started["team_2"])
                queued = await _next_of(pages["team_3"], {"running"})
                self.assertEqual((queued["position"], queued["events"]), (1, []))
                self.assertFalse(started["team_3"].is_set())
                release["team_1"].set()
                running = await _next_of(pages["team_3"], {"running"})
                self.assertIsNone(running["position"])
                await chat_socket_fixtures.wait_for_thread(started["team_3"])
                for team in ("team_2", "team_3"):
                    release[team].set()
                for team, page in pages.items():
                    done = await _next_of(page, {"done"})
                    self.assertEqual(done["reply"], f"reply for {team}")
                    await page.disconnect()

        asyncio.run(scenario())

    def test_stop_of_a_waiting_turn_ends_it_at_once_and_it_never_runs(self) -> None:
        started, release, turn = self._held_turns()

        async def scenario() -> None:
            self.chat_socket_fixture_gate().set_limit(1)
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop") as team_stop,
            ):
                first = await self._open_team("team_1")
                await first.send_json(chat_socket_fixtures.chat_frame("work"))
                await chat_socket_fixtures.wait_for_thread(started["team_1"])
                second = await self._open_team("team_2")
                await second.send_json(chat_socket_fixtures.chat_frame("work"))
                self.assertEqual((await _next_of(second, {"running"}))["position"], 1)
                await second.send_json({"type": "stop"})
                self.assertEqual(await _next_of(second, {"stopped", "error", "done"}), {"type": "stopped"})
                # Nothing of it reached Team, so Team is asked to stop nothing.
                team_stop.assert_not_called()
                release["team_1"].set()
                await _next_of(first, {"done"})
                await asyncio.sleep(0.1)
                self.assertFalse(started["team_2"].is_set())
                for page in (first, second):
                    await page.disconnect()
            statuses = [entry for entry in self.history_store.page("team_2")["entries"] if entry["kind"] == "status"]
            self.assertEqual([entry["state"] for entry in statuses], ["stopped"])

        asyncio.run(scenario())

    def test_a_turn_team_finds_the_space_busy_for_waits_at_the_head_and_asks_again(self) -> None:
        answers = iter([self.chat_socket.local.PublicResponse(429, {"code": "space-busy"})])

        def turn(team_id, _payload, _conversation, _request, _progress):
            return next(answers, None) or _done(team_id, "ran on the second ask")

        async def scenario() -> None:
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn) as asked,
                mock.patch.object(self.chat_socket_gate_module(), "BUSY_RETRY_SECONDS", 0.01),
            ):
                page = await self._open_team("team_1")
                await page.send_json(chat_socket_fixtures.chat_frame("work"))
                done = await _next_of(page, {"done", "error"})
                self.assertEqual((done["type"], done["reply"]), ("done", "ran on the second ask"))
                self.assertEqual(asked.call_count, 2)
                await page.disconnect()

        asyncio.run(scenario())

    def test_a_signed_out_session_ends_the_work_it_authorized_and_keeps_how_it_ended(self) -> None:
        started, release, turn = self._held_turns()

        async def scenario() -> None:
            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped) as team_stop,
            ):
                page = await self._open_team("team_1")
                await page.send_json(chat_socket_fixtures.chat_frame("work"))
                await chat_socket_fixtures.wait_for_thread(started["team_1"])
                await page.disconnect()
                run = self.chat_runs.RUNS["team_1"]
                session = run.authority.session
                # Every session ending reaches the runs through the same listener the socket registry uses.
                self.chat_runs.sessions_ended(frozenset({"another-session"}))
                await asyncio.sleep(0.05)
                self.assertTrue(run.busy())
                self.chat_runs.sessions_ended(frozenset({session}))
                await _until(lambda: "team_1" not in self.chat_runs.RUNS)
                await _until(lambda: team_stop.called)
                release["team_1"].set()
            statuses = [entry for entry in self.history_store.page("team_1")["entries"] if entry["kind"] == "status"]
            self.assertEqual([entry["state"] for entry in statuses], ["stopped"])

        asyncio.run(scenario())

    def test_a_frame_admitted_before_its_page_closed_still_runs_under_its_authority(self) -> None:
        started, release, turn = self._held_turns()

        async def scenario() -> None:
            hold = asyncio.Event()
            dispatch = self.chat_socket.dispatch

            async def slow_first(*args, **kwargs):
                if args[3] == {"type": "stop"} and not hold.is_set():
                    hold.set()
                    await asyncio.sleep(0.2)
                return await dispatch(*args, **kwargs)

            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket, "dispatch", side_effect=slow_first),
            ):
                page = await self._open_team("team_1")
                await page.send_json({"type": "stop"})
                await page.send_json(chat_socket_fixtures.chat_frame("admitted, then the page closed"))
                # The socket admitted it, and it waits behind the Stop, when the page closes.
                await _until(lambda: not self.chat_runs.RUNS["team_1"]._frames.empty())
                await page.disconnect()
                await chat_socket_fixtures.wait_for_thread(started["team_1"])
                release["team_1"].set()
                await _until(lambda: not self.chat_runs.RUNS["team_1"].busy())
            replies = [
                entry for entry in self.history_store.page("team_1")["entries"] if entry.get("role") == "assistant"
            ]
            self.assertEqual([entry["text"] for entry in replies], ["reply for team_1"])

        asyncio.run(scenario())

    def test_an_expired_authority_is_found_by_the_sweep_and_an_idle_unwatched_run_is_forgotten(self) -> None:
        started, release, turn = self._held_turns()

        async def scenario() -> None:
            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped),
                mock.patch.object(self.chat_runs, "SWEEP_SECONDS", 0.05),
            ):
                self.chat_runs._SWEEP_TASK[0] = None
                page = await self._open_team("team_1")
                await page.send_json(chat_socket_fixtures.chat_frame("work"))
                await chat_socket_fixtures.wait_for_thread(started["team_1"])
                await page.disconnect()
                run = self.chat_runs.RUNS["team_1"]
                run.authority = self.chat_runs.Authority(
                    session=run.authority.session,
                    scope=run.authority.scope,
                    current=mock.AsyncMock(return_value=False),
                    authenticate=run.authority.authenticate,
                )
                await _until(lambda: "team_1" not in self.chat_runs.RUNS)
                release["team_1"].set()
                # An idle run nobody watches is forgotten at the next sweep.
                idle = self.chat_runs.run_for("team_2")
                await _until(lambda: "team_2" not in self.chat_runs.RUNS)
                self.assertFalse(idle.busy())
                self.chat_runs._SWEEP_TASK[0] = None

        asyncio.run(scenario())

    def test_deleting_a_team_or_resetting_the_space_ends_its_runs(self) -> None:
        async def scenario() -> None:
            for team in ("team_1", "team_2"):
                self.chat_runs.run_for(team)
            ended = []
            with mock.patch.object(self.chat_runs.Run, "end", new=lambda run: _record(ended, run.team_id)):
                self.chat_runs.end_runs("team_1")
                await asyncio.sleep(0.01)
                self.assertEqual(ended, ["team_1"])
                self.chat_runs.end_runs()
                await asyncio.sleep(0.01)
            self.assertEqual(sorted(ended), ["team_1", "team_1", "team_2"])

        asyncio.run(scenario())

    # Helpers

    async def _open_team(self, team_id: str, *, synchronized: bool = True):
        websocket = chat_socket_fixtures.Socket(self.admin_app.app, token=self.token, team_id=team_id)
        self.assertTrue(self._accepted(await websocket.start()))
        await websocket.attach(synchronized=synchronized)
        return websocket

    def chat_socket_gate_module(self):
        return chat_socket_fixtures.importlib.import_module("chat.gate")

    def chat_socket_fixture_gate(self):
        return self.chat_socket_gate_module().GATE


async def _record(ended: list[str], team_id: str) -> None:
    ended.append(team_id)


if __name__ == "__main__":
    unittest.main()
