"""Edges of detached chat runs and the Space's chat gate (ADR-0119)."""

import asyncio
import concurrent.futures
import contextlib
import importlib
import sys
import threading
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
                    # Team answers busy once the waiter queued behind it.
                    await asked_again.wait()
                    await held.busy()

            async def waiter() -> None:
                async with gate.slot(places["waiter"].append, _limit):
                    await hold.wait()

            async def until(predicate) -> None:
                for _ in range(1000):
                    if predicate():
                        return
                    await asyncio.sleep(0)
                raise AssertionError("the expected state never came")

            with mock.patch.object(chat_gate, "BUSY_RETRY_SECONDS", 0):
                first = asyncio.create_task(busy())
                await until(lambda: places["busy"] == [None])
                second = asyncio.create_task(waiter())
                await until(lambda: places["waiter"] == [1])
                asked_again.set()
                # The waiter took the slot the busy operation gave back; the busy one waits at the head.
                await until(lambda: places["waiter"][-1] is None and places["busy"][-1] == 1)
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

    def test_a_run_whose_team_never_answers_holds_up_no_other_runs_ending(self) -> None:
        async def scenario() -> None:
            hung: concurrent.futures.Future[object] = concurrent.futures.Future()
            hung.set_running_or_notify_cancel()
            stuck = self.socket.run_for("team_1")
            stuck.connection.active = self.socket.Turn(hung, "chat")
            stuck.authority = _authority(current=False)
            expired = self.socket.run_for("team_2")
            expired.connection.active = self.socket.Turn(None, "chat")
            expired.authority = _authority(current=False)
            stopped = self.socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.socket, "SWEEP_SECONDS", 0.01),
                mock.patch.object(self.socket, "STOP_RESULT_WAIT_SECONDS", 0.01),
                mock.patch.object(self.socket.local, "stop", return_value=stopped),
            ):
                self.socket._SWEEP_TASK[0] = None
                self.socket._start_sweep()
                for _ in range(200):
                    if "team_2" not in self.socket.RUNS:
                        break
                    await asyncio.sleep(0.01)
                self.assertNotIn("team_2", self.socket.RUNS)
                self.assertIs(self.socket.RUNS.get("team_1"), stuck)
                hung.set_result(object())
                for _ in range(200):
                    if not self.socket.RUNS:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(self.socket.RUNS, {})
                self.socket._SWEEP_TASK[0] = None

        asyncio.run(scenario())

    def test_a_turn_with_no_ending_admin_holds_is_stopped_in_team_when_its_run_ends(self) -> None:
        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            run.authority = _authority()
            answered: concurrent.futures.Future[object] = concurrent.futures.Future()
            answered.set_result(self.socket.local.PublicResponse(503, {}))
            run.connection.active = self.socket.Turn(answered, "chat")
            stopped = self.socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with mock.patch.object(self.socket.local, "stop", return_value=stopped) as stop:
                await run.end()
            stop.assert_called_once_with("team_1")
            self.assertNotIn("team_1", self.socket.RUNS)

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


