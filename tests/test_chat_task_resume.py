"""End-to-end backend delivery for one reconnect task resumption."""

from __future__ import annotations

import asyncio
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase
from tests.chat_socket_fixtures import chat_frame, completed_turn


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
                websocket = await self._open()
                await websocket.send_json(
                    {
                        "type": "resume-task",
                        "message": "Você mesmo consegue habilitar?",
                        "objective": "Instale um Assistant",
                        "files": [],
                        "assistant_ids": [],
                        "objective_assistant_ids": [],
                        "locale": "en",
                        "timezone": None,
                        "request": None,
                    }
                )

                self.assertEqual((await websocket.next_json())["reply"], guidance.reply)
                await websocket.send_json(chat_frame("cloudflare"))
                self.assertEqual((await websocket.next_json())["reply"], follow_up.reply)
                context = route.call_args.args[2]
                self.assertEqual(
                    [(entry.role, entry.text) for entry in context.conversation],
                    [
                        ("user", "Você mesmo consegue habilitar?"),
                        ("assistant", "Qual Assistant você quer instalar?"),
                    ],
                )
                self.assertEqual(route.call_args.args[1]["locale"], "en")
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_installs_for_the_prior_objective_and_dispatches_it_once(self) -> None:
        # The window ends before the continuation row, so it quotes the original objective and the capability reply;
        # the objective still reaches Team exactly once, as the turn's message.
        window = (
            self.chat_socket.local.conversation_context.Entry("user", "Lista minhas zonas DNS no Cloudflare", False),
            self.chat_socket.local.conversation_context.Entry(
                "assistant", "Preciso do Assistant Cloudflare para isso.", False
            ),
        )

        async def scenario() -> None:
            plan = self._automatic_plan()
            installed = tuple({**item, "status": "installed"} for item in self.assistant_plan.initial_items(plan))
            response = completed_turn("Task complete.")
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
                mock.patch("history.delivery.conversation", new=mock.AsyncMock(return_value=window)) as projected,
            ):
                websocket = await self._open()
                await websocket.send_json(
                    {
                        "type": "resume-task",
                        "message": "Você mesmo consegue habilitar?",
                        "objective": "Lista minhas zonas DNS no Cloudflare",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                        "objective_assistant_ids": ["already-enabled"],
                        "locale": "en",
                        "timezone": None,
                        "request": None,
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
                        "locale": "en",
                        "timezone": None,
                    },
                )
                turn.assert_called_once()
                self.assertEqual(
                    turn.call_args.args[1],
                    {
                        "message": "Lista minhas zonas DNS no Cloudflare",
                        "files": [],
                        "assistant_ids": ["already-enabled", "shimpz-cloudflare", "whatsapp"],
                        "locale": "en",
                        "timezone": None,
                    },
                )
                self.assertEqual(turn.call_args.args[2], window)
                projected.assert_awaited_once()
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
                websocket = await self._open()
                await websocket.send_json(
                    {
                        "type": "resume-task",
                        "message": "Você mesmo consegue habilitar?",
                        "objective": "Instale Cloudflare e WhatsApp",
                        "files": [],
                        "assistant_ids": [],
                        "objective_assistant_ids": [],
                        "locale": "en",
                        "timezone": None,
                        "request": None,
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


class ChatConversationWindowTests(ChatWebSocketCase):
    def test_a_direct_turn_carries_the_committed_history_before_its_user_row(self) -> None:
        async def scenario() -> None:
            replies = iter(("Your zones are example.com.", "Done."))

            def turn(_team_id, _payload, _conversation, _request, _progress):
                return completed_turn(next(replies))

            with mock.patch.object(self.chat_socket.local, "turn", side_effect=turn) as sent:
                websocket = await self._open()
                await websocket.send_json(chat_frame("List my zones"))
                self.assertEqual((await websocket.next_json())["type"], "done")
                await websocket.send_json(chat_frame("And the first one?"))
                self.assertEqual((await websocket.next_json())["type"], "done")
                await websocket.disconnect()

            first, second = sent.call_args_list
            self.assertEqual(first.args[2], ())
            self.assertEqual(
                [(entry.role, entry.text) for entry in second.args[2]],
                [("user", "List my zones"), ("assistant", "Your zones are example.com.")],
            )

        asyncio.run(scenario())
