"""Socket-scoped automatic preparation and destructive lifecycle edges."""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import (
    assistant_plan,
    assistant_proposal,
    assistant_uninstall,
    lifecycle,
)
from chat import (
    connection as chat_connection,
)


def _proposal() -> assistant_proposal.UninstallProposal:
    candidate = assistant_proposal.UninstallCandidate(
        assistant_proposal.Capability(
            "shimpz-cloudflare",
            "Shimpz Cloudflare",
            "Manage Cloudflare zones and DNS records.",
            ("list-zones",),
        ),
        "0.4.4",
    )
    return assistant_proposal.create_uninstall_proposal(
        "team_1",
        candidate,
        language_exemplar="Desinstale o Assistant do Cloudflare",
        now=1.0,
        proposal_id_factory=lambda: "c" * 32,
    )


def _connection(**changes):
    values = {
        "closed": False,
        "lifecycle_proposal": None,
        "lifecycle": None,
        "admitted_history_id": None,
        "assistant_reference": None,
    }
    values.update(changes)
    return SimpleNamespace(**values)


class ChatLifecycleTests(unittest.TestCase):
    def test_new_socket_has_no_cross_connection_assistant_reference(self) -> None:
        first = chat_connection.Connection(
            assistant_reference=assistant_proposal.AssistantReference("shimpz-cloudflare", "Shimpz Cloudflare")
        )
        second = chat_connection.Connection()

        self.assertIsNotNone(first.assistant_reference)
        self.assertIsNone(second.assistant_reference)

    def test_route_and_reconnect_preparation_saturation_are_explicit(self) -> None:
        with mock.patch.object(
            lifecycle,
            "submit_in_context",
            side_effect=lifecycle.ExecutorSaturatedError,
        ):
            with self.assertRaises(lifecycle.ExecutorSaturatedError):
                lifecycle.submit_route(
                    "team_1",
                    {"message": "Desinstale o Cloudflare", "assistant_ids": []},
                    None,
                )
            with self.assertRaises(lifecycle.ExecutorSaturatedError):
                lifecycle.submit_resume(
                    "team_1",
                    {"message": "Configure Cloudflare", "assistant_ids": []},
                )

    def test_route_submission_captures_one_immutable_reference(self) -> None:
        sentinel = mock.sentinel.future
        reference = assistant_proposal.AssistantReference("shimpz-cloudflare", "Shimpz Cloudflare")
        payload = {"message": "instale ele de novo", "assistant_ids": []}
        with mock.patch.object(lifecycle, "submit_in_context", return_value=sentinel) as submit:
            self.assertIs(lifecycle.submit_route("team_1", payload, reference), sentinel)

        submit.assert_called_once_with(
            lifecycle._PLAN_EXECUTOR,
            lifecycle.assistant_route.prepare,
            "team_1",
            payload,
            lifecycle._STORE_CATALOG,
            None,
            reference,
        )

    def test_uninstall_events_expose_only_bounded_team_identity(self) -> None:
        proposal = _proposal()

        self.assertEqual(
            lifecycle._proposal_event(proposal),
            {
                "type": "assistant-uninstall",
                "state": "proposed",
                "proposal_id": "c" * 32,
                "team_id": "team_1",
                "reply": "Assistant uninstall requires confirmation.",
                "expires_in": 120,
                "assistant": {
                    "id": "shimpz-cloudflare",
                    "name": "Shimpz Cloudflare",
                    "summary": "Manage Cloudflare zones and DNS records.",
                    "version": "0.4.4",
                },
            },
        )
        self.assertEqual(
            lifecycle._result_event(proposal, assistant_uninstall.UninstallResult(200, True)),
            {
                "type": "assistant-uninstall",
                "state": "uninstalled",
                "proposal_id": "c" * 32,
                "assistant_id": "shimpz-cloudflare",
                "team_id": "team_1",
                "uninstalled": True,
            },
        )

    def test_uncommitted_uninstall_is_not_reported_as_durable(self) -> None:
        async def scenario() -> None:
            event = lifecycle._result_event(
                _proposal(),
                assistant_uninstall.UninstallResult(200, True),
            )
            with mock.patch.object(lifecycle.history, "append_uninstall", return_value=False):
                committed = await lifecycle._commit_uninstall(
                    _proposal(),
                    "a" * 32,
                    event,
                )
            self.assertFalse(committed)

        asyncio.run(scenario())

    def test_install_language_cannot_confirm_uninstall(self) -> None:
        async def scenario() -> None:
            connection = _connection(lifecycle_proposal=_proposal())
            dispatch = mock.AsyncMock()
            with (
                mock.patch.object(lifecycle, "_dispatch", dispatch),
                mock.patch.object(lifecycle, "monotonic", return_value=10.0),
            ):
                handled = await lifecycle.resolve(
                    mock.sentinel.websocket,
                    connection,
                    "team_1",
                    {"message": "install it", "files": []},
                    mock.AsyncMock(return_value=True),
                )
            self.assertFalse(handled)
            dispatch.assert_not_awaited()

            connection.lifecycle_proposal = _proposal()
            with (
                mock.patch.object(lifecycle, "_dispatch", dispatch),
                mock.patch.object(lifecycle, "monotonic", return_value=10.0),
            ):
                handled = await lifecycle.resolve(
                    mock.sentinel.websocket,
                    connection,
                    "team_1",
                    {"message": "yes", "files": []},
                    mock.AsyncMock(return_value=True),
                )
            self.assertTrue(handled)
            dispatch.assert_awaited_once()

        asyncio.run(scenario())

    def test_invalid_worker_result_is_projected_as_failure(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(object())
            connection = _connection()
            operation = lifecycle.Operation(_proposal(), future)
            connection.lifecycle = operation
            operation.delivery = asyncio.current_task()
            events = []

            async def collect(_websocket, event) -> bool:
                events.append(event)
                return True

            await lifecycle._deliver(mock.sentinel.websocket, connection, operation, collect)

            self.assertEqual(events[0]["state"], "failed")
            self.assertEqual(events[0]["status"], 502)
            self.assertIsNone(connection.assistant_reference)
            self.assertIsNone(connection.lifecycle)

        asyncio.run(scenario())

    def test_successful_uninstall_remembers_only_the_assistant_identity(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(assistant_uninstall.UninstallResult(200, True))
            connection = _connection()
            operation = lifecycle.Operation(_proposal(), future)
            connection.lifecycle = operation
            operation.delivery = asyncio.current_task()

            await lifecycle._deliver(
                mock.sentinel.websocket,
                connection,
                operation,
                mock.AsyncMock(return_value=True),
            )

            self.assertEqual(
                connection.assistant_reference,
                assistant_proposal.AssistantReference("shimpz-cloudflare", "Shimpz Cloudflare"),
            )

        asyncio.run(scenario())

    def test_closed_or_failed_delivery_cannot_outlive_socket_authority(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(assistant_uninstall.UninstallResult(200, True))
            operation = lifecycle.Operation(_proposal(), future)
            closed = _connection(closed=True, lifecycle=operation)
            send = mock.AsyncMock(return_value=True)
            await lifecycle._deliver(mock.sentinel.websocket, closed, operation, send)
            send.assert_not_awaited()

            operation = lifecycle.Operation(_proposal(), future)
            connected = _connection(lifecycle=operation)
            send = mock.AsyncMock(return_value=False)
            await lifecycle._deliver(mock.sentinel.websocket, connected, operation, send)
            self.assertTrue(connected.closed)
            self.assertIs(connected.lifecycle, operation)

        asyncio.run(scenario())

    def test_saturated_uninstall_is_fail_closed(self) -> None:
        async def scenario() -> None:
            connection = _connection()
            send = mock.AsyncMock(return_value=True)
            with mock.patch.object(
                lifecycle,
                "submit_in_context",
                side_effect=lifecycle.ExecutorSaturatedError,
            ):
                await lifecycle._dispatch(mock.sentinel.websocket, connection, _proposal(), send)
            self.assertEqual(send.await_count, 2)
            self.assertEqual(send.await_args_list[-1].args[1]["status"], 429)

        asyncio.run(scenario())

    def test_uninstall_history_failures_never_project_success(self) -> None:
        async def scenario() -> None:
            proposal = _proposal()
            connection = _connection()
            lifecycle.retain_history(connection, "a" * 32, {"type": "done"})
            self.assertIsNone(connection.admitted_history_id)

            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(assistant_uninstall.UninstallResult(200, True))
            operation = lifecycle.Operation(proposal, future, history_id="a" * 32)
            connection.lifecycle = operation
            operation.delivery = asyncio.current_task()
            send = mock.AsyncMock(return_value=True)
            with mock.patch.object(lifecycle, "_commit_uninstall", new=mock.AsyncMock(return_value=False)):
                await lifecycle._deliver(mock.sentinel.websocket, connection, operation, send)
            self.assertEqual(send.await_args.args[1], lifecycle._history_error())

            connection = _connection()
            send = mock.AsyncMock(return_value=True)
            with (
                mock.patch.object(
                    lifecycle,
                    "submit_in_context",
                    side_effect=lifecycle.ExecutorSaturatedError,
                ),
                mock.patch.object(lifecycle, "_commit_uninstall", new=mock.AsyncMock(return_value=False)),
            ):
                await lifecycle._dispatch(
                    mock.sentinel.websocket,
                    connection,
                    proposal,
                    send,
                    "a" * 32,
                )
            self.assertEqual(send.await_args.args[1], lifecycle._history_error())

            for message, now in (("yes", 10_000.0), ("não", 10.0)):
                connection = _connection(
                    lifecycle_proposal=proposal,
                    admitted_history_id="a" * 32,
                )
                send = mock.AsyncMock(return_value=True)
                with (
                    mock.patch.object(lifecycle, "monotonic", return_value=now),
                    mock.patch.object(lifecycle, "_commit_uninstall", new=mock.AsyncMock(return_value=False)),
                ):
                    self.assertTrue(
                        await lifecycle.resolve(
                            mock.sentinel.websocket,
                            connection,
                            "team_1",
                            {"message": message, "files": []},
                            send,
                        )
                    )
                self.assertEqual(send.await_args.args[1], lifecycle._history_error())

        asyncio.run(scenario())

    def test_expired_cancelled_and_file_confirmation_resolution_is_exact(self) -> None:
        async def scenario() -> None:
            send = mock.AsyncMock(return_value=True)
            proposal = _proposal()

            connection = _connection(lifecycle_proposal=proposal)
            with mock.patch.object(lifecycle, "monotonic", return_value=10.0):
                self.assertFalse(
                    await lifecycle.resolve(
                        mock.sentinel.websocket,
                        connection,
                        "team_1",
                        {"message": "yes", "files": ["file"]},
                        send,
                    )
                )

            connection.lifecycle_proposal = proposal
            with mock.patch.object(lifecycle, "monotonic", return_value=10_000.0):
                self.assertTrue(
                    await lifecycle.resolve(
                        mock.sentinel.websocket,
                        connection,
                        "team_1",
                        {"message": "yes", "files": []},
                        send,
                    )
                )
            self.assertEqual(send.await_args.args[1]["state"], "expired")

            connection.lifecycle_proposal = proposal
            with mock.patch.object(lifecycle, "monotonic", return_value=10_000.0):
                self.assertFalse(
                    await lifecycle.resolve(
                        mock.sentinel.websocket,
                        connection,
                        "team_1",
                        {"message": "maybe", "files": []},
                        send,
                    )
                )

            connection.lifecycle_proposal = proposal
            with mock.patch.object(lifecycle, "monotonic", return_value=10.0):
                self.assertTrue(
                    await lifecycle.resolve(
                        mock.sentinel.websocket,
                        connection,
                        "team_1",
                        {"message": "não", "files": []},
                        send,
                    )
                )
            self.assertEqual(send.await_args.args[1]["state"], "cancelled")

        asyncio.run(scenario())

    def test_plan_submission_and_close_without_delivery_use_the_bounded_lane(self) -> None:
        sentinel = mock.sentinel.future
        plan = mock.Mock(spec=assistant_plan.Plan)
        stopped = threading.Event()
        progress = mock.Mock()
        with mock.patch.object(lifecycle, "submit_in_context", return_value=sentinel) as submit:
            self.assertIs(lifecycle.submit_plan(plan, stopped, progress), sentinel)
        submit.assert_called_once_with(lifecycle._LIFECYCLE_EXECUTOR, assistant_plan.execute, plan, stopped, progress)

        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            connection = _connection(lifecycle=lifecycle.Operation(_proposal(), future))
            await lifecycle.close(connection)
            self.assertTrue(future.cancelled())

        asyncio.run(scenario())

    def test_failed_uninstalling_event_closes_without_starting_work(self) -> None:
        async def scenario() -> None:
            connection = _connection()
            send_event = mock.AsyncMock(return_value=False)
            with mock.patch.object(lifecycle, "submit_in_context") as submit:
                await lifecycle._dispatch(mock.sentinel.websocket, connection, _proposal(), send_event)

            self.assertTrue(connection.closed)
            submit.assert_not_called()

        asyncio.run(scenario())

    def test_close_cancels_owned_destructive_work(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            delivery = asyncio.create_task(asyncio.sleep(10))
            operation = lifecycle.Operation(_proposal(), future, delivery)
            connection = _connection(lifecycle=operation)

            await lifecycle.close(connection)

            self.assertTrue(future.cancelled())
            self.assertTrue(delivery.cancelled())

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
