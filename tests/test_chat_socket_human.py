"""Authenticated WebSocket lifecycle for Action human requests."""

from __future__ import annotations

import asyncio
import json
import unittest
from functools import partial
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase
from tests.chat_socket_fixtures import CHALLENGE_ID, human_challenge

from tests import chat_socket_fixtures


class ChatWebSocketHumanTests(ChatWebSocketCase):
    def setUp(self) -> None:
        super().setUp()
        self.auth_clock = [100.0]
        self.admin_app._AUTHENTICATE_ACTION_REQUEST = self.admin_app.chat_human.LocalPasswordAuthority(
            partial(
                self.admin_app.chat_human.authenticate_local,
                profile="local",
                record_get=self.admin_app.state.get,
            ),
            clock=lambda: self.auth_clock[0],
        )
        self.completed = self.chat_socket.local.PublicResponse(
            200,
            {
                "team_id": "team_1",
                "team_name": "Marketing",
                "reply": "Completed.",
                "clarification": None,
            },
        )

    async def _open_challenge(self, kind: str) -> chat_socket_fixtures.Socket:
        websocket = await self._open()
        await websocket.send_json(chat_socket_fixtures.chat_frame("Continue"))
        challenge = await websocket.next_json()
        self.assertEqual(challenge["type"], "human-required")
        self.assertEqual(challenge["request"]["kind"], kind)
        return websocket

    def test_approval_resumes_the_exact_pending_challenge(self) -> None:
        async def scenario() -> None:
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=human_challenge("approval"),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "resume_human",
                    return_value=self.completed,
                ) as resume,
            ):
                websocket = await self._open_challenge("approval")
                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": True,
                    }
                )
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
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=human_challenge("auth:password"),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "resume_human",
                    return_value=self.completed,
                ) as resume,
            ):
                websocket = await self._open_challenge("auth:password")
                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": "violet otter lantern quartz 92",
                    }
                )
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
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=human_challenge("auth:password"),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "resume_human",
                    return_value=self.completed,
                ) as resume,
            ):
                websocket = await self._open_challenge("auth:password")
                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": "incorrect password",
                    }
                )
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

                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": "violet otter lantern quartz 92",
                    }
                )
                self.assertEqual((await websocket.next_json())["type"], "done")
                self.assertEqual(resume.call_args.args[1]["value"], True)
                self.assertNotIn("incorrect password", repr(resume.call_args))
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_third_password_failure_locks_every_socket_until_one_minute(self) -> None:
        async def scenario() -> None:
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=human_challenge("auth:password"),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "resume_human",
                    return_value=self.completed,
                ) as resume,
            ):
                websocket = await self._open_challenge("auth:password")
                for expected_remaining in (2, 1):
                    await websocket.send_json(
                        {
                            "type": "human-response",
                            "challenge_id": CHALLENGE_ID,
                            "decision": "submit",
                            "value": "incorrect password",
                        }
                    )
                    event = await websocket.next_json()
                    self.assertEqual(event["reason"], "authentication-denied")
                    self.assertEqual(event["attempts_remaining"], expected_remaining)

                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": "incorrect password",
                    }
                )
                locked = await websocket.next_json()
                self.assertEqual((locked["reason"], locked["retry_after"]), ("authentication-locked", 60))

                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": "violet otter lantern quartz 92",
                    }
                )
                still_locked = await websocket.next_json()
                self.assertEqual((still_locked["reason"], still_locked["retry_after"]), ("authentication-locked", 60))
                resume.assert_not_called()

                self.auth_clock[0] += 60
                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": "violet otter lantern quartz 92",
                    }
                )
                self.assertEqual((await websocket.next_json())["type"], "done")
                resume.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_assistant_password_input_is_not_treated_as_supervisor_authentication(self) -> None:
        async def scenario() -> None:
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=human_challenge("input:password"),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "resume_human",
                    return_value=self.completed,
                ) as resume,
            ):
                websocket = await self._open_challenge("input:password")
                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": "third-party-api-secret",
                    }
                )
                self.assertEqual((await websocket.next_json())["type"], "done")
                self.assertEqual(resume.call_args.args[1]["value"], "third-party-api-secret")
                self.assertIsNone(resume.call_args.kwargs["assurance"])
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_invalid_or_cross_challenge_response_does_not_resume(self) -> None:
        async def scenario() -> None:
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=human_challenge("approval"),
                ),
                mock.patch.object(self.chat_socket.local, "resume_human") as resume,
            ):
                websocket = await self._open_challenge("approval")
                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": "c" * 32,
                        "decision": "submit",
                        "value": True,
                    }
                )
                self.assertEqual((await websocket.next_json())["status"], 409)
                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": "yes",
                    }
                )
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
                history_id = self.admin_app.chat_history.new_turn_id()
                self.admin_app.chat_history.append_user("team_1", history_id, "Resume approval")
                self.admin_app.chat_history.bind_resumable_turn("team_1", history_id)
                websocket = await self._open()
                await websocket.send_json({"type": "sync", "locale": "en"})
                challenge = await websocket.next_json()
                self.assertEqual(challenge["type"], "human-required")
                resume.assert_not_called()

                await websocket.send_json(
                    {
                        "type": "human-response",
                        "challenge_id": CHALLENGE_ID,
                        "decision": "submit",
                        "value": True,
                    }
                )
                self.assertEqual((await websocket.next_json())["type"], "done")
                resume.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
