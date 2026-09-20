"""Authoritative current-state contracts for Assistant installation chat turns."""

from __future__ import annotations

import asyncio
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase

from tests import chat_socket_fixtures

_Socket = chat_socket_fixtures.Socket


class ChatInstallStateTests(ChatWebSocketCase):
    def test_repeated_exact_install_reports_current_state_without_brain_or_install(self) -> None:
        async def scenario() -> None:
            result = self.assistant_plan.AlreadyInstalled(
                "f" * 32,
                "team_1",
                (
                    {
                        "id": "shimpz-cloudflare",
                        "name": "Shimpz Cloudflare",
                        "summary": "Manage Cloudflare zones and DNS records.",
                        "providers": [],
                        "provenance": "local",
                        "status": "installed",
                    },
                ),
            )
            preparation = self._future(self.assistant_plan.Preparation(already_installed=result))
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_preparation",
                    return_value=preparation,
                ),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan") as submit_plan,
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "instala o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )

                self.assertEqual(
                    await websocket.next_json(),
                    self.assistant_plan.already_installed_event(result),
                )
                submit_plan.assert_not_called()
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_mixed_current_and_fresh_exact_install_terminates_without_brain(self) -> None:
        async def scenario() -> None:
            complete = self._automatic_plan()
            plan = self.assistant_plan.Plan(
                complete.plan_id,
                complete.team_id,
                (complete.assistants[1],),
                ("shimpz-cloudflare", "whatsapp"),
                complete.assistants,
            )
            installed = tuple(
                {**item, "status": "installed"} for item in self.assistant_plan.initial_items(plan)
            )
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_preparation",
                    return_value=self._future(self.assistant_plan.Preparation(plan)),
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_plan",
                    return_value=self._future(self.assistant_plan.Result("installed", installed)),
                ),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "instale o cloudflare e o whatsapp",
                        "files": [],
                        "assistant_ids": [],
                    }
                )

                self.assertEqual((await websocket.next_json())["state"], "planned")
                terminal = await websocket.next_json()
                self.assertEqual((terminal["state"], terminal["continuation"]), ("installed", "none"))
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())
