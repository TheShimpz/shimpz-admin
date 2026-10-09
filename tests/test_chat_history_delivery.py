"""Persistence-before-projection edges for Local Admin chat history."""

import asyncio
import concurrent.futures
import contextvars
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat.delivery import challenge as challenge_delivery
from chat.delivery import sync as sync_delivery
from chat.delivery import terminal as terminal_delivery
from history import http as history_http
from team import bridge as team
from tests.chat_socket_case import ChatDeliveryCase

from chat import socket
from tests import chat_socket_fixtures


class ChatHistoryDeliveryTests(ChatDeliveryCase):
    def test_admission_commits_user_history_before_work_can_start(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            frame = chat_socket_fixtures.chat_frame("Hello")
            with (
                mock.patch.object(socket.history, "new_turn_id", return_value="a" * 32),
                mock.patch.object(socket.history, "append_user", return_value=True) as append,
            ):
                payload, identity = await socket._admit_chat_payload(websocket, connection, "team_1", frame)
            self.assertEqual(
                payload, {"message": "Hello", "files": [], "assistant_ids": [], "locale": "en", "timezone": None}
            )
            # The browser receives the seal of exactly this send's identity.
            self.assertEqual(websocket.send_json.await_args.args[0]["type"], "sent")
            self.assertEqual(
                websocket.send_json.await_args.args[0]["request"].split(".")[:2],
                [str(identity["issued_at"]), identity["nonce"]],
            )
            self.assertEqual(connection.admitted_history_id, "a" * 32)
            append.assert_called_once_with("team_1", "a" * 32, "Hello", files=[])

            connection = socket._Connection()
            with (
                mock.patch.object(socket.history, "new_turn_id", return_value="b" * 32),
                mock.patch.object(
                    socket.history,
                    "append_user",
                    side_effect=socket.history.HistoryUnavailableError("full"),
                ),
                mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send,
            ):
                # Another logical send: the browser names it with its own nonce.
                another = dict(frame)
                self.assertIsNone(await socket._admit_chat_payload(websocket, connection, "team_1", another))
            self.assertIsNone(connection.admitted_history_id)
            self.assertEqual(send.await_args.args[1]["status"], 503)

        asyncio.run(scenario())

    def test_an_attached_message_is_admitted_with_the_teams_own_file_references(self) -> None:
        delivery = socket.history_delivery
        stored = [
            {
                "id": file_id,
                "name": name,
                "media_type": "text/plain",
                "size": size,
                "sha256": "e" * 64,
                "created_at": 1_700_000_000,
            }
            for file_id, name, size in (("b" * 32, "b.txt", 2), ("a" * 32, "a.txt", 1), ("c" * 32, "c.txt", 3))
        ]
        listing = team.TeamResponse(200, {"team_id": "team_1", "files": stored})
        with (
            mock.patch.object(delivery.team, "resolve_team_name", return_value="Marketing"),
            mock.patch.object(delivery.team, "list_files", return_value=listing) as list_files,
        ):
            asyncio.run(delivery.admit("team_1", "Compare", files=["a" * 32, "b" * 32]))
            with self.assertRaises(delivery.SelectedFileUnavailableError):
                asyncio.run(delivery.admit("team_1", "Missing", files=["d" * 32]))
            list_files.return_value = team.TeamResponse(503, {"detail": "team unavailable"})
            with self.assertRaises(socket.history.HistoryUnavailableError):
                asyncio.run(delivery.admit("team_1", "Unavailable", files=["a" * 32]))
        (entry,) = socket.history.page("team_1")["entries"]
        # The message's order is kept, and only what the transcript shows of each file is stored.
        self.assertEqual(
            entry["files"],
            [
                {"id": "a" * 32, "name": "a.txt", "media_type": "text/plain", "size": 1},
                {"id": "b" * 32, "name": "b.txt", "media_type": "text/plain", "size": 2},
            ],
        )

    def test_a_message_naming_a_file_the_team_no_longer_holds_is_refused_before_any_work(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            frame = {
                "type": "chat",
                "message": "Summarize",
                "files": ["d" * 32],
                "assistant_ids": [],
                "locale": "en",
                "timezone": None,
                "request": None,
            }
            listing = team.TeamResponse(200, {"team_id": "team_1", "files": []})
            with (
                mock.patch.object(socket.history_delivery.team, "list_files", return_value=listing),
                mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send,
            ):
                self.assertIsNone(await socket._admit_chat_payload(websocket, connection, "team_1", frame))
            self.assertEqual(send.await_args.args[1]["status"], 404)
            self.assertIsNone(connection.admitted_history_id)

        asyncio.run(scenario())
        self.assertEqual(socket.history.page("team_1")["entries"], [])

    def test_an_admission_queued_behind_team_deletion_never_survives_it(self) -> None:
        # A user message is admitted while a Team deletion holds the lifecycle lock. Once deletion removed the Team
        # and cleared its transcript, the admission must find the Team gone instead of recreating its row.
        delivery = socket.history_delivery
        deleted = threading.Event()
        outcome: dict[str, object] = {}

        def resolve(_team_id: str) -> team.TeamResponse | str:
            return team.TeamResponse(404, {"detail": "Team not found"}) if deleted.is_set() else "Marketing"

        def admit() -> None:
            try:
                outcome["turn"] = asyncio.run(delivery.admit("marketing", "Hello"))
            except socket.history.HistoryUnavailableError as exc:
                outcome["error"] = exc

        worker = threading.Thread(target=admit)

        def delete() -> team.TeamResponse:
            worker.start()
            worker.join(0.3)
            self.assertTrue(worker.is_alive(), "the admission must wait behind the deletion")
            deleted.set()
            return team.TeamResponse(200, {"deleted": True})

        with mock.patch.object(delivery.team, "resolve_team_name", side_effect=resolve):
            self.assertEqual(history_http.team_delete("marketing", delete).status, 200)
            worker.join(10)
        self.assertIsInstance(outcome.get("error"), socket.history.HistoryUnavailableError)
        self.assertEqual(socket.history.page("marketing")["entries"], [])

    def test_saturated_history_admission_is_refused_without_borrowing_default_workers(self) -> None:
        # Admission holds the lifecycle lock across a Team lookup. While a slow lookup blocks it, admissions must fill
        # only the history lane, refuse the overflow before any durable write, and leave the default executor free.
        delivery = socket.history_delivery
        request = contextvars.ContextVar("history_admission_request", default=None)
        committed: list[tuple[str, object]] = []

        def append_user(_team_id: str, turn_id: str, _message: object, *, files: object = ()) -> bool:
            committed.append((turn_id, request.get()))
            return True

        async def scenario() -> None:
            loop = asyncio.get_running_loop()
            loop.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=1))
            frame = chat_socket_fixtures.chat_frame("Hello")
            request.set("supervisor-request")
            queued = []
            with (
                mock.patch.object(delivery.team, "resolve_team_name", return_value="Marketing"),
                mock.patch.object(socket.history, "append_user", side_effect=append_user),
            ):
                socket.history.LIFECYCLE_LOCK.acquire()
                try:
                    for _ in range(4):
                        queued.append(asyncio.create_task(delivery.admit("team_1", "Hello")))
                        await asyncio.sleep(0)
                    websocket = mock.AsyncMock()
                    connection = socket._Connection()
                    admission = socket._admit_chat_payload(websocket, connection, "team_1", frame)
                    self.assertIsNone(await asyncio.wait_for(admission, 5))
                    refused = websocket.send_json.await_args.args[0]
                    self.assertEqual((refused["type"], refused["status"]), ("error", 429))
                    self.assertIsNone(connection.admitted_history_id)
                    self.assertEqual(await asyncio.wait_for(asyncio.to_thread(lambda: "ran"), 5), "ran")
                    self.assertEqual(committed, [])
                finally:
                    socket.history.LIFECYCLE_LOCK.release()
                turns = await asyncio.wait_for(asyncio.gather(*queued), 10)
            self.assertEqual(sorted(turn for turn, _request in committed), sorted(turns))
            self.assertEqual({seen for _turn, seen in committed}, {"supervisor-request"})

        asyncio.run(scenario())

    def test_terminal_reply_is_committed_before_socket_projection(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            turn = socket._Turn(None, "chat", history_id="a" * 32)
            event = {
                "type": "done",
                "team_id": "team_1",
                "team_name": "Team 1",
                "reply": "Done",
                "clarification": None,
            }
            with mock.patch.object(socket.history, "append_reply", return_value=True) as append:
                self.assertTrue(await socket._send_terminal_once(websocket, connection, turn, event))
            append.assert_called_once_with("team_1", "a" * 32, event)
            websocket.send_json.assert_awaited_once_with(event)

        asyncio.run(scenario())

    def test_uncommitted_terminal_reply_fails_visibly(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            turn = socket._Turn(None, "chat", history_id="a" * 32)
            event = {
                "type": "done",
                "team_id": "team_1",
                "team_name": "Team 1",
                "reply": "Done",
                "clarification": None,
            }
            with mock.patch.object(socket.history, "append_reply", return_value=False):
                self.assertTrue(await socket._send_terminal_once(websocket, connection, turn, event))
            projected = websocket.send_json.await_args.args[0]
            self.assertEqual(projected["type"], "error")
            self.assertEqual(projected["status"], 503)

        asyncio.run(scenario())

    def test_resumed_non_reply_terminal_releases_the_exact_challenge(self) -> None:
        async def scenario() -> None:
            turn_id = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", turn_id, "Approve the Action"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", turn_id))
            connection = socket._Connection(pending_history_id=turn_id)
            websocket = mock.AsyncMock()

            await sync_delivery.human(
                websocket,
                connection,
                "team_1",
                chat_socket_fixtures.human_challenge("approval"),
                socket._SYNC_OPERATIONS,
            )
            self.assertEqual(connection.pending_history_id, turn_id)
            self.assertTrue(
                await socket._send_sync_terminal_once(
                    websocket,
                    connection,
                    {"type": "error", "status": 409, "detail": "Action denied"},
                    finish_history=True,
                )
            )
            self.assertIsNone(socket.history.resumable_turn("team_1"))
            self.assertIsNone(connection.pending_history_id)

        asyncio.run(scenario())

    def test_empty_sync_releases_an_abandoned_challenge(self) -> None:
        async def scenario() -> None:
            turn_id = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", turn_id, "Expired approval"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", turn_id))
            connection = socket._Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_history_id=turn_id,
            )
            websocket = mock.AsyncMock()

            await sync_delivery.empty(websocket, connection, socket._SYNC_OPERATIONS)

            self.assertIsNone(socket.history.resumable_turn("team_1"))
            self.assertIsNone(connection.pending_challenge_id)
            websocket.send_json.assert_awaited_once_with({"type": "sync-empty"})

        asyncio.run(scenario())

    def test_empty_sync_never_releases_a_newer_binding(self) -> None:
        async def scenario() -> None:
            first = socket.history.new_turn_id()
            second = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", first, "Expired approval"))
            self.assertTrue(socket.history.append_user("team_1", second, "New approval"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", first))
            connection = socket._Connection(pending_history_id=first)

            socket.history.finish_resumable_turn(first)
            self.assertTrue(socket.history.bind_resumable_turn("team_1", second))
            await sync_delivery.empty(mock.AsyncMock(), connection, socket._SYNC_OPERATIONS)

            self.assertEqual(socket.history.resumable_turn("team_1"), second)

        asyncio.run(scenario())

    def test_uncertain_integration_resume_preserves_the_binding(self) -> None:
        async def scenario() -> None:
            turn_id = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", turn_id, "Connect Cloudflare"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", turn_id))
            connection = socket._Connection(pending_history_id=turn_id)
            pending = chat_socket_fixtures.integration_challenge().websocket_event("team_1")
            websocket = mock.AsyncMock()

            await sync_delivery.integration_terminal(
                websocket,
                connection,
                "team_1",
                pending,
                socket.local.PublicResponse(503, {"code": "offline"}),
                socket._SYNC_OPERATIONS,
            )

            self.assertEqual(socket.history.resumable_turn("team_1"), turn_id)
            self.assertEqual(connection.pending_challenge_id, pending["challenge_id"])
            self.assertEqual(websocket.send_json.await_args.args[0]["type"], "error")

        asyncio.run(scenario())

    def test_uncertain_human_resume_preserves_the_binding(self) -> None:
        async def scenario() -> None:
            turn_id = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", turn_id, "Approve the Action"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", turn_id))
            connection = socket._Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_history_id=turn_id,
            )
            future = asyncio.get_running_loop().create_future()
            websocket = mock.AsyncMock()
            with mock.patch.object(
                socket,
                "_await_progress_result",
                new=mock.AsyncMock(return_value=socket.local.PublicResponse(503, {"code": "offline"})),
            ):
                await socket._deliver_human_response(
                    websocket,
                    connection,
                    "team_1",
                    future,
                    asyncio.Queue(),
                    None,
                )

            self.assertEqual(socket.history.resumable_turn("team_1"), turn_id)
            self.assertEqual(connection.pending_challenge_id, "b" * 32)
            self.assertEqual(websocket.send_json.await_args.args[0]["type"], "error")

        asyncio.run(scenario())

    def test_history_delivery_admission_and_terminal_edges_fail_closed(self) -> None:
        async def scenario() -> None:
            delivery = socket.history_delivery
            with (
                mock.patch.object(socket.history, "append_user", return_value=False),
                self.assertRaises(socket.history.HistoryUnavailableError),
            ):
                await delivery.admit("team_1", "Hello")

            await delivery.terminal("team_1", None, {"type": "done"})
            with (
                mock.patch.object(socket.history, "append_reply", return_value=False),
                self.assertRaises(socket.history.HistoryUnavailableError),
            ):
                await delivery.terminal(
                    "team_1",
                    "a" * 32,
                    {"type": "done"},
                )
            with mock.patch.object(socket.history, "finish_resumable_turn") as finish:
                await delivery.terminal("team_1", "a" * 32, {"type": "error"})
                finish.assert_not_called()
                await delivery.terminal(
                    "team_1",
                    "a" * 32,
                    {"type": "error"},
                    finish_history=True,
                )
                finish.assert_called_once_with("a" * 32)

            await delivery.challenge("team_1", None)
            with mock.patch.object(socket.history, "bind_resumable_turn", return_value=True):
                await delivery.challenge("team_1", "a" * 32)
            with (
                mock.patch.object(socket.history, "bind_resumable_turn", return_value=False),
                self.assertRaises(socket.history.HistoryUnavailableError),
            ):
                await delivery.challenge("team_1", "a" * 32)

        asyncio.run(scenario())

    def test_history_delivery_resume_edges_fail_closed(self) -> None:
        async def scenario() -> None:
            delivery = socket.history_delivery
            with mock.patch.object(socket.history, "resumable_turn", return_value=None):
                with self.assertRaises(socket.history.HistoryUnavailableError):
                    await delivery.resume("team_1")
                self.assertIsNone(await delivery.observe("team_1"))
                with self.assertRaises(socket.history.HistoryUnavailableError):
                    await delivery.resume_exact("team_1", None)
                with self.assertRaises(socket.history.HistoryUnavailableError):
                    await delivery.resume_exact("team_1", "a" * 32)
            with mock.patch.object(socket.history, "resumable_turn", return_value="a" * 32):
                self.assertEqual(await delivery.resume("team_1"), "a" * 32)
                self.assertEqual(await delivery.observe("team_1"), "a" * 32)
                self.assertEqual(await delivery.resume_exact("team_1", "a" * 32), "a" * 32)

            with mock.patch.object(socket.history, "finish_resumable_turn") as finish:
                await delivery.abandon(None)
                finish.assert_not_called()
                await delivery.abandon("a" * 32)
                finish.assert_called_once_with("a" * 32)

        asyncio.run(scenario())

    def test_history_delivery_resumed_terminal_and_guidance_edges_fail_closed(self) -> None:
        async def scenario() -> None:
            delivery = socket.history_delivery
            with self.assertRaises(socket.history.HistoryUnavailableError):
                await delivery.resumed_terminal(None, {"type": "done"})
            with (
                mock.patch.object(socket.history, "append_reply", return_value=False),
                self.assertRaises(socket.history.HistoryUnavailableError),
            ):
                await delivery.resumed_terminal(
                    "a" * 32,
                    {"type": "done", "team_id": "team_1"},
                )
            with mock.patch.object(socket.history, "append_reply", return_value=True):
                await delivery.resumed_terminal(
                    "a" * 32,
                    {"type": "done", "team_id": "team_1"},
                )
            with mock.patch.object(socket.history, "finish_resumable_turn") as finish:
                await delivery.resumed_terminal("a" * 32, {"type": "error"})
                finish.assert_called_once_with("a" * 32)

            reply = "Qual Assistant instalado você quer desinstalar?"
            await delivery.guidance("team_1", None, "assistant-uninstall-target-required", reply)
            with (
                mock.patch.object(socket.history, "append_guidance", return_value=False),
                self.assertRaises(socket.history.HistoryUnavailableError),
            ):
                await delivery.guidance("team_1", "a" * 32, "assistant-uninstall-target-required", reply)
            with mock.patch.object(socket.history, "append_guidance", return_value=True):
                await delivery.guidance("team_1", "a" * 32, "assistant-uninstall-target-required", reply)

        asyncio.run(scenario())

    def test_projection_layers_fail_closed_when_history_is_unavailable(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            error = {"type": "error", "status": 503}

            challenge_operations = challenge_delivery.Operations(
                send_event=mock.AsyncMock(return_value=True),
                send_terminal=mock.AsyncMock(return_value=True),
                error_terminal=mock.Mock(return_value=error),
            )
            with mock.patch.object(
                challenge_delivery.history_delivery,
                "challenge",
                new=mock.AsyncMock(side_effect=socket.history.HistoryUnavailableError("offline")),
            ):
                await challenge_delivery.deliver(
                    websocket,
                    socket._Connection(),
                    socket._Turn(None, "chat", history_id="a" * 32),
                    "team_1",
                    {"type": "human-required"},
                    "human",
                    challenge_operations,
                )
            challenge_operations.send_terminal.assert_awaited_once()
            challenge_operations.send_event.assert_not_awaited()

            sync_operations = sync_delivery.Operations(
                send_event=mock.AsyncMock(return_value=True),
                send_terminal=mock.AsyncMock(return_value=True),
                error_terminal=mock.Mock(return_value=error),
            )
            connection = socket._Connection(pending_history_id="a" * 32)
            with mock.patch.object(
                sync_delivery.history_delivery,
                "abandon",
                new=mock.AsyncMock(side_effect=ValueError("invalid")),
            ):
                await sync_delivery.empty(websocket, connection, sync_operations)
            self.assertEqual(connection.pending_history_id, "a" * 32)

            pending = {"type": "integrations-required"}
            with mock.patch.object(
                sync_delivery,
                "_restore_history",
                new=mock.AsyncMock(return_value=False),
            ):
                await sync_delivery.integration_terminal(
                    websocket,
                    socket._Connection(),
                    "team_1",
                    pending,
                    object(),
                    sync_operations,
                )
                await sync_delivery.human(
                    websocket,
                    socket._Connection(),
                    "team_1",
                    chat_socket_fixtures.human_challenge("approval"),
                    sync_operations,
                )

            terminal_connection = socket._Connection(pending_history_id="a" * 32)
            with mock.patch.object(
                terminal_delivery.history_delivery,
                "resumed_terminal",
                new=mock.AsyncMock(side_effect=ValueError("invalid")),
            ):
                self.assertTrue(
                    await terminal_delivery.resumed(
                        websocket,
                        terminal_connection,
                        {"type": "done"},
                        finish_history=True,
                    )
                )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 503)

        asyncio.run(scenario())

    def test_any_commit_failure_still_ends_the_turn_with_a_visible_terminal(self) -> None:
        """A reply that history cannot commit, for whatever reason, is an error the browser sees, never a silence."""

        async def scenario() -> None:
            for failure in (TypeError("frozen"), RuntimeError("unexpected"), KeyError("missing")):
                with self.subTest(failure=type(failure).__name__):
                    websocket = mock.AsyncMock()
                    connection = socket._Connection()
                    turn = socket._Turn(None, "chat", history_id="a" * 32)
                    with mock.patch.object(
                        terminal_delivery.history_delivery, "terminal", new=mock.AsyncMock(side_effect=failure)
                    ):
                        self.assertTrue(await terminal_delivery.turn(websocket, connection, turn, {"type": "done"}))
                    self.assertEqual(websocket.send_json.await_args.args[0]["status"], 503)
                    self.assertTrue(turn.terminal_sent)
                    resumed = socket._Connection(pending_history_id="a" * 32)
                    with mock.patch.object(
                        terminal_delivery.history_delivery,
                        "resumed_terminal",
                        new=mock.AsyncMock(side_effect=failure),
                    ):
                        self.assertTrue(
                            await terminal_delivery.resumed(websocket, resumed, {"type": "done"}, finish_history=True)
                        )
                    self.assertEqual(websocket.send_json.await_args.args[0]["status"], 503)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
