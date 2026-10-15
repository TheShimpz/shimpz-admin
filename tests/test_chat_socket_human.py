"""Authenticated WebSocket lifecycle for Action human requests."""

import asyncio
import contextlib
import json
import unittest
from collections.abc import Iterator
from functools import partial
from unittest import mock

from history import store as history_store
from tests.chat_socket_case import ChatWebSocketCase
from tests.chat_socket_fixtures import CHALLENGE_ID, human_challenge, human_response

from tests import chat_socket_fixtures


class ChatWebSocketHumanTests(ChatWebSocketCase):
    def setUp(self) -> None:
        super().setUp()
        self.auth_clock = [100.0]
        self.admin_app._AUTHENTICATE_ACTION_REQUEST = self.admin_app.chat_human.LocalPasswordAuthority(
            partial(
                self.admin_app.chat_human.authenticate_local,
                record_get=self.admin_app.state.get,
            ),
            clock=lambda: self.auth_clock[0],
        )
        self.completed = chat_socket_fixtures.completed_turn("Completed.")

    @contextlib.contextmanager
    def _human_turn(self, kind: str) -> Iterator[mock.MagicMock]:
        """Pause the Local turn on one human challenge and yield the resume mock that completes it."""
        with (
            mock.patch.object(self.chat_socket.local, "turn", return_value=human_challenge(kind)),
            mock.patch.object(self.chat_socket.local, "resume_human", return_value=self.completed) as resume,
        ):
            yield resume

    async def _open_challenge(self, kind: str) -> chat_socket_fixtures.Socket:
        websocket = await self._open()
        await websocket.send_json(chat_socket_fixtures.chat_frame("Continue"))
        challenge = await websocket.next_json()
        self.assertEqual(challenge["type"], "human-required")
        self.assertEqual(challenge["request"]["kind"], kind)
        return websocket

    def test_approval_resumes_the_exact_pending_challenge(self) -> None:
        async def scenario() -> None:
            with self._human_turn("approval") as resume:
                websocket = await self._open_challenge("approval")
                await websocket.send_json(human_response(True))
                self.assertEqual((await websocket.next_json())["type"], "done")
                self.assertEqual(
                    resume.call_args.args[:2],
                    (
                        "team_1",
                        {"challenge_id": CHALLENGE_ID, "decision": "submit", "value": True},
                    ),
                )
                self.assertIsNone(resume.call_args.kwargs["assurance"])
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_supervisor_password_becomes_only_signed_boolean_assurance(self) -> None:
        async def scenario() -> None:
            with self._human_turn("auth:password") as resume:
                websocket = await self._open_challenge("auth:password")
                await websocket.send_json(human_response("violet otter lantern quartz 92"))
                event = await websocket.next_json()
                self.assertEqual(event["type"], "done")
                self.assertEqual(
                    resume.call_args.args[1],
                    {"challenge_id": CHALLENGE_ID, "decision": "submit", "value": True},
                )
                self.assertEqual(
                    resume.call_args.kwargs["assurance"],
                    {"kind": "auth:password", "challenge_id": CHALLENGE_ID},
                )
                self.assertNotIn("violet otter lantern quartz 92", repr(resume.call_args))
                self.assertNotIn("violet otter lantern quartz 92", json.dumps(event))
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_failed_password_authentication_stays_pending_and_can_then_succeed(self) -> None:
        async def scenario() -> None:
            with self._human_turn("auth:password") as resume:
                websocket = await self._open_challenge("auth:password")
                await websocket.send_json(human_response("incorrect password"))
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "human-response-rejected",
                        "challenge_id": CHALLENGE_ID,
                        "reason": "authentication-denied",
                        "attempts_remaining": 2,
                        "retry_after": 0,
                    },
                )
                resume.assert_not_called()

                await websocket.send_json(human_response("violet otter lantern quartz 92"))
                self.assertEqual((await websocket.next_json())["type"], "done")
                self.assertEqual(resume.call_args.args[1]["value"], True)
                self.assertNotIn("incorrect password", repr(resume.call_args))
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_third_password_failure_locks_every_socket_until_one_minute(self) -> None:
        async def scenario() -> None:
            with self._human_turn("auth:password") as resume:
                websocket = await self._open_challenge("auth:password")
                for expected_remaining in (2, 1):
                    await websocket.send_json(human_response("incorrect password"))
                    event = await websocket.next_json()
                    self.assertEqual(event["reason"], "authentication-denied")
                    self.assertEqual(event["attempts_remaining"], expected_remaining)

                await websocket.send_json(human_response("incorrect password"))
                locked = await websocket.next_json()
                self.assertEqual((locked["reason"], locked["retry_after"]), ("authentication-locked", 60))

                await websocket.send_json(human_response("violet otter lantern quartz 92"))
                still_locked = await websocket.next_json()
                self.assertEqual((still_locked["reason"], still_locked["retry_after"]), ("authentication-locked", 60))
                resume.assert_not_called()

                self.auth_clock[0] += 60
                await websocket.send_json(human_response("violet otter lantern quartz 92"))
                self.assertEqual((await websocket.next_json())["type"], "done")
                resume.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_assistant_password_input_is_not_treated_as_supervisor_authentication(self) -> None:
        async def scenario() -> None:
            with self._human_turn("input:password") as resume:
                websocket = await self._open_challenge("input:password")
                await websocket.send_json(human_response("third-party-api-secret"))
                self.assertEqual((await websocket.next_json())["type"], "done")
                self.assertEqual(resume.call_args.args[1]["value"], "third-party-api-secret")
                self.assertIsNone(resume.call_args.kwargs["assurance"])
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_invalid_or_cross_challenge_response_does_not_resume(self) -> None:
        async def scenario() -> None:
            with self._human_turn("approval") as resume:
                websocket = await self._open_challenge("approval")
                await websocket.send_json(human_response(True, challenge_id="c" * 32))
                self.assertEqual((await websocket.next_json())["status"], 409)
                await websocket.send_json(human_response("yes"))
                self.assertEqual((await websocket.next_json())["status"], 400)
                resume.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_unprojectable_human_gate_fails_closed(self) -> None:
        async def scenario() -> None:
            valid = human_challenge("approval")
            body = json.loads(json.dumps(valid.body))
            body["request"]["title"] = "tampered"
            invalid = self.chat_socket.team.TeamResponse(428, body)
            with mock.patch.object(self.chat_socket.local, "turn", return_value=invalid):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("Continue"))
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "error",
                        "status": 502,
                        "detail": "the Assistant challenge was invalid",
                    },
                )
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_sync_restores_pending_metadata_without_replaying_a_response(self) -> None:
        async def scenario() -> None:
            empty = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "status": "none"},
            )
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "pending_integrations",
                    return_value=empty,
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "open_human",
                    return_value=human_challenge("approval", status=200),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "resume_human",
                    return_value=self.completed,
                ) as resume,
            ):
                history_id = history_store.new_turn_id()
                history_store.append_user("team_1", history_id, "Resume approval")
                history_store.bind_resumable_turn("team_1", history_id)
                websocket = await self._open(synchronized=False)
                challenge = await websocket.next_json()
                self.assertEqual(challenge["type"], "human-required")
                resume.assert_not_called()

                await websocket.send_json(human_response(True))
                self.assertEqual((await websocket.next_json())["type"], "done")
                resume.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def _stored_reply(self) -> dict[str, object]:
        return history_store.page("team_1")["entries"][-1]

    def test_a_reply_keeps_the_team_steps_of_its_whole_logical_turn(self) -> None:
        model = {"origin": "team", "phase": "model"}

        def turn(_team_id, _payload, _conversation, _request, progress):
            # Admin's own step runs outside Team's clock and never enters the receipt.
            progress({"origin": "admin", "phase": "admin-preparation", "state": "started"})
            progress({**model, "state": "started"})
            progress({**model, "state": "finished", "elapsed_ms": 40})
            return human_challenge("approval")

        def resume(_team_id, _payload, progress, *, assurance):
            progress({**model, "state": "started"})
            progress({**model, "state": "finished", "elapsed_ms": 30})
            return self.completed

        async def scenario() -> None:
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "resume_human", side_effect=resume),
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("Continue"))
                live = [await websocket.next_json() for _index in range(4)]
                self.assertEqual([frame["type"] for frame in live], ["progress"] * 3 + ["human-required"])
                await websocket.send_json(human_response(True))
                resumed = [await websocket.next_json() for _index in range(3)]
                self.assertEqual([frame["type"] for frame in resumed], ["progress", "progress", "done"])
                await websocket.disconnect()
            self.assertEqual(
                self._stored_reply()["receipt"],
                [
                    {"segment": 0, "seq": 2, **model, "state": "started"},
                    {"segment": 0, "seq": 3, **model, "state": "finished", "elapsed_ms": 40},
                    {"segment": 1, "seq": 1, **model, "state": "started"},
                    {"segment": 1, "seq": 2, **model, "state": "finished", "elapsed_ms": 30},
                ],
            )

            # The next message begins its own receipt: a turn that showed no Team step keeps none.
            with mock.patch.object(self.chat_socket.local, "turn", return_value=self.completed):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("Again"))
                self.assertEqual((await websocket.next_json())["type"], "done")
                await websocket.disconnect()
            self.assertNotIn("receipt", self._stored_reply())

        asyncio.run(scenario())

    def test_a_request_restored_on_another_page_keeps_only_the_steps_that_page_was_shown(self) -> None:
        def resume(_team_id, _payload, progress, *, assurance):
            progress({"origin": "team", "phase": "model", "state": "finished", "elapsed_ms": 30})
            return self.completed

        async def scenario() -> None:
            empty = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "status": "none"})
            with (
                mock.patch.object(self.chat_socket.local, "pending_integrations", return_value=empty),
                mock.patch.object(self.chat_socket.local, "open_human", return_value=human_challenge("approval", 200)),
                mock.patch.object(self.chat_socket.local, "resume_human", side_effect=resume),
            ):
                history_id = history_store.new_turn_id()
                history_store.append_user("team_1", history_id, "Resume approval")
                history_store.bind_resumable_turn("team_1", history_id)
                websocket = await self._open(synchronized=False)
                self.assertEqual((await websocket.next_json())["type"], "human-required")
                await websocket.send_json(human_response(True))
                self.assertEqual((await websocket.next_json())["type"], "progress")
                self.assertEqual((await websocket.next_json())["type"], "done")
                await websocket.disconnect()
            self.assertEqual(
                self._stored_reply()["receipt"],
                [{"segment": 0, "seq": 1, "origin": "team", "phase": "model", "state": "finished", "elapsed_ms": 30}],
            )

        asyncio.run(scenario())

    def test_a_receipt_is_kept_only_for_its_own_turn_and_within_its_bound(self) -> None:
        progress = self.chat_socket.progress_transport
        receipt = self.chat_socket.connection.Receipt()
        step = {"type": "progress", "seq": 1, "origin": "team", "phase": "model", "state": "started"}
        # A delivery that showed no Team step takes no number.
        progress.receipt_delivery(receipt, "a" * 32, fresh=True)({**step, "origin": "admin"})
        progress.receipt_delivery(receipt, "a" * 32, fresh=False)(step)
        self.assertEqual(
            progress.take_receipt(receipt, "a" * 32),
            [{"segment": 0, "seq": 1, "origin": "team", "phase": "model", "state": "started"}],
        )
        # Taking ends it: nothing is kept twice.
        self.assertIsNone(progress.take_receipt(receipt, "a" * 32))
        # A continuation of another turn begins its own receipt, and a receipt is never kept for another turn.
        progress.receipt_delivery(receipt, "a" * 32, fresh=False)(step)
        progress.receipt_delivery(receipt, "b" * 32, fresh=False)(step)
        self.assertEqual(len(receipt.events), 1)
        self.assertIsNone(progress.take_receipt(receipt, "a" * 32))
        self.assertIsNone(progress.take_receipt(receipt, None))
        # One that outgrew its bound is not kept, and holds at most one event past it.
        record = progress.receipt_delivery(receipt, "a" * 32, fresh=True)
        for _index in range(self.chat_socket.local.MAX_PUBLIC_PROGRESS_EVENTS + 5):
            record(step)
        self.assertEqual(len(receipt.events), self.chat_socket.local.MAX_PUBLIC_PROGRESS_EVENTS + 1)
        self.assertIsNone(progress.take_receipt(receipt, "a" * 32))


if __name__ == "__main__":
    unittest.main()
