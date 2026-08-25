"""Lifecycle edges for socket-scoped conversational Assistant installation."""

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

from chat import assistant_install, assistant_proposal, install, store_catalog


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
    return assistant_proposal.create_proposal(
        "team_1",
        _candidate(),
        now=1.0,
        proposal_id_factory=lambda: "b" * 32,
    )


def _connection(**changes):
    values = {"closed": False, "install_proposal": None, "install": None}
    values.update(changes)
    return SimpleNamespace(**values)


class ChatInstallLifecycleTests(unittest.TestCase):
    def test_discovery_saturation_is_optional(self) -> None:
        with mock.patch.object(install, "submit_in_context", side_effect=install.ExecutorSaturatedError):
            self.assertIsNone(
                install.submit_discovery(
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

            self.assertIs(await install.attach_proposal(connection, discovery, "Bad", event), event)
            self.assertIsNone(connection.install_proposal)

        asyncio.run(scenario())

    def test_delivery_fails_closed_for_an_invalid_worker_result(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(object())
            connection = _connection()
            operation = install.Operation(_proposal(), future)
            connection.install = operation
            operation.delivery = asyncio.current_task()
            events = []

            async def reject(_websocket, event) -> bool:
                events.append(event)
                return False

            await install._deliver(mock.sentinel.websocket, connection, operation, reject)

            self.assertEqual(events[0]["state"], "failed")
            self.assertEqual(events[0]["status"], 502)
            self.assertTrue(connection.closed)
            self.assertIsNone(connection.install)

        asyncio.run(scenario())

    def test_closed_connection_drops_a_completed_install(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(assistant_install.InstallResult(200, True))
            connection = _connection(closed=True)
            operation = install.Operation(_proposal(), future)
            connection.install = operation
            send_event = mock.AsyncMock(return_value=True)

            await install._deliver(mock.sentinel.websocket, connection, operation, send_event)

            send_event.assert_not_awaited()
            self.assertIs(connection.install, operation)

        asyncio.run(scenario())

    def test_failed_installing_event_closes_without_starting_work(self) -> None:
        async def scenario() -> None:
            connection = _connection()
            send_event = mock.AsyncMock(return_value=False)
            with mock.patch.object(install, "submit_in_context") as submit:
                await install._dispatch(mock.sentinel.websocket, connection, _proposal(), send_event)

            self.assertTrue(connection.closed)
            submit.assert_not_called()

        asyncio.run(scenario())

    def test_ambiguous_expired_decision_returns_to_ordinary_chat(self) -> None:
        async def scenario() -> None:
            connection = _connection(install_proposal=_proposal())
            with mock.patch.object(install, "monotonic", return_value=500.0):
                handled = await install.resolve(
                    mock.sentinel.websocket,
                    connection,
                    "team_1",
                    {"message": "talvez", "files": []},
                    mock.AsyncMock(return_value=True),
                )

            self.assertFalse(handled)
            self.assertIsNone(connection.install_proposal)

        asyncio.run(scenario())

    def test_close_cancels_owned_work_with_or_without_delivery(self) -> None:
        async def scenario() -> None:
            without_delivery: concurrent.futures.Future[object] = concurrent.futures.Future()
            connection = _connection(install=install.Operation(_proposal(), without_delivery))
            await install.close(connection)
            self.assertTrue(without_delivery.cancelled())

            with_delivery: concurrent.futures.Future[object] = concurrent.futures.Future()
            delivery = asyncio.create_task(asyncio.sleep(10))
            operation = install.Operation(_proposal(), with_delivery, delivery)
            connection = _connection(install=operation)
            await install.close(connection)
            self.assertTrue(with_delivery.cancelled())
            self.assertTrue(delivery.cancelled())

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
