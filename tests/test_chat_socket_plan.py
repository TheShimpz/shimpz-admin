"""Capability-plan contracts of the local Admin chat WebSocket: install, continue, stop, and capacity."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import threading
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase

from tests import chat_socket_fixtures

_Socket = chat_socket_fixtures.Socket
_wait_for_thread = chat_socket_fixtures.wait_for_thread


class ChatWebSocketPlanTests(ChatWebSocketCase):
    def test_automatic_composed_plan_installs_then_dispatches_the_original_task_once(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            installed = tuple({**item, "status": "installed"} for item in self.assistant_plan.initial_items(plan))
            preparation = self._route_future(self.assistant_plan.Preparation(plan))
            job = self._future(self.assistant_plan.Result("installed", installed))
            response = self.chat_socket.local.PublicResponse(
                200,
                {
                    "team_id": "team_1",
                    "team_name": "Marketing",
                    "reply": "Task complete.",
                    "clarification": None,
                },
            )
            with (
                mock.patch.object(self.chat_socket.lifecycle, "submit_route", return_value=preparation),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan", return_value=job) as submit_plan,
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                        "locale": "en",
                        "timezone": None,
                    }
                )

                planned = await websocket.next_json()
                completed = await websocket.next_json()
                done = await websocket.next_json()

                self.assertEqual((planned["type"], planned["state"]), ("assistant-install-plan", "planned"))
                self.assertEqual((completed["type"], completed["state"]), ("assistant-install-plan", "installed"))
                self.assertEqual(completed["continuation"], "dispatch")
                self.assertEqual(done["type"], "done")
                self.assertNotIn("source_digest", json.dumps((planned, completed)))
                submit_plan.assert_called_once()
                self.assertIs(submit_plan.call_args.args[0], plan)
                self.assertEqual(turn.call_count, 1)
                dispatched = turn.call_args.args[1]
                self.assertEqual(dispatched["message"], "Configure Cloudflare e envie WhatsApp")
                self.assertEqual(
                    dispatched["assistant_ids"],
                    ["already-enabled", "shimpz-cloudflare", "whatsapp"],
                )
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_no_capability_gap_dispatches_directly_without_a_plan_event(self) -> None:
        async def scenario() -> None:
            response = self.chat_socket.local.PublicResponse(
                200,
                {
                    "team_id": "team_1",
                    "team_name": "Marketing",
                    "reply": "Done.",
                    "clarification": None,
                },
            )
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    return_value=self._route_future(self.assistant_plan.Preparation()),
                ),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan") as submit_plan,
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Resuma esta conversa",
                        "files": [],
                        "assistant_ids": [],
                        "locale": "en",
                        "timezone": None,
                    }
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Done.",
                        "clarification": None,
                    },
                )
                submit_plan.assert_not_called()
                turn.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_targetless_uninstall_requests_a_name_without_brain_or_inventory_discovery(self) -> None:
        async def scenario() -> None:
            response = self.chat_socket.local.PublicResponse(
                200,
                {
                    "team_id": "team_1",
                    "team_name": "Marketing",
                    "reply": "Tudo certo.",
                    "clarification": None,
                },
            )
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    side_effect=(
                        self._future(
                            self.assistant_route.Result(
                                "assistant-uninstall",
                                guidance=self.assistant_route.Guidance(
                                    "assistant-uninstall-target-required",
                                    "Qual Assistant instalado você quer desinstalar?",
                                ),
                            )
                        ),
                        self._route_future(self.assistant_plan.Preparation()),
                    ),
                ) as route,
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale",
                        "files": [],
                        "assistant_ids": [],
                        "locale": "en",
                        "timezone": None,
                    }
                )

                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "assistant-guidance",
                        "team_id": "team_1",
                        "code": "assistant-uninstall-target-required",
                        "reply": "Qual Assistant instalado você quer desinstalar?",
                    },
                )
                self.assertEqual(route.call_count, 1)
                turn.assert_not_called()

                await websocket.send_json({"type": "stop"})
                await websocket.send_json({"type": "stop"})
                self.assertEqual((await websocket.next_json())["status"], 409)
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "ok",
                        "files": [],
                        "assistant_ids": [],
                        "locale": "en",
                        "timezone": None,
                    }
                )
                self.assertEqual((await websocket.next_json())["type"], "done")
                turn.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_partial_plan_failure_never_dispatches_the_task_or_rolls_back_success(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            items = list(self.assistant_plan.initial_items(plan))
            items[0] = {**items[0], "status": "installed"}
            items[1] = {**items[1], "status": "failed"}
            preparation = self._route_future(self.assistant_plan.Preparation(plan))
            job = self._future(self.assistant_plan.Result("failed", tuple(items), 503))
            with (
                mock.patch.object(self.chat_socket.lifecycle, "submit_route", return_value=preparation),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan", return_value=job),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                        "locale": "en",
                        "timezone": None,
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                failed = await websocket.next_json()
                self.assertEqual(
                    (failed["type"], failed["state"], failed["status"]),
                    (
                        "assistant-install-plan",
                        "failed",
                        503,
                    ),
                )
                self.assertEqual(
                    [item["status"] for item in failed["assistants"]],
                    ["installed", "failed"],
                )
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_stop_during_a_plan_prevents_the_next_item_and_task_dispatch(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            preparation = self._route_future(self.assistant_plan.Preparation(plan))
            job: concurrent.futures.Future = concurrent.futures.Future()
            worker_finished = threading.Event()

            def submit(_plan, stopped, _progress):
                def finish() -> None:
                    stopped.wait(timeout=2)
                    items = list(self.assistant_plan.initial_items(plan))
                    items[0] = {**items[0], "status": "installed"}
                    job.set_result(self.assistant_plan.Result("stopped", tuple(items)))
                    worker_finished.set()

                threading.Thread(target=finish, daemon=True).start()
                return job

            with (
                mock.patch.object(self.chat_socket.lifecycle, "submit_route", return_value=preparation),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan", side_effect=submit),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                        "locale": "en",
                        "timezone": None,
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                await websocket.send_json({"type": "stop"})
                stopped = await websocket.next_json()
                self.assertEqual((stopped["type"], stopped["state"]), ("assistant-install-plan", "stopped"))
                self.assertEqual(
                    [item["status"] for item in stopped["assistants"]],
                    ["installed", "pending"],
                )
                await _wait_for_thread(worker_finished)
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_completed_plan_continues_into_the_team_owned_integration_gate(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            items = tuple({**item, "status": "installed"} for item in self.assistant_plan.initial_items(plan))
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    return_value=self._route_future(self.assistant_plan.Preparation(plan)),
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_plan",
                    return_value=self._future(self.assistant_plan.Result("installed", items)),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=chat_socket_fixtures.integration_challenge(),
                ) as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                        "locale": "en",
                        "timezone": None,
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                self.assertEqual((await websocket.next_json())["state"], "installed")
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")
                turn.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_disconnect_discards_unstarted_plan_items_and_never_replays_the_task(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            preparation = self._route_future(self.assistant_plan.Preparation(plan))
            job: concurrent.futures.Future = concurrent.futures.Future()
            stopped_seen = threading.Event()

            def submit(_plan, stopped, _progress):
                def finish() -> None:
                    stopped.wait(timeout=2)
                    stopped_seen.set()
                    job.set_result(
                        self.assistant_plan.Result(
                            "stopped",
                            self.assistant_plan.initial_items(plan),
                        )
                    )

                threading.Thread(target=finish, daemon=True).start()
                return job

            with (
                mock.patch.object(self.chat_socket.lifecycle, "submit_route", return_value=preparation),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan", side_effect=submit),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                        "locale": "en",
                        "timezone": None,
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                await websocket.disconnect()
                await _wait_for_thread(stopped_seen)
                turn.assert_not_called()

                reconnect = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await reconnect.start()))
                await asyncio.sleep(0)
                turn.assert_not_called()
                await reconnect.disconnect()

        asyncio.run(scenario())

    def test_plan_capacity_failure_happens_after_projection_but_before_team_dispatch(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    return_value=self._route_future(self.assistant_plan.Preparation(plan)),
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_plan",
                    side_effect=self.chat_socket.ExecutorSaturatedError,
                ),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                        "locale": "en",
                        "timezone": None,
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                failed = await websocket.next_json()
                self.assertEqual((failed["state"], failed["status"]), ("failed", 429))
                self.assertTrue(all(item["status"] == "pending" for item in failed["assistants"]))
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())
