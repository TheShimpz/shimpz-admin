"""Lifecycle edges for socket-scoped conversational Assistant changes."""

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

from chat import assistant_install, assistant_proposal, assistant_uninstall, lifecycle, store_catalog


def _candidate() -> store_catalog.CatalogAssistant:
    return store_catalog.CatalogAssistant(
        assistant_id="shimpz-cloudflare",
        name="Shimpz Cloudflare",
        summary="Manage Cloudflare zones and DNS records.",
        source_digest="sha256:" + ("a" * 64),
        icon_digest="sha256:" + ("b" * 64),
        integrations=(store_catalog.CatalogIntegration("cloudflare", ("zone.read",)),),
        actions=("list-zones",),
    )


def _proposal() -> assistant_proposal.InstallProposal:
    return assistant_proposal.create_install_proposal(
        "team_1",
        _candidate(),
        language_exemplar="Liste minhas zonas DNS",
        now=1.0,
        proposal_id_factory=lambda: "b" * 32,
    )


def _uninstall_proposal() -> assistant_proposal.UninstallProposal:
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


class ChatInstallLifecycleTests(unittest.TestCase):
    def test_install_then_label_keeps_the_original_objective_and_exact_labels(self) -> None:
        installed = assistant_install.InstallResult(200, True)
        response = assistant_install.team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "assistant": "shimpz-cloudflare",
                "assistant_version": "0.4.4",
                "actions": [{"id": "list-zones", "label": "Listar zonas DNS"}],
            },
        )
        with (
            mock.patch.object(assistant_install, "install", return_value=installed),
            mock.patch.object(lifecycle.local, "installed_action_labels", return_value=response) as labels,
        ):
            result = lifecycle._install_then_label(_proposal())

        self.assertEqual(
            result.labels,
            assistant_install.ActionLabels(
                "0.4.4",
                (assistant_install.ActionLabel("list-zones", "Listar zonas DNS"),),
            ),
        )
        labels.assert_called_once_with(
            "team_1",
            "shimpz-cloudflare",
            "Liste minhas zonas DNS",
        )

    def test_action_label_failure_never_rewrites_a_completed_install(self) -> None:
        installed = assistant_install.InstallResult(200, True)
        with (
            mock.patch.object(assistant_install, "install", return_value=installed),
            mock.patch.object(
                lifecycle.local,
                "installed_action_labels",
                side_effect=RuntimeError("unavailable"),
            ),
        ):
            self.assertIs(lifecycle._install_then_label(_proposal()), installed)

    def test_action_label_timeout_response_never_delays_install_success_semantics(self) -> None:
        installed = assistant_install.InstallResult(200, True)
        unavailable = assistant_install.team.TeamResponse(502, {"detail": "team unavailable"})
        with (
            mock.patch.object(assistant_install, "install", return_value=installed),
            mock.patch.object(lifecycle.local, "installed_action_labels", return_value=unavailable),
        ):
            self.assertIs(lifecycle._install_then_label(_proposal()), installed)

    def test_discovery_saturation_is_optional(self) -> None:
        with mock.patch.object(
            lifecycle,
            "submit_in_context",
            side_effect=lifecycle.ExecutorSaturatedError,
        ):
            self.assertIsNone(
                lifecycle.submit_discovery(
                    "team_1",
                    {"message": "Cloudflare", "assistant_ids": []},
                )
            )

    def test_invalid_team_scope_cannot_create_a_proposal(self) -> None:
        async def scenario() -> None:
            discovery: concurrent.futures.Future[object] = concurrent.futures.Future()
            discovery.set_result(_candidate())
            connection = _connection()
            event = {"type": "done", "reply": "Ready."}

            self.assertIs(
                await lifecycle.attach_proposal(
                    connection,
                    discovery,
                    "Bad",
                    event,
                    language_exemplar="Liste minhas zonas DNS",
                ),
                event,
            )
            self.assertIsNone(connection.lifecycle_proposal)

        asyncio.run(scenario())


