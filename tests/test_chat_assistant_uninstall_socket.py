"""Focused WebSocket projection for conversational Assistant uninstall."""

from __future__ import annotations

import asyncio
import concurrent.futures
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.mfa_helper import configure_supervisor

from tests import chat_socket_fixtures

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

_Socket = chat_socket_fixtures.Socket


class ChatAssistantUninstallSocketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        cls.root = Path(cls.tempdir.name)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(cls.root),
                "SHIMPZ_ADMIN_STORE": str(cls.root / "admin.json"),
                "SHIMPZ_ADMIN_PROFILE": "local",
                "SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777",
            },
        ):
            cls.admin_app = importlib.import_module("app")
        cls.chat_socket = importlib.import_module("chat.socket")
        cls.assistant_route = importlib.import_module("chat.assistant_route")
        cls.uninstall_delivery = importlib.import_module("chat.delivery.uninstall")
        previous_store = cls.admin_app.state.STORE_PATH
        previous_history_store = cls.admin_app.chat_history.STORE_PATH
        previous_origins = cls.chat_socket.STATIC_ORIGINS
        cls.admin_app.state.STORE_PATH = cls.root / "admin.json"
        cls.admin_app.chat_history.STORE_PATH = cls.root / "chat-history.sqlite3"
        cls.chat_socket.STATIC_ORIGINS = frozenset({"http://localhost:7777", "http://127.0.0.1:7777"})
        cls.addClassCleanup(setattr, cls.admin_app.state, "STORE_PATH", previous_store)
        cls.addClassCleanup(setattr, cls.admin_app.chat_history, "STORE_PATH", previous_history_store)
        cls.addClassCleanup(setattr, cls.chat_socket, "STATIC_ORIGINS", previous_origins)

    def setUp(self) -> None:
        self.admin_app.state.STORE_PATH.unlink(missing_ok=True)
        self.admin_app.chat_history.STORE_PATH.unlink(missing_ok=True)
        secret = configure_supervisor(self.admin_app.state, "violet otter lantern quartz 92")
        self.token = self.admin_app.auth.issue_session(secret, "totp")

    def _uninstall_candidate(self):
        return self.chat_socket.lifecycle.assistant_proposal.UninstallCandidate(
            self.chat_socket.lifecycle.assistant_proposal.Capability(
                "shimpz-cloudflare",
                "Shimpz Cloudflare",
                "Manage Cloudflare zones and DNS records.",
                ("list-zones",),
            ),
            "0.4.4",
        )

    @staticmethod
    def _future(value=None, error: Exception | None = None):
        future: concurrent.futures.Future[object] = concurrent.futures.Future()
        if error is None:
            future.set_result(value)
        else:
            future.set_exception(error)
        return future

    @staticmethod
    def _accepted(message: dict) -> bool:
        return message == {
            "type": "websocket.accept",
            "subprotocol": "shimpz.chat.v7",
            "headers": [],
        }

    def test_explicit_uninstall_uses_one_socket_scoped_proposal_and_team_result(self) -> None:
        async def scenario() -> None:
            route: concurrent.futures.Future[object] = concurrent.futures.Future()

            result = self.chat_socket.lifecycle.assistant_uninstall.UninstallResult(200, True)
            with (
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    return_value=route,
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle.assistant_uninstall,
                    "uninstall",
                    return_value=result,
                ) as uninstall,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Desinstala o Cloudflare",
                        "files": [],
                        "assistant_ids": ["shimpz-cloudflare"],
                    }
                )
                await asyncio.sleep(0.3)
                turn.assert_not_called()
                route.set_result(
                    self.assistant_route.Result(
                        "assistant-uninstall",
                        uninstall=self._uninstall_candidate(),
                    )
                )
                proposed = await websocket.next_json()
                self.assertEqual(proposed["type"], "assistant-uninstall")
                self.assertEqual(proposed["state"], "proposed")
                self.assertEqual(proposed["expires_in"], 120)
                self.assertEqual(
                    proposed["assistant"],
                    {
                        "id": "shimpz-cloudflare",
                        "name": "Shimpz Cloudflare",
                        "summary": "Manage Cloudflare zones and DNS records.",
                        "version": "0.4.4",
                    },
                )
                self.assertNotIn("source_digest", json.dumps(proposed))

                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Pode desinstalar!",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "assistant-uninstall",
                        "state": "uninstalling",
                        "proposal_id": proposed["proposal_id"],
                        "assistant_id": "shimpz-cloudflare",
                    },
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "assistant-uninstall",
                        "state": "uninstalled",
                        "proposal_id": proposed["proposal_id"],
                        "assistant_id": "shimpz-cloudflare",
                        "team_id": "team_1",
                        "uninstalled": True,
                    },
                )
                proposal = uninstall.call_args.args[0]
                self.assertEqual(proposal.assistant_version, "0.4.4")
                self.assertEqual(
                    proposal.language_exemplar,
                    "Desinstala o Cloudflare",
                )
                turn.assert_not_called()
                await websocket.disconnect()

            entries = self.admin_app.chat_history.page("team_1")["entries"]
            self.assertEqual(
                [(entry["kind"], entry.get("text")) for entry in entries],
                [
                    ("message", "Desinstala o Cloudflare"),
                    ("assistant-uninstall", None),
                ],
            )

        asyncio.run(scenario())

    def test_durable_conversation_resolves_uninstall_after_an_intervening_turn_and_new_socket(self) -> None:
        async def scenario() -> None:
            reply = "Qual Assistant instalado você quer desinstalar?"
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=self.chat_socket.local.PublicResponse(
                        200,
                        {
                            "team_id": "team_1",
                            "team_name": "Marketing",
                            "reply": "Temos apenas Cloudflare/DNS.",
                        },
                    ),
                ) as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    side_effect=(
                        self._future(
                            self.assistant_route.Result(
                                "assistant-uninstall",
                                guidance=self.assistant_route.Guidance(
                                    "assistant-uninstall-target-required",
                                    reply,
                                ),
                            )
                        ),
                        self._future(
                            self.assistant_route.Result(
                                "ordinary-task",
                                preparation=self.chat_socket.lifecycle.assistant_plan.Preparation(),
                            )
                        ),
                        self._future(
                            self.assistant_route.Result(
                                "assistant-uninstall",
                                uninstall=self._uninstall_candidate(),
                            )
                        ),
                    ),
                ) as route,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {"type": "chat", "message": "desinstala ele", "files": [], "assistant_ids": []}
                )
                guidance = await websocket.next_json()
                self.assertEqual(guidance["reply"], reply)

                await websocket.send_json({"type": "chat", "message": "quais temos?", "files": [], "assistant_ids": []})
                inventory = await websocket.next_json()
                self.assertEqual(inventory["reply"], "Temos apenas Cloudflare/DNS.")
                await websocket.disconnect()

                resumed = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await resumed.start()))
                await resumed.send_json(
                    {"type": "chat", "message": "desinstala esse então", "files": [], "assistant_ids": []}
                )
                proposed = await resumed.next_json()
                self.assertEqual((proposed["type"], proposed["state"]), ("assistant-uninstall", "proposed"))

                first_context = route.call_args_list[0].args[2]
                third_context = route.call_args_list[2].args[2]
                self.assertEqual(first_context.conversation, ())
                self.assertEqual(
                    [(entry.role, entry.text) for entry in third_context.conversation],
                    [
                        ("user", "desinstala ele"),
                        ("assistant", reply),
                        ("user", "quais temos?"),
                        ("assistant", "Temos apenas Cloudflare/DNS."),
                    ],
                )
                self.assertEqual(third_context.selection_language_exemplar, "quais temos?")
                turn.assert_called_once()
                await resumed.disconnect()

        asyncio.run(scenario())

    def test_successful_uninstall_supplies_the_follow_up_reinstall_reference(self) -> None:
        async def scenario() -> None:
            assistant_plan = self.chat_socket.lifecycle.assistant_plan
            candidate = self.chat_socket.lifecycle.store_catalog.CatalogAssistant(
                assistant_id="shimpz-cloudflare",
                name="Shimpz Cloudflare",
                summary="Manage Cloudflare zones and DNS records.",
                source_digest="sha256:" + ("d" * 64),
                icon_digest="sha256:" + ("e" * 64),
                integrations=(),
                actions=("list-zones",),
            )
            plan = assistant_plan.Plan(
                "f" * 32,
                "team_1",
                (candidate,),
                ("shimpz-cloudflare",),
                True,
                ("shimpz-cloudflare",),
            )
            installed = tuple({**item, "status": "installed"} for item in assistant_plan.initial_items(plan))
            with (
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    side_effect=(
                        self._future(
                            self.assistant_route.Result(
                                "assistant-uninstall",
                                uninstall=self._uninstall_candidate(),
                            )
                        ),
                        self._future(
                            self.assistant_route.Result(
                                "assistant-install",
                                preparation=assistant_plan.Preparation(plan),
                            )
                        ),
                    ),
                ) as route,
                mock.patch.object(
                    self.chat_socket.lifecycle.assistant_uninstall,
                    "uninstall",
                    return_value=self.chat_socket.lifecycle.assistant_uninstall.UninstallResult(200, True),
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_plan",
                    return_value=self._future(assistant_plan.Result("installed", installed)),
                ),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                proposed = await websocket.next_json()
                self.assertEqual((proposed["type"], proposed["state"]), ("assistant-uninstall", "proposed"))

                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "sim",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "uninstalling")
                self.assertEqual((await websocket.next_json())["state"], "uninstalled")
                await asyncio.sleep(0)

                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "instale ele de novo",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                completed = await websocket.next_json()
                self.assertEqual((completed["state"], completed["continuation"]), ("installed", "none"))
                reference = route.call_args_list[1].args[2].reference
                self.assertEqual(reference.assistant_id, "shimpz-cloudflare")
                self.assertEqual(reference.name, "Shimpz Cloudflare")
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_targeted_uninstall_after_ambiguous_retire_creates_a_fresh_proposal(self) -> None:
        async def scenario() -> None:
            with (
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    side_effect=(
                        self._future(
                            self.assistant_route.Result(
                                "assistant-uninstall",
                                uninstall=self._uninstall_candidate(),
                            )
                        ),
                        self._future(
                            self.assistant_route.Result(
                                "assistant-uninstall",
                                uninstall=self._uninstall_candidate(),
                            )
                        ),
                    ),
                ),
                mock.patch.object(self.chat_socket.lifecycle.assistant_uninstall, "uninstall") as uninstall,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": ["shimpz-cloudflare"],
                    }
                )
                proposed = await websocket.next_json()
                self.assertEqual((proposed["type"], proposed["state"]), ("assistant-uninstall", "proposed"))

                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                reproposed = await websocket.next_json()
                self.assertEqual((reproposed["type"], reproposed["state"]), ("assistant-uninstall", "proposed"))
                self.assertNotEqual(reproposed["proposal_id"], proposed["proposal_id"])
                uninstall.assert_not_called()
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_route_failure_and_no_match_never_fall_through_to_brain(self) -> None:
        async def scenario(result, expected) -> None:
            with (
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    return_value=(
                        self._future(error=result)
                        if isinstance(result, Exception)
                        else self._future(
                            self.assistant_route.Result(
                                "assistant-uninstall",
                                guidance=self.assistant_route.Guidance(
                                    "assistant-uninstall-target-required",
                                    "Qual Assistant instalado você quer desinstalar?",
                                ),
                            )
                        )
                    ),
                ),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                event = await websocket.next_json()
                self.assertEqual((event["type"], event.get("state"), event.get("status")), expected)
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario(None, ("assistant-guidance", None, None)))
        asyncio.run(scenario(ValueError("invalid inventory"), ("error", None, 503)))

    def test_route_saturation_is_explicit_and_never_calls_brain(self) -> None:
        async def scenario(failure: Exception, status: int) -> None:
            route = (
                {"side_effect": failure}
                if isinstance(failure, self.chat_socket.ExecutorSaturatedError)
                else {"return_value": self._future(error=failure)}
            )
            with (
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    **route,
                ),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                event = await websocket.next_json()
                self.assertEqual((event["type"], event["status"]), ("error", status))
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario(self.chat_socket.ExecutorSaturatedError(), 429))
        asyncio.run(scenario(ValueError("invalid inventory authority"), 503))

    def test_stop_during_route_never_dispatches_a_team_chat_stop(self) -> None:
        async def scenario() -> None:
            route: concurrent.futures.Future[object] = concurrent.futures.Future()

            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    return_value=route,
                ),
                mock.patch.object(self.chat_socket.local, "stop") as stop,
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                await websocket.send_json({"type": "stop"})
                self.assertEqual(await websocket.next_json(), {"type": "stopped"})
                stop.assert_not_called()
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_route_excludes_concurrent_chat_and_sync(self) -> None:
        async def scenario() -> None:
            route: concurrent.futures.Future[object] = concurrent.futures.Future()

            with mock.patch.object(
                self.chat_socket.lifecycle,
                "submit_route",
                return_value=route,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Desinstala o Cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "continue",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                self.assertEqual((await websocket.next_json())["status"], 409)
                await websocket.send_json({"type": "sync"})
                self.assertEqual((await websocket.next_json())["status"], 409)
                route.set_result(
                    self.assistant_route.Result(
                        "assistant-uninstall",
                        uninstall=self._uninstall_candidate(),
                    )
                )
                self.assertEqual((await websocket.next_json())["state"], "proposed")
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_disconnect_during_route_never_dispatches_a_team_chat_stop(self) -> None:
        async def scenario() -> None:
            route: concurrent.futures.Future[object] = concurrent.futures.Future()

            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_route",
                    return_value=route,
                ),
                mock.patch.object(self.chat_socket.local, "stop") as stop,
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Desinstala o Cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                await websocket.disconnect()
                stop.assert_not_called()
                turn.assert_not_called()

        asyncio.run(scenario())

    def test_uninstall_delivery_edges_fail_closed(self) -> None:
        async def scenario() -> None:
            delivery = self.uninstall_delivery
            with mock.patch.object(delivery.lifecycle, "create_proposal", side_effect=ValueError):
                malformed = delivery._matched_event(
                    delivery.Connection(),
                    delivery.Turn(None, "assistant-route"),
                    "team_1",
                    self._uninstall_candidate(),
                )
            self.assertEqual(malformed["status"], 503)

            detached_turn = delivery.Turn(None, "assistant-route")
            detached = delivery.Connection(active=detached_turn)
            with mock.patch.object(
                delivery.terminal_delivery,
                "turn",
                new=mock.AsyncMock(return_value=True),
            ) as terminal:
                await delivery.deliver_candidate(
                    mock.AsyncMock(),
                    detached,
                    detached_turn,
                    "team_1",
                    self._uninstall_candidate(),
                )
            terminal.assert_awaited_once()

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
