"""End-to-end backend delivery for one reconnect task resumption."""

from __future__ import annotations

import asyncio
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase
from tests.chat_socket_fixtures import Socket


class ChatTaskResumeTests(ChatWebSocketCase):
    def test_directional_guidance_preserves_the_resume_objective_language(self) -> None:
        async def scenario() -> None:
            guidance = self.assistant_route.Guidance(
                "assistant-install-target-required",
                "Qual Assistant você quer instalar?",
            )
            follow_up = self.assistant_route.Guidance(
                "assistant-install-target-required",
                "Qual deles você quer instalar?",
            )
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_resume",
                    return_value=self._future(self.assistant_route.Result("assistant-install", guidance=guidance)),
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    return_value=self._future(self.assistant_route.Result("assistant-install", guidance=follow_up)),
                ) as route,
            ):
                websocket = Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "resume-task",
                        "message": "Você mesmo consegue habilitar?",
                        "objective": "Instale um Assistant",
                        "files": [],
                        "assistant_ids": [],
                        "objective_assistant_ids": [],
                    }
                )

                self.assertEqual((await websocket.next_json())["reply"], guidance.reply)
                await websocket.send_json({"type": "chat", "message": "cloudflare", "files": [], "assistant_ids": []})
                self.assertEqual((await websocket.next_json())["reply"], follow_up.reply)
                context = route.call_args.args[2]
                self.assertEqual(
                    [(entry.role, entry.text) for entry in context.conversation],
                    [
                        ("user", "Você mesmo consegue habilitar?"),
                        ("assistant", "Qual Assistant você quer instalar?"),
                    ],
                )
                self.assertEqual(context.selection_language_exemplar, "Você mesmo consegue habilitar?")
                await websocket.disconnect()

        asyncio.run(scenario())

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
                    "submit_resume",
                    return_value=self._future(
                        self.assistant_route.Result(
                            "ordinary-task",
                            preparation=self.assistant_plan.Preparation(plan),
                        )
                    ),
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

    def test_exact_install_resume_terminates_without_a_brain_turn(self) -> None:
        async def scenario() -> None:
            original = self._automatic_plan()
            plan = self.assistant_plan.Plan(
                original.plan_id,
                original.team_id,
                original.assistants,
                original.dispatch_ids,
                True,
            )
            installed = tuple({**item, "status": "installed"} for item in self.assistant_plan.initial_items(plan))
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_resume",
                    return_value=self._future(
                        self.assistant_route.Result(
                            "assistant-install",
                            preparation=self.assistant_plan.Preparation(plan),
                        )
                    ),
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_plan",
                    return_value=self._future(self.assistant_plan.Result("installed", installed)),
                ),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "resume-task",
                        "message": "Você mesmo consegue habilitar?",
                        "objective": "Instale Cloudflare e WhatsApp",
                        "files": [],
                        "assistant_ids": [],
                        "objective_assistant_ids": [],
                    }
                )

                self.assertEqual((await websocket.next_json())["state"], "planned")
                completed = await websocket.next_json()
                self.assertEqual(
                    (completed["state"], completed["continuation"]),
                    ("installed", "none"),
                )
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())
