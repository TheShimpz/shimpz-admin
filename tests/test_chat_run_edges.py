"""Edges of detached chat runs and the Space's chat gate (ADR-0119)."""

import asyncio
import concurrent.futures
import contextlib
import importlib
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from chat.delivery import gated
from history import store as history
from team import transport

from chat import gate as chat_gate
from tests import chat_socket_fixtures


async def _limit() -> int:
    return 1


def _authority(current: bool = True, scope=contextlib.nullcontext):
    socket = importlib.import_module("chat.socket")
    return socket.Authority(
        session="s" * 64,
        scope=scope,
        current=mock.AsyncMock(return_value=current),
        authenticate=mock.AsyncMock(),
    )


class GateEdgeTests(unittest.TestCase):
    def test_a_busy_operation_queues_ahead_of_waiters_and_a_stop_while_it_waits_gives_nothing_back(self) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            gate.set_limit(1)
            places: dict[str, list[int | None]] = {"busy": [], "waiter": []}
            asked_again = asyncio.Event()
            hold = asyncio.Event()

            async def busy() -> None:
                async with gate.slot(places["busy"].append, _limit) as held:
                    await asyncio.sleep(0)
                    asked_again.set()
                    await held.busy()

            async def waiter() -> None:
                async with gate.slot(places["waiter"].append, _limit):
                    await hold.wait()

            with mock.patch.object(chat_gate, "BUSY_RETRY_SECONDS", 0):
                first = asyncio.create_task(busy())
                await asyncio.sleep(0)
                second = asyncio.create_task(waiter())
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                # The waiter took the slot the busy operation gave back; the busy one waits at the head.
                self.assertEqual(places["busy"][-1], 1)
                first.cancel()
                await asyncio.gather(first, return_exceptions=True)
                hold.set()
                await second
            async with gate.slot(lambda _place: None, _limit):
                pass

        asyncio.run(scenario())

    def test_a_wait_granted_and_cancelled_in_one_step_passes_its_slot_on(self) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            gate.set_limit(1)
            waiter_place: list[int | None] = []

            async def queued() -> None:
                async with gate.slot(waiter_place.append, _limit):
                    raise AssertionError("a cancelled waiter ran")

            async with gate.slot(lambda _place: None, _limit):
                task = asyncio.create_task(queued())
                await asyncio.sleep(0)
            # The slot was granted to the waiter as the holder left; cancel it before it resumes.
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            async with gate.slot(lambda _place: None, _limit):
                pass

        asyncio.run(scenario())


class GatedDeliveryEdgeTests(unittest.TestCase):
    def test_the_limit_is_teams_answer_and_no_answer_is_unavailable(self) -> None:
        async def scenario() -> None:
            with mock.patch.object(
                gated.team_bridge, "chat_limit", return_value=transport.TeamResponse(200, {"limit": 1})
            ):
                self.assertEqual(await gated.read_limit(), 1)
            with (
                mock.patch.object(gated.team_bridge, "chat_limit", return_value=transport.TeamResponse(503, {})),
                self.assertRaises(gated.LimitUnavailableError),
            ):
                await gated.read_limit()

        asyncio.run(scenario())

    def test_a_full_queue_or_an_unknown_limit_ends_the_turn_with_its_reason(self) -> None:
        async def scenario() -> None:
            socket = importlib.import_module("chat.socket")
            for failure, status in (
                (chat_gate.QueueFullError("full"), 429),
                (gated.LimitUnavailableError("down"), 503),
            ):
                finish = mock.AsyncMock()
                gate = mock.Mock()
                gate.slot.side_effect = failure
                with self.subTest(status=status), mock.patch.object(chat_gate, "GATE", gate):
                    turn = socket.Turn(None, "queued")
                    await gated.run(mock.AsyncMock(), socket.Connection(), turn, mock.AsyncMock(), finish)
                    self.assertEqual(finish.await_args.args[3]["status"], status)
                    self.assertIsNone(turn.slot)

        asyncio.run(scenario())


class ContinuationEdgeTests(unittest.TestCase):
    def setUp(self) -> None:
        chat_socket_fixtures.fresh_runs(self)
        self.socket = importlib.import_module("chat.socket")

    def test_a_continuation_asks_again_while_the_space_is_busy_and_reports_its_failures(self) -> None:
        async def scenario() -> None:
            busy = transport.TeamResponse(429, {"code": "space-busy"})
            done = transport.TeamResponse(200, {"ok": True})
            answers = iter([busy, done])
            submitted = []

            def submit(_report):
                future: concurrent.futures.Future[object] = concurrent.futures.Future()
                future.set_result(next(answers))
                submitted.append(future)
                return future

            connection = self.socket.Connection(team_id="team_1")
            with mock.patch.object(chat_gate, "BUSY_RETRY_SECONDS", 0):
                result = await self.socket._gated_continuation(mock.AsyncMock(), connection, submit)
            self.assertEqual((result, len(submitted)), (done, 2))

            sent = mock.AsyncMock(return_value=True)
            with mock.patch.object(self.socket, "_send_sync_terminal_once", sent):
                saturated = mock.Mock(side_effect=self.socket.ExecutorSaturatedError)
                self.assertIsNone(await self.socket._gated_continuation(mock.AsyncMock(), connection, saturated))
                for failure in (chat_gate.QueueFullError("full"), gated.LimitUnavailableError("down")):
                    gate = mock.Mock()
                    gate.slot.side_effect = failure
                    with mock.patch.object(chat_gate, "GATE", gate):
                        self.assertIsNone(
                            await self.socket._gated_continuation(mock.AsyncMock(), connection, saturated)
                        )
            self.assertEqual([call.args[2]["status"] for call in sent.await_args_list], [429, 429, 503])

        asyncio.run(scenario())

    def test_a_queued_turn_stopped_without_a_page_or_delivery_ends_quietly(self) -> None:
        async def scenario() -> None:
            turn = self.socket.Turn(None, "queued")
            connection = self.socket.Connection(team_id="team_1", active=turn)
            self.assertIsNone(self.socket._request_stop(mock.AsyncMock(), connection, turn, "team_1", emit=False))
            self.assertTrue(turn.stop_requested)

        asyncio.run(scenario())


