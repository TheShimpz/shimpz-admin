"""Socket-scoped automatic preparation and destructive lifecycle edges."""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assistant_proposal, assistant_uninstall, lifecycle


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
    values = {"closed": False, "lifecycle_proposal": None, "lifecycle": None}
    values.update(changes)
    return SimpleNamespace(**values)


class ChatLifecycleTests(unittest.TestCase):
    def test_discovery_and_preparation_saturation_are_optional(self) -> None:
        with mock.patch.object(
            lifecycle,
            "submit_in_context",
            side_effect=lifecycle.ExecutorSaturatedError,
        ):
            self.assertIsNone(
                lifecycle.submit_discovery(
                    "team_1",
                    {"message": "Desinstale o Cloudflare", "assistant_ids": []},
                )
            )
            self.assertIsNone(
                lifecycle.submit_preparation(
                    "team_1",
                    {"message": "Configure Cloudflare", "assistant_ids": []},
                )
            )

    def test_only_explicit_uninstall_intent_enters_destructive_discovery(self) -> None:
        selected = assistant_proposal.UninstallCandidate(_proposal().assistant, "0.4.4")
        with mock.patch.object(assistant_uninstall, "discover", return_value=selected) as discover:
            result = lifecycle._discover(
                "team_1",
                {"message": "Desinstale o Shimpz Cloudflare", "assistant_ids": []},
            )
            ordinary = lifecycle._discover(
                "team_1",
                {"message": "Configure Cloudflare", "assistant_ids": []},
            )

        self.assertEqual(result, selected)
        self.assertIsNone(ordinary)
        discover.assert_called_once_with("team_1", "Desinstale o Shimpz Cloudflare")

    def test_uninstall_events_expose_only_bounded_team_identity(self) -> None:
        proposal = _proposal()

        self.assertEqual(
            lifecycle._proposal_event(proposal, {"reply": "Vou preparar a remoção."}),
            {
                "type": "assistant-uninstall",
                "state": "proposed",
                "proposal_id": "c" * 32,
                "team_id": "team_1",
                "reply": "Vou preparar a remoção.",
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
            self.assertIsNone(connection.lifecycle)

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
