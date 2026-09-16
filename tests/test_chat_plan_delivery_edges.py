"""Concurrent delivery edges for composed Assistant installation plans."""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat.connection import Connection, Turn

from chat import assistant_plan, plan_delivery


def _plan() -> assistant_plan.Plan:
    return assistant_plan.Plan("a" * 32, "team_1", (), ())


def _operations(**changes) -> plan_delivery.Operations:
    values = {
        "send_event": mock.AsyncMock(return_value=True),
        "finish_turn": mock.AsyncMock(),
        "continue_turn": mock.AsyncMock(),
        "error_terminal": mock.Mock(return_value={"type": "error"}),
    }
    values.update(changes)
    return plan_delivery.Operations(**values)


class PlanDeliveryEdges(unittest.TestCase):
    def test_progress_channel_and_failed_live_update_stop_the_plan(self) -> None:
        async def scenario() -> None:
            queue, report = plan_delivery._progress_channel()
            items = ({"id": "whatsapp", "status": "installing"},)
            report(items)
            await asyncio.sleep(0)
            self.assertEqual(queue.get_nowait(), items)

            queue.put_nowait(items)
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            connection = Connection()
            turn = Turn(future, "assistant-plan", lifecycle_stop=asyncio.Event())
            result = await plan_delivery._await_result(
                mock.sentinel.websocket,
                connection,
                turn,
                _plan(),
                future,
                queue,
                mock.AsyncMock(return_value=False),
            )
            self.assertIsNone(result)
            self.assertTrue(connection.closed)
            self.assertTrue(turn.lifecycle_stop.is_set())
            future.cancel()

        asyncio.run(scenario())

    def test_failed_queued_update_after_worker_completion_closes_delivery(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(assistant_plan.Result("installed", ()))
            queue: asyncio.Queue[tuple[dict[str, object], ...]] = asyncio.Queue()
            queue.put_nowait(({"id": "whatsapp", "status": "installed"},))
            connection = Connection()
            result = await plan_delivery._await_result(
                mock.sentinel.websocket,
                connection,
                Turn(future, "assistant-plan"),
                _plan(),
                future,
                queue,
                mock.AsyncMock(return_value=False),
            )
            self.assertIsNone(result)
            self.assertTrue(connection.closed)

        asyncio.run(scenario())

    def test_successful_live_and_queued_updates_are_fully_drained(self) -> None:
        async def scenario() -> None:
            items = ({"id": "whatsapp", "status": "installing"},)
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            queue: asyncio.Queue[tuple[dict[str, object], ...]] = asyncio.Queue()
            queue.put_nowait(items)

            async def finish_on_update(_websocket, _event) -> bool:
                future.set_result(assistant_plan.Result("installed", ()))
                return True

            result = await plan_delivery._await_result(
                mock.sentinel.websocket,
                Connection(),
                Turn(future, "assistant-plan"),
                _plan(),
                future,
                queue,
                finish_on_update,
            )
            self.assertEqual(result, assistant_plan.Result("installed", ()))

            completed: concurrent.futures.Future[object] = concurrent.futures.Future()
            completed.set_result(assistant_plan.Result("installed", ()))
            queue.put_nowait(items)
            send = mock.AsyncMock(return_value=True)
            result = await plan_delivery._await_result(
                mock.sentinel.websocket,
                Connection(),
                Turn(completed, "assistant-plan"),
                _plan(),
                completed,
                queue,
                send,
            )
            self.assertEqual(result, assistant_plan.Result("installed", ()))
            send.assert_awaited_once()

            pending: concurrent.futures.Future[object] = concurrent.futures.Future()
            queue.put_nowait(items)
            result = await plan_delivery._await_result(
                mock.sentinel.websocket,
                Connection(),
                Turn(pending, "assistant-plan"),
                _plan(),
                pending,
                queue,
                mock.AsyncMock(return_value=False),
            )
            self.assertIsNone(result)
            pending.cancel()

        asyncio.run(scenario())

    def test_missing_preparation_and_failed_planned_event_are_bounded(self) -> None:
        async def scenario() -> None:
            self.assertIsNone(await plan_delivery._preparation_result(Turn(None, "capability-plan")))

            connection = Connection()
            send = mock.AsyncMock(return_value=False)
            result = await plan_delivery._run_job(
                mock.sentinel.websocket,
                connection,
                Turn(None, "capability-plan"),
                _plan(),
                send,
            )
            self.assertIsNone(result)
            self.assertTrue(connection.closed)

        asyncio.run(scenario())

    def test_admitted_delivery_stops_on_disconnect_or_terminal_send_failure(self) -> None:
        async def scenario() -> None:
            operations = _operations()
            with mock.patch.object(plan_delivery, "_run_job", new=mock.AsyncMock(return_value=None)):
                await plan_delivery._deliver_admitted(
                    mock.sentinel.websocket,
                    Connection(),
                    Turn(None, "assistant-plan"),
                    "team_1",
                    {"message": "send", "files": [], "assistant_ids": []},
                    _plan(),
                    operations,
                )
            operations.send_event.assert_not_awaited()
            operations.continue_turn.assert_not_awaited()

            operations = _operations(send_event=mock.AsyncMock(return_value=False))
            result = assistant_plan.Result("installed", ())
            connection = Connection()
            with mock.patch.object(plan_delivery, "_run_job", new=mock.AsyncMock(return_value=result)):
                await plan_delivery._deliver_admitted(
                    mock.sentinel.websocket,
                    connection,
                    Turn(None, "assistant-plan"),
                    "team_1",
                    {"message": "send", "files": [], "assistant_ids": []},
                    _plan(),
                    operations,
                )
            self.assertTrue(connection.closed)
            operations.continue_turn.assert_not_awaited()

        asyncio.run(scenario())

    def test_preparation_closed_error_stop_and_direct_paths_are_distinct(self) -> None:
        async def deliver(
            preparation: assistant_plan.Preparation,
            *,
            connection: Connection | None = None,
            stop_requested: bool = False,
            fallback_payload: dict[str, object] | None = None,
        ) -> plan_delivery.Operations:
            operations = _operations()
            turn = Turn(None, "capability-plan", stop_requested=stop_requested)
            with mock.patch.object(
                plan_delivery,
                "_preparation_result",
                new=mock.AsyncMock(return_value=preparation),
            ):
                await plan_delivery.deliver_preparation(
                    mock.sentinel.websocket,
                    connection or Connection(),
                    turn,
                    "team_1",
                    {"message": "send", "files": [], "assistant_ids": []},
                    operations,
                    fallback_payload=fallback_payload,
                )
            return operations

        async def scenario() -> None:
            closed = await deliver(assistant_plan.Preparation(), connection=Connection(closed=True))
            closed.continue_turn.assert_not_awaited()

            fallback = {"message": "enable it", "files": [], "assistant_ids": []}
            direct = await deliver(assistant_plan.Preparation(), fallback_payload=fallback)
            direct.continue_turn.assert_awaited_once_with(
                mock.sentinel.websocket,
                mock.ANY,
                mock.ANY,
                "team_1",
                fallback,
            )

            error = await deliver(assistant_plan.Preparation(error_status=503))
            error.error_terminal.assert_called_once()
            error.finish_turn.assert_awaited_once()

            stopped = await deliver(assistant_plan.Preparation(plan=_plan()), stop_requested=True)
            stopped.finish_turn.assert_awaited_once_with(
                mock.sentinel.websocket,
                mock.ANY,
                mock.ANY,
                {"type": "stopped"},
            )

            class ChangingPreparation:
                error_status = None

                def __init__(self) -> None:
                    self.reads = 0

                @property
                def plan(self):
                    self.reads += 1
                    return mock.sentinel.plan if self.reads == 1 else None

            exhausted = await deliver(ChangingPreparation())
            exhausted.continue_turn.assert_not_awaited()
            exhausted.finish_turn.assert_not_awaited()

            operations = _operations()
            plan = _plan()
            objective = {"message": "send", "files": [], "assistant_ids": []}
            with (
                mock.patch.object(
                    plan_delivery,
                    "_preparation_result",
                    new=mock.AsyncMock(return_value=assistant_plan.Preparation(plan=plan)),
                ),
                mock.patch.object(plan_delivery, "_deliver_admitted", new=mock.AsyncMock()) as admitted,
            ):
                await plan_delivery.deliver_preparation(
                    mock.sentinel.websocket,
                    Connection(),
                    Turn(None, "capability-plan"),
                    "team_1",
                    objective,
                    operations,
                    fallback_payload=fallback,
                )
            admitted.assert_awaited_once_with(
                mock.sentinel.websocket,
                mock.ANY,
                mock.ANY,
                "team_1",
                objective,
                plan,
                operations,
            )

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