class AuditEdgeTests(unittest.TestCase):
    def setUp(self) -> None:
        chat_socket_fixtures.fresh_runs(self)
        self.socket = importlib.import_module("chat.socket")

    def test_a_refused_frame_reaches_only_its_page_and_never_takes_the_running_works_authority(self) -> None:
        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            first, second = [], []
            watching = self.socket.Transport(first.append, mock.Mock())
            sending = self.socket.Transport(second.append, mock.Mock())
            run.observers.update({watching, sending})
            running = _authority()
            run.authority = running
            run.connection.active = self.socket.Turn(None, "chat")
            run.live = [{"type": "progress", "seq": 1, "origin": "team", "phase": "model", "state": "started"}]
            other = _authority()
            frame = chat_socket_fixtures.chat_frame("a second message")
            await run._run_frame(frame, other, sending)
            # Only the page that sent it hears the refusal; the running work keeps its authority and its steps.
            self.assertEqual([event["status"] for event in second], [409])
            self.assertEqual(first, [])
            self.assertIs(run.authority, running)
            self.assertEqual(len(run.live), 1)
            await run.end()

        asyncio.run(scenario())

    def test_an_operation_whose_session_ended_while_it_waited_never_starts(self) -> None:
        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            run.authority = _authority(current=False)
            relay = self.socket.FrameRelay(run, None)
            relay.dispatching = False
            finish = mock.AsyncMock()
            work = mock.AsyncMock()
            turn = self.socket.Turn(None, "queued")
            await gated.run(relay, run.connection, turn, work, finish)
            work.assert_not_awaited()
            self.assertEqual(finish.await_args.args[3]["status"], 401)
            sent = mock.AsyncMock(return_value=True)
            with mock.patch.object(self.socket, "_send_sync_terminal_once", sent):
                self.assertIsNone(await self.socket._gated_continuation(relay, run.connection, mock.Mock()))
            self.assertEqual(sent.await_args.args[2]["status"], 401)
            await run.end()

        asyncio.run(scenario())

    def test_ending_a_run_stops_a_continuation_team_executes_and_holds_the_team_until_it_ended(self) -> None:
        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            run.authority = _authority()
            run.connection.continuing = True
            stopped = asyncio.Event()
            seen_registered = []

            def stop(_team_id):
                seen_registered.append(self.socket.RUNS.get("team_1") is run)
                return self.socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})

            page = []
            observer = self.socket.Transport(page.append, mock.Mock())
            with mock.patch.object(self.socket.local, "stop", side_effect=stop):
                ending = asyncio.create_task(run.end())
                await asyncio.sleep(0)
                # A frame sent while it ends is refused to its page, to be sent again.
                run.submit({"type": "stop"}, _authority(), observer)
                await ending
                stopped.set()
            self.assertEqual(seen_registered, [True])
            self.assertNotIn("team_1", self.socket.RUNS)
            self.assertEqual(page[-1]["status"], 409)
            # A page that watched it follows the Team's next run.
            channel = self.socket.Channel(observer, "team_1", _authority)
            self.assertIsNot(channel.run, run)
            self.assertIn(observer, channel.run.observers)
            channel.halt()
            await asyncio.sleep(0)

        asyncio.run(scenario())


class RunBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        chat_socket_fixtures.fresh_runs(self)
        self.socket = importlib.import_module("chat.socket")

    def test_a_frames_other_events_reach_every_page_and_a_replaced_run_is_never_forgotten_twice(self) -> None:
        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            first, second = [], []
            run.observers.update({self.socket.Transport(first.append, mock.Mock())})
            relay = self.socket.FrameRelay(run, self.socket.Transport(second.append, mock.Mock()))
            await relay.send_json({"type": "sync-empty"})
            self.assertEqual(first, [{"type": "sync-empty"}])
            # Another run took the Team's place meanwhile: retiring or ending the old one leaves it there.
            newer = self.socket.Run("team_1")
            self.socket.RUNS["team_1"] = newer
            run.retire()
            await run.end()
            self.assertIs(self.socket.RUNS["team_1"], newer)
            # A page never watches a run that is ending.
            newer.connection.closed = True
            channel = self.socket.Channel(self.socket.Transport(first.append, mock.Mock()), "team_1", _authority)
            self.assertNotIn(channel.transport, channel.run.observers)
            newer.connection.closed = False
            await newer.end()

        asyncio.run(scenario())

    def test_a_turn_retried_after_a_busy_space_never_starts_once_its_session_ended(self) -> None:
        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            run.authority = _authority()
            relay = self.socket.FrameRelay(run, None)
            relay.dispatching = False
            busy = self.socket.local.PublicResponse(429, {"code": "space-busy"})
            turn = self.socket.Turn(None, "chat", history_id=None)
            run.connection.active = turn

            async def rested() -> None:
                run.authority = _authority(current=False)

            turn.slot = mock.Mock(busy=mock.AsyncMock(side_effect=rested))
            with mock.patch.object(self.socket.local, "turn", return_value=busy):
                await self.socket._continue_team_turn(relay, run.connection, turn, "team_1", {})
            self.assertTrue(turn.terminal_sent)
            await run.end()

        asyncio.run(scenario())

    def test_an_operation_coming_back_from_a_busy_space_waits_while_another_still_rests(self) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            gate.set_limit(1)
            gate._resting = 1
            entered = []

            async def queued() -> None:
                async with gate.slot(entered.append, _limit):
                    pass

            task = asyncio.create_task(queued())
            await asyncio.sleep(0)
            self.assertEqual(entered, [1])
            gate._resting = 0
            gate._grant()
            await task
            self.assertEqual(entered, [1, None])

        asyncio.run(scenario())