class ChatLifecycleExecutionTests(unittest.TestCase):
    def test_explicit_uninstall_discovery_never_falls_through_to_store_install(self) -> None:
        candidate = _uninstall_proposal()
        selected = assistant_proposal.UninstallCandidate(candidate.assistant, candidate.assistant_version)
        with (
            mock.patch.object(assistant_uninstall, "discover", return_value=selected) as uninstall,
            mock.patch.object(assistant_install, "discover") as install,
        ):
            result = lifecycle._discover(
                "team_1",
                {"message": "Desinstale o Shimpz Cloudflare", "assistant_ids": []},
            )

        self.assertEqual(result, selected)
        uninstall.assert_called_once_with("team_1", "Desinstale o Shimpz Cloudflare")
        install.assert_not_called()

    def test_proposal_and_success_events_expose_only_bounded_team_identity(self) -> None:
        proposal = _uninstall_proposal()

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

    def test_install_words_cannot_confirm_uninstall_but_yes_uses_the_same_frame_path(self) -> None:
        async def scenario() -> None:
            connection = _connection(lifecycle_proposal=_uninstall_proposal())
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
            self.assertIsNone(connection.lifecycle_proposal)

            connection.lifecycle_proposal = _uninstall_proposal()
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

    def test_uninstall_worker_failure_is_never_projected_as_success(self) -> None:
        event = lifecycle._result_event(
            _uninstall_proposal(),
            assistant_uninstall.UninstallResult(503),
        )

        self.assertEqual(event["state"], "failed")
        self.assertEqual(event["status"], 503)

    def test_delivery_fails_closed_for_an_invalid_worker_result(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(object())
            connection = _connection()
            operation = lifecycle.Operation(_proposal(), future)
            connection.lifecycle = operation
            operation.delivery = asyncio.current_task()
            events = []

            async def reject(_websocket, event) -> bool:
                events.append(event)
                return False

            await lifecycle._deliver(mock.sentinel.websocket, connection, operation, reject)

            self.assertEqual(events[0]["state"], "failed")
            self.assertEqual(events[0]["status"], 502)
            self.assertTrue(connection.closed)
            self.assertIsNone(connection.lifecycle)

        asyncio.run(scenario())

    def test_closed_connection_drops_a_completed_install(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(assistant_install.InstallResult(200, True))
            connection = _connection(closed=True)
            operation = lifecycle.Operation(_proposal(), future)
            connection.lifecycle = operation
            send_event = mock.AsyncMock(return_value=True)

            await lifecycle._deliver(mock.sentinel.websocket, connection, operation, send_event)

            send_event.assert_not_awaited()
            self.assertIs(connection.lifecycle, operation)

        asyncio.run(scenario())

    def test_delivery_emits_only_the_version_bound_action_projection(self) -> None:
        async def scenario() -> None:
            labels = assistant_install.ActionLabels(
                "0.4.4",
                (assistant_install.ActionLabel("list-zones", "Listar zonas DNS"),),
            )
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(assistant_install.InstallResult(200, True, labels))
            connection = _connection()
            operation = lifecycle.Operation(_proposal(), future)
            connection.lifecycle = operation
            operation.delivery = asyncio.current_task()
            events = []

            async def collect(_websocket, event) -> bool:
                events.append(event)
                return True

            await lifecycle._deliver(mock.sentinel.websocket, connection, operation, collect)

            self.assertEqual(
                events,
                [
                    {
                        "type": "assistant-install",
                        "state": "installed",
                        "proposal_id": "b" * 32,
                        "assistant_id": "shimpz-cloudflare",
                        "team_id": "team_1",
                        "installed": True,
                        "assistant_version": "0.4.4",
                        "actions": [{"id": "list-zones", "label": "Listar zonas DNS"}],
                    }
                ],
            )

        asyncio.run(scenario())

    def test_failed_installing_event_closes_without_starting_work(self) -> None:
        async def scenario() -> None:
            connection = _connection()
            send_event = mock.AsyncMock(return_value=False)
            with mock.patch.object(lifecycle, "submit_in_context") as submit:
                await lifecycle._dispatch(mock.sentinel.websocket, connection, _proposal(), send_event)

            self.assertTrue(connection.closed)
            submit.assert_not_called()

        asyncio.run(scenario())

    def test_ambiguous_expired_decision_returns_to_ordinary_chat(self) -> None:
        async def scenario() -> None:
            connection = _connection(lifecycle_proposal=_proposal())
            with mock.patch.object(lifecycle, "monotonic", return_value=500.0):
                handled = await lifecycle.resolve(
                    mock.sentinel.websocket,
                    connection,
                    "team_1",
                    {"message": "talvez", "files": []},
                    mock.AsyncMock(return_value=True),
                )

            self.assertFalse(handled)
            self.assertIsNone(connection.lifecycle_proposal)

        asyncio.run(scenario())

    def test_close_cancels_owned_work_with_or_without_delivery(self) -> None:
        async def scenario() -> None:
            without_delivery: concurrent.futures.Future[object] = concurrent.futures.Future()
            connection = _connection(lifecycle=lifecycle.Operation(_proposal(), without_delivery))
            await lifecycle.close(connection)
            self.assertTrue(without_delivery.cancelled())

            with_delivery: concurrent.futures.Future[object] = concurrent.futures.Future()
            delivery = asyncio.create_task(asyncio.sleep(10))
            operation = lifecycle.Operation(_proposal(), with_delivery, delivery)
            connection = _connection(lifecycle=operation)
            await lifecycle.close(connection)
            self.assertTrue(with_delivery.cancelled())
            self.assertTrue(delivery.cancelled())

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