class RunEdgeTests(unittest.TestCase):
    def setUp(self) -> None:
        chat_socket_fixtures.fresh_runs(self)
        self.socket = importlib.import_module("chat.socket")

    def test_pages_come_and_go_and_a_page_that_cannot_take_an_event_stops_watching(self) -> None:
        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            run.connection.active = self.socket.Turn(None, "chat")
            kept, failing = [], mock.Mock(side_effect=RuntimeError("overflow"))
            watching = self.socket.Transport(kept.append, mock.Mock())
            broken = self.socket.Transport(failing, mock.Mock())
            run.attach(watching, _authority(), "en")
            run.attach(broken, _authority(), "en")
            self.assertNotIn(broken, run.observers)
            # A page that attaches is shown the latest steps and where the next one continues.
            for seq in range(1, self.socket.LIVE_STEPS + 5):
                run.publish({"type": "progress", "seq": seq, "origin": "team", "phase": "model", "state": "started"})
            snapshot = run.snapshot()
            self.assertEqual(len(snapshot["events"]), self.socket.LIVE_STEPS)
            self.assertEqual((snapshot["events"][0]["seq"], snapshot["cursor"]), (5, self.socket.LIVE_STEPS + 4))
            other = self.socket.Transport(lambda _event: None, mock.Mock())
            run.attach(other, _authority(), "en")
            run.detach(watching)
            # Another page still watches, and the turn runs: nothing is forgotten.
            self.assertIs(self.socket.RUNS["team_1"], run)
            run.detach(other)
            self.assertIs(self.socket.RUNS["team_1"], run)
            await run.end()

        asyncio.run(scenario())

    def test_ending_a_run_without_authority_or_with_a_failing_one_still_ends_it(self) -> None:
        async def scenario() -> None:
            idle = self.socket.run_for("team_1")
            await idle.end()
            self.assertNotIn("team_1", self.socket.RUNS)
            # Ending it again, as a revocation and a deletion may both, finds nothing more to forget.
            await idle.end()

            def failing_scope():
                raise self.socket.transport.TeamRequestError("authority unavailable")

            running = self.socket.run_for("team_2")
            running.authority = _authority(scope=failing_scope)
            with self.assertLogs("shimpz-admin", "WARNING"):
                await running.end()
            self.assertTrue(running.connection.closed)

        asyncio.run(scenario())

    def test_the_sweep_keeps_current_and_watched_work_and_ends_only_what_it_must(self) -> None:
        async def scenario() -> None:
            with mock.patch.object(self.socket, "SWEEP_SECONDS", 0.01):
                self.socket._SWEEP_TASK[0] = None
                current = self.socket.run_for("team_1")
                current.connection.active = self.socket.Turn(None, "chat")
                current.authority = _authority(current=True)
                unowned = self.socket.run_for("team_2")
                unowned.connection.active = self.socket.Turn(None, "chat")
                watched = self.socket.run_for("team_3")
                watched.observers.add(self.socket.Transport(lambda _event: None, mock.Mock()))
                await asyncio.sleep(0.05)
                self.assertEqual(sorted(self.socket.RUNS), ["team_1", "team_2", "team_3"])
                for run in (current, unowned, watched):
                    await run.end()
                await asyncio.sleep(0.05)
                self.socket._SWEEP_TASK[0] = None

        asyncio.run(scenario())

    def test_session_endings_reach_runs_only_once_a_loop_holds_them(self) -> None:
        with mock.patch.object(self.socket, "_SWEEP_LOOP", [None]):
            self.socket.sessions_ended(None)

        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            run.connection.active = self.socket.Turn(None, "chat")
            run.authority = _authority()
            with mock.patch.object(self.socket.Run, "end", new=mock.AsyncMock()) as end:
                self.socket.sessions_ended(None)
                await asyncio.sleep(0.01)
            end.assert_awaited_once()

        asyncio.run(scenario())


class AuthorityAndResetEdgeTests(unittest.TestCase):
    def test_an_unreadable_origin_store_is_no_authority(self) -> None:
        async def scenario() -> None:
            socket = importlib.import_module("session.socket")
            subject = object.__new__(socket.SessionSocket)
            subject.origin = "http://localhost:7777"
            subject.gate = mock.Mock()
            subject.gate.allowed_origins.side_effect = OSError("unreadable")
            self.assertFalse(await subject._still_authorized())

        asyncio.run(scenario())

    def test_a_status_payload_is_only_an_ending_and_its_detail_only_text(self) -> None:
        with self.assertRaises(ValueError):
            history._status_payload(["stopped"])
        payload = history._status_payload({"type": "error", "status": 500, "detail": 7})
        self.assertEqual(payload["detail"], "the turn failed")


if __name__ == "__main__":
    unittest.main()