class ReviewEdgeTests(unittest.TestCase):
    def setUp(self) -> None:
        chat_socket_fixtures.fresh_runs(self)
        self.socket = importlib.import_module("chat.socket")

    def test_a_page_that_leaves_while_its_frame_is_dispatched_never_ends_the_message(self) -> None:
        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            page = self.socket.Transport(lambda _event: None, mock.Mock())
            run.observers.add(page)
            admitted = asyncio.Event()
            release = asyncio.Event()

            async def dispatch(*_args, **_kwargs):
                admitted.set()
                await release.wait()

            with mock.patch.object(self.socket, "_dispatch", side_effect=dispatch):
                run.submit(chat_socket_fixtures.chat_frame("hello"), _authority(), page)
                await admitted.wait()
                run.detach(page)
                # The frame under dispatch keeps the run: the message it carries is not lost.
                self.assertIs(self.socket.RUNS.get("team_1"), run)
                release.set()
                await asyncio.sleep(0)
            await run.end()

        asyncio.run(scenario())

    def test_the_first_limit_is_read_once_for_everyone_and_counts_against_the_queue(self) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            answered = asyncio.Event()
            reads = []

            async def slow_limit() -> int:
                reads.append(1)
                await answered.wait()
                return 1

            async def enter() -> None:
                async with gate.slot(lambda _place: None, slow_limit):
                    await asyncio.sleep(0)

            with mock.patch.object(chat_gate, "MAX_WAITING", 2):
                tasks = [asyncio.create_task(enter()) for _ in range(2)]
                await asyncio.sleep(0)
                with self.assertRaises(chat_gate.QueueFullError):
                    async with gate.slot(lambda _place: None, slow_limit):
                        raise AssertionError("an operation passed a full queue while the limit was read")
                answered.set()
                await asyncio.gather(*tasks)
            self.assertEqual((reads, gate.limit), ([1], 1))

            failing = chat_gate.Gate()

            async def unavailable() -> int:
                raise RuntimeError("Team is unavailable")

            with self.assertRaises(RuntimeError):
                async with failing.slot(lambda _place: None, unavailable):
                    pass
            # A failed read is tried again by the next operation.
            async with failing.slot(lambda _place: None, _limit):
                pass

        asyncio.run(scenario())

    def test_an_ended_run_keeps_its_team_until_its_work_and_its_stop_ended(self) -> None:
        async def scenario() -> None:
            run = self.socket.run_for("team_1")
            run.authority = _authority()
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_running_or_notify_cancel()
            run.connection.active = self.socket.Turn(future, "chat")
            continuation: concurrent.futures.Future[object] = concurrent.futures.Future()
            continuation.set_running_or_notify_cancel()
            run.connection.continuation = continuation
            stopped = self.socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            answer = threading.Event()

            def stop(_team_id: str) -> object:
                answer.wait(timeout=5)
                return stopped

            with (
                mock.patch.object(self.socket.local, "stop", side_effect=stop),
                mock.patch.object(self.socket, "STOP_RESULT_WAIT_SECONDS", 0.01),
            ):
                ending = asyncio.create_task(run.end())
                await asyncio.sleep(0.1)
                self.assertIs(self.socket.RUNS.get("team_1"), run)
                future.set_result(object())
                await asyncio.sleep(0.05)
                self.assertIs(self.socket.RUNS.get("team_1"), run)
                continuation.set_result(object())
                await asyncio.sleep(0.05)
                # Its Stop is still under way.
                self.assertIs(self.socket.RUNS.get("team_1"), run)
                answer.set()
                await ending
            self.assertNotIn("team_1", self.socket.RUNS)

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
