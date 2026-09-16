"""End-to-end backend delivery for one reconnect task resumption."""

from __future__ import annotations

import asyncio
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase
from tests.chat_socket_fixtures import Socket


class ChatTaskResumeTests(ChatWebSocketCase):
    def test_installs_for_the_prior_objective_and_dispatches_it_once(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            installed = tuple({**item, "status": "installed"} for item in self.assistant_plan.initial_items(plan))
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Task complete."},
            )
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_preparation",
                    return_value=self._future(self.assistant_plan.Preparation(plan)),
                ) as prepare,
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_plan",
                    return_value=self._future(self.assistant_plan.Result("installed", installed)),
                ),
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
            ):
                websocket = Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "resume-task",
                        "message": "Você mesmo consegue habilitar?",
                        "objective": "Lista minhas zonas DNS no Cloudflare",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                        "objective_assistant_ids": ["already-enabled"],
                    }
                )

                self.assertEqual((await websocket.next_json())["state"], "planned")
                self.assertEqual((await websocket.next_json())["state"], "installed")
                self.assertEqual((await websocket.next_json())["type"], "done")
                prepare.assert_called_once_with(
                    "team_1",
                    {
                        "message": "Lista minhas zonas DNS no Cloudflare",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                    },
                )
                turn.assert_called_once()
                self.assertEqual(
                    turn.call_args.args[1],
                    {
                        "message": "Lista minhas zonas DNS no Cloudflare",
                        "files": [],
                        "assistant_ids": ["already-enabled", "shimpz-cloudflare", "whatsapp"],
                    },
                )
                await websocket.disconnect()

        asyncio.run(scenario())
