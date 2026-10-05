"""Authoritative current-state contracts for Assistant installation chat turns."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase

from tests import chat_socket_fixtures


class ChatInstallStateTests(ChatWebSocketCase):
    def test_explicit_install_only_plan_is_terminal_without_a_brain_turn(self) -> None:
        async def scenario(message: str, provenance: str) -> None:
            plan = self._automatic_plan()
            assistant = plan.assistants[0]
            if provenance == "local":
                assistant = self.assistant_plan.local_catalog.LocalAssistant(
                    assistant_id=assistant.assistant_id,
                    name=assistant.name,
                    summary=assistant.summary,
                    image_id="sha256:" + ("c" * 64),
                    integrations=assistant.integrations,
                    actions=assistant.actions,
                    assistant_version="0.4.5",
                    created_at=datetime(2026, 9, 19, tzinfo=UTC),
                )
            plan = self.assistant_plan.Plan(
                plan.plan_id,
                plan.team_id,
                (assistant,),
                ("shimpz-cloudflare",),
                True,
                ("shimpz-cloudflare",),
            )
            installed = tuple({**item, "status": "installed"} for item in self.assistant_plan.initial_items(plan))
            response = chat_socket_fixtures.completed_turn("Olá.")
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    side_effect=(
                        self._route_future(self.assistant_plan.Preparation(plan), "assistant-install"),
                        self._route_future(self.assistant_plan.Preparation()),
                    ),
                ) as route,
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_plan",
                    return_value=self._future(self.assistant_plan.Result("installed", installed)),
                ),
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame(message))

                planned = await websocket.next_json()
                self.assertEqual(planned["state"], "planned")
                self.assertEqual(planned["assistants"][0]["provenance"], provenance)
                completed = await websocket.next_json()
                self.assertEqual((completed["state"], completed["continuation"]), ("installed", "none"))
                turn.assert_not_called()

                await websocket.send_json(chat_socket_fixtures.chat_frame("Olá"))
                self.assertEqual((await websocket.next_json())["type"], "done")
                reference = route.call_args_list[1].args[2].reference
                self.assertEqual(reference.assistant_id, "shimpz-cloudflare")
                self.assertEqual(reference.name, "Shimpz Cloudflare")
                turn.assert_called_once()
                await websocket.disconnect()

        for message in ("instala o cloudflare", "agora instale o cloudflare"):
            for provenance in ("published", "local"):
                with self.subTest(message=message, provenance=provenance):
                    asyncio.run(scenario(message, provenance))

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
            preparation = self._route_future(
                self.assistant_plan.Preparation(already_installed=result),
                "assistant-install",
            )
            response = chat_socket_fixtures.completed_turn("Done.")
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    side_effect=(preparation, self._route_future(self.assistant_plan.Preparation())),
                ) as route,
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan") as submit_plan,
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("instala o cloudflare"))

                self.assertEqual(
                    await websocket.next_json(),
                    self.assistant_plan.already_installed_event(result),
                )
                submit_plan.assert_not_called()
                turn.assert_not_called()

                await websocket.send_json(chat_socket_fixtures.chat_frame("liste as zonas"))
                self.assertEqual((await websocket.next_json())["type"], "done")
                reference = route.call_args_list[1].args[2].reference
                self.assertEqual(reference.assistant_id, "shimpz-cloudflare")
                self.assertEqual(reference.name, "Shimpz Cloudflare")
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
                True,
            )
            installed = tuple({**item, "status": "installed"} for item in self.assistant_plan.initial_items(plan))
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    return_value=self._route_future(
                        self.assistant_plan.Preparation(plan),
                        "assistant-install",
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
                await websocket.send_json(chat_socket_fixtures.chat_frame("instale o cloudflare e o whatsapp"))

                self.assertEqual((await websocket.next_json())["state"], "planned")
                terminal = await websocket.next_json()
                self.assertEqual((terminal["state"], terminal["continuation"]), ("installed", "none"))
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())
