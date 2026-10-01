"""A frozen Routine run is answered exactly as a paused chat turn is (ADR-0086)."""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team
from team import transport
from test_chat_human_projection import _fingerprinted, _request, _response

from chat import human
from chat import local as chat_local
from routine import answer
from routine import http as routine_http

RUN = "d" * 32
CHALLENGE = "b" * 32
TRACE = "a" * 32
CREDENTIAL = ("openai", "sk-test-0123456789")


def frozen(kind: str = "approval", **overrides: object) -> team.TeamResponse:
    return team.TeamResponse(200, {**_response(_request(kind)), "run_id": RUN, **overrides})


def resumed(status: str = "done", run: str = RUN) -> team.TeamResponse:
    return team.TeamResponse(200, {"team_id": "team_1", "run_id": run, "status": status, "trace_id": TRACE})


def body_request(payload: object) -> Request:
    raw = json.dumps(payload).encode()
    delivered = False

    async def receive():
        nonlocal delivered
        chunk = b"" if delivered else raw
        delivered = True
        return {"type": "http.request", "body": chunk, "more_body": False}

    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode())]
    return Request({"type": "http", "method": "POST", "path": "/", "headers": headers, "query_string": b""}, receive)


class RoutineAnswerTests(unittest.TestCase):
    def setUp(self) -> None:
        answer._CHALLENGES.clear()
        answer._GENERATIONS.clear()
        self.addCleanup(answer._CHALLENGES.clear)
        self.addCleanup(answer._GENERATIONS.clear)
        for patch in (mock.patch.object(chat_local, "model_credential", return_value=CREDENTIAL),):
            patch.start()
            self.addCleanup(patch.stop)

    def open(self, kind: str = "approval") -> dict[str, object]:
        with mock.patch.object(transport, "_call", return_value=frozen(kind)) as call:
            response = answer.open_challenge("team_1", RUN)
        call.assert_called_once_with("POST", f"/v1/teams/team_1/routines/runs/{RUN}/challenge", {})
        self.assertEqual((response.status, response.body["status"]), (200, "human-required"))
        return response.body["challenge"]

    def respond(self, frame: dict[str, object], authenticate=None, resume=None) -> tuple[team.TeamResponse, mock.Mock]:
        authenticate = authenticate or mock.AsyncMock()
        with mock.patch.object(transport, "_call_stream", return_value=resume or resumed()) as stream:
            result = asyncio.run(answer.answer("team_1", RUN, frame, authenticate))
        return result, stream

    def test_an_opened_challenge_is_projected_like_chat_and_answered_once(self) -> None:
        challenge = self.open()
        self.assertEqual(set(challenge), {"type", "challenge_id", "expires_in", "assistant", "action", "request"})
        frame = {"type": "human-response", "challenge_id": CHALLENGE, "decision": "submit", "value": True}
        result, stream = self.respond(frame)
        self.assertEqual(result.body, {"team_id": "team_1", "run_id": RUN, "status": "done"})
        self.assertEqual(stream.call_args.args[1], f"/v1/teams/team_1/routines/runs/{RUN}/human")
        self.assertEqual(stream.call_args.args[2], {"challenge_id": CHALLENGE, "decision": "submit", "value": True})
        self.assertEqual(stream.call_args.kwargs["bindings"].model_credential, CREDENTIAL)
        self.assertIsNone(stream.call_args.kwargs["bindings"].human_assurance)
        stream.call_args.kwargs["progress"]({"type": "progress"})
        # The challenge is one-use.
        again, stream = self.respond(frame)
        self.assertEqual((again.status, again.body["code"]), (409, "human-request-expired"))
        stream.assert_not_called()

    def test_an_opened_challenge_forwards_its_purpose_and_key_page(self) -> None:
        request = {key: value for key, value in _request("input:password").items() if key != "fingerprint"}
        stored = _fingerprinted({**request, "stored_input": "exa-api-key"})
        purpose = "Para trazer as notícias de IA de hoje, preciso pesquisar na web com o Exa."
        help_url = "https://dashboard.exa.ai/api-keys"
        body = {**_response(stored, purpose=purpose, help_url=help_url), "run_id": RUN}
        with mock.patch.object(transport, "_call", return_value=team.TeamResponse(200, body)):
            response = answer.open_challenge("team_1", RUN)
        challenge = response.body["challenge"]
        self.assertEqual((challenge["purpose"], challenge["help_url"]), (purpose, help_url))
        self.assertEqual(challenge["request"], stored)

    def test_a_denial_ends_the_run_and_a_password_is_verified_here(self) -> None:
        self.open()
        deny = {"type": "human-response", "challenge_id": CHALLENGE, "decision": "deny"}
        result, stream = self.respond(deny, resume=resumed("denied"))
        self.assertEqual((result.body["status"], stream.call_args.args[2]["decision"]), ("denied", "deny"))

        self.open("auth:password")
        password = {"type": "human-response", "challenge_id": CHALLENGE, "decision": "submit", "value": "hunter2"}
        wrong = mock.AsyncMock(return_value=human.AuthenticationResult("denied", attempts_remaining=2))
        rejected, stream = self.respond(dict(password), wrong)
        self.assertEqual(
            (rejected.status, rejected.body["code"], rejected.body["attempts_remaining"]),
            (409, "authentication-denied", 2),
        )
        stream.assert_not_called()
        right = mock.AsyncMock(return_value=human.AuthenticationResult("verified"))
        result, stream = self.respond(dict(password), right)
        self.assertEqual(result.status, 200)
        self.assertEqual(
            stream.call_args.kwargs["bindings"].human_assurance, {"kind": "auth:password", "challenge_id": CHALLENGE}
        )
        self.assertNotIn("hunter2", json.dumps(stream.call_args.args[2]))

        self.open("auth:password")
        down = mock.AsyncMock(return_value=human.AuthenticationResult("unavailable"))
        result, stream = self.respond(dict(password), down, resume=resumed("denied"))
        self.assertEqual((result.status, result.body["code"]), (503, "human-authentication-unavailable"))
        self.assertEqual(stream.call_args.args[2]["decision"], "deny")

    def test_a_rejection_never_restores_a_challenge_that_another_tab_replaced(self) -> None:
        self.open("auth:password")
        newer = "c" * 32
        password = {"type": "human-response", "challenge_id": CHALLENGE, "decision": "submit", "value": "hunter2"}

        async def other_tab_opens_meanwhile(*_args):
            # While A awaits authentication, another tab opens B, which cancels A at Team.
            replaced = frozen("auth:password", challenge_id=newer, turn_id=newer)
            with mock.patch.object(transport, "_call", return_value=replaced):
                self.assertEqual(answer.open_challenge("team_1", RUN).body["challenge"]["challenge_id"], newer)
            return human.AuthenticationResult("denied", attempts_remaining=2)

        rejected, stream = self.respond(dict(password), mock.AsyncMock(side_effect=other_tab_opens_meanwhile))
        self.assertEqual((rejected.status, rejected.body["code"]), (409, "authentication-denied"))
        stream.assert_not_called()
        self.assertEqual(list(answer._CHALLENGES), [("team_1", RUN, newer)])
        # B stays answerable, and the obsolete A is not reopened.
        right = mock.AsyncMock(return_value=human.AuthenticationResult("verified"))
        result, stream = self.respond({**password, "challenge_id": newer}, right)
        self.assertEqual(result.status, 200)
        self.assertEqual(stream.call_args.args[2]["challenge_id"], newer)
        stale, stream = self.respond(dict(password), right)
        self.assertEqual((stale.status, stale.body["code"]), (409, "human-request-expired"))
        stream.assert_not_called()

        # B answered and gone also leaves the cache empty: A's late rejection still must not come back.
        self.open("auth:password")

        async def other_tab_opens_and_answers(*_args):
            replaced = frozen("auth:password", challenge_id=newer, turn_id=newer)
            with mock.patch.object(transport, "_call", return_value=replaced):
                answer.open_challenge("team_1", RUN)
            self.assertIsNotNone(answer._take(("team_1", RUN, newer)))
            return human.AuthenticationResult("denied", attempts_remaining=1)

        rejected, _stream = self.respond(dict(password), mock.AsyncMock(side_effect=other_tab_opens_and_answers))
        self.assertEqual(rejected.status, 409)
        self.assertEqual(answer._CHALLENGES, {})

    def test_every_other_answer_is_refused_without_a_resume(self) -> None:
        for response in (
            frozen(run_id="e" * 32),
            frozen(status="integrations-required"),
            team.TeamResponse(409, {"code": "routine-run-not-frozen", "trace_id": TRACE}),
        ):
            with self.subTest(response=response), mock.patch.object(transport, "_call", return_value=response):
                self.assertNotEqual(answer.open_challenge("team_1", RUN).status, 200)
        waiting = team.TeamResponse(
            200, {"team_id": "team_1", "run_id": RUN, "status": "integrations-required", "trace_id": TRACE}
        )
        with mock.patch.object(transport, "_call", return_value=waiting):
            self.assertEqual(answer.open_challenge("team_1", RUN).body["status"], "integrations-required")
        with mock.patch.object(
            transport, "_call", return_value=team.TeamResponse(200, {**waiting.body, "run_id": "e" * 32})
        ):
            self.assertEqual(answer.open_challenge("team_1", RUN).status, 502)
        with self.assertRaises(team.TeamRequestError):
            answer.open_challenge("team_1", "x")
        self.open()
        frame = {"type": "human-response", "challenge_id": CHALLENGE, "decision": "submit", "value": True}
        result, _stream = self.respond(frame, resume=resumed(run="e" * 32))
        self.assertEqual(result.status, 502)

    def test_an_integration_resume_needs_the_team_model_key(self) -> None:
        with mock.patch.object(transport, "_call_stream", return_value=resumed("frozen")) as stream:
            self.assertEqual(answer.resume_integrations("team_1", RUN).body["status"], "frozen")
        self.assertEqual(stream.call_args.args[1], f"/v1/teams/team_1/routines/runs/{RUN}/integrations")
        missing = team.TeamResponse(409, {"code": "model-credential-missing"})
        with (
            mock.patch.object(chat_local, "model_credential", return_value=missing),
            mock.patch.object(transport, "_call_stream") as stream,
        ):
            self.assertIs(answer.resume_integrations("team_1", RUN), missing)
        stream.assert_not_called()

    def test_open_challenges_are_bounded_and_one_per_team(self) -> None:
        for index in range(answer.MAX_OPEN_CHALLENGES + 1):
            answer._remember((f"team_{index}", RUN, CHALLENGE), 10**12, {})
        self.assertEqual(len(answer._CHALLENGES), answer.MAX_OPEN_CHALLENGES)
        answer._remember(("team_1", RUN, "c" * 32), 10**12, {})
        self.assertEqual([key for key in answer._CHALLENGES if key[0] == "team_1"], [("team_1", RUN, "c" * 32)])
        answer._remember(("team_x", RUN, CHALLENGE), 0, {})
        answer._remember(("team_y", RUN, CHALLENGE), 10**12, {})
        self.assertNotIn(("team_x", RUN, CHALLENGE), answer._CHALLENGES)

    def test_routes_bind_chat_password_authority_and_refuse_malformed_answers(self) -> None:
        authenticate = mock.AsyncMock()
        route = routine_http.human_route(authenticate)
        ok = team.TeamResponse(200, {"ok": True})
        with (
            mock.patch.object(answer, "answer", new=mock.AsyncMock(return_value=ok)) as answered,
            mock.patch.object(answer, "open_challenge", return_value=ok),
            mock.patch.object(answer, "resume_integrations", return_value=ok),
        ):
            responses = [
                asyncio.run(route("team_1", RUN, body_request({"type": "human-response"}))),
                asyncio.run(routine_http.routine_challenge("team_1", RUN)),
                asyncio.run(routine_http.routine_integrations("team_1", RUN)),
            ]
        self.assertIs(answered.call_args.args[3], authenticate)
        for response in responses:
            self.assertEqual((response.status_code, response.headers["Cache-Control"]), (200, "no-store"))
        with (
            mock.patch.object(answer, "answer", new=mock.AsyncMock(side_effect=team.TeamRequestError("x"))),
            self.assertRaises(HTTPException) as refused,
        ):
            asyncio.run(route("team_1", RUN, body_request({})))
        self.assertEqual(refused.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
