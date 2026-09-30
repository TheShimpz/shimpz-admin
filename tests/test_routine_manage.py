"""A Local Supervisor's Routine management admits Team's answers only in their closed protocol views (ADR-0086)."""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team
from team import transport

from routine import http as routine_http
from routine import manage

VECTORS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())["routine_views"]
ROUTINE = VECTORS["routine"]["valid"][0]
RUN = VECTORS["run"]["valid"][1]
PREVIEW = VECTORS["preview"]["valid"][0]
TRACE = "a" * 32
ID = "c" * 32


def answer(body: dict[str, object], status: int = 200) -> team.TeamResponse:
    return team.TeamResponse(status, {**body, "trace_id": TRACE} if status < 300 else body)


def request(payload: object) -> Request:
    body = json.dumps(payload).encode()
    delivered = False

    async def receive():
        nonlocal delivered
        chunk = b"" if delivered else body
        delivered = True
        return {"type": "http.request", "body": chunk, "more_body": False}

    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    return Request({"type": "http", "method": "POST", "path": "/", "headers": headers, "query_string": b""}, receive)


class RoutineManageTests(unittest.TestCase):
    def call(self, response: team.TeamResponse):
        return mock.patch.object(transport, "_call", return_value=response)

    def test_each_answer_is_admitted_only_in_its_view_and_errors_carry_only_a_safe_code(self) -> None:
        with self.call(answer(PREVIEW)) as call:
            self.assertEqual(manage.preview("team_1", ID, {"timezone": "UTC"}).body, PREVIEW)
        call.assert_called_once_with("POST", f"/v1/teams/team_1/routines/proposals/{ID}/preview", {"timezone": "UTC"})
        for invalid in (
            answer({**PREVIEW, "fits": "yes"}),
            # A live preview of another proposal is never shown on this card.
            answer({**PREVIEW, "proposal_id": "d" * 32}),
            team.TeamResponse(200, {**PREVIEW, "trace_id": "not-a-trace"}),
            team.TeamResponse(200, dict(PREVIEW)),
        ):
            with self.subTest(invalid=invalid), self.call(invalid):
                self.assertEqual(
                    manage.preview("team_1", ID, {"timezone": "UTC"}).body, {"code": "routine-response-invalid"}
                )
        with self.call(answer({"team_id": "team_1", "routine": ROUTINE})):
            self.assertEqual(manage.confirm("team_1", {"proposal_id": ID, "timezone": "UTC"}).body["routine"], ROUTINE)
        with self.call(answer({"team_id": "team_1", "routine_id": ID, "deleted": True})):
            self.assertTrue(manage.confirm("team_1", {"proposal_id": ID, "timezone": "UTC"}).body["deleted"])
        with self.call(answer({"team_id": "team_2", "routine": ROUTINE})):
            self.assertEqual(manage.confirm("team_1", {"proposal_id": ID, "timezone": "UTC"}).status, 502)
        listed = {"team_id": "team_1", "routines": [ROUTINE], "runs": [RUN]}
        with self.call(answer(listed)):
            self.assertEqual(manage.list_routines("team_1").body, listed)
        for invalid in ({**listed, "runs": [{**RUN, "status": "running"}]}, {**listed, "routines": [ROUTINE] * 9}):
            with self.subTest(invalid=invalid), self.call(answer(invalid)):
                self.assertEqual(manage.list_routines("team_1").status, 502)
        with self.call(answer({"team_id": "team_1", "routine_id": ID, "deleted": False})) as call:
            self.assertFalse(manage.delete("team_1", ID).body["deleted"])
        call.assert_called_once_with("DELETE", f"/v1/teams/team_1/routines/{ID}")
        with self.call(answer({"team_id": "team_1", "routine_id": "d" * 32, "deleted": True})):
            self.assertEqual(manage.delete("team_1", ID).status, 502)
        with self.call(answer({"team_id": "team_1", "run_id": ID, "stopped": True})) as call:
            self.assertTrue(manage.stop("team_1", ID).body["stopped"])
        call.assert_called_once_with("POST", f"/v1/teams/team_1/routines/runs/{ID}/stop", {})
        with self.call(answer({"team_id": "team_1", "run_id": ID, "resolved": True})) as call:
            self.assertTrue(manage.resolve("team_1", ID, {"batch_fingerprint": "e" * 64}).body["resolved"])
        with self.call(answer({"team_id": "team_1", "run_id": "d" * 32, "stopped": True})):
            self.assertEqual(manage.stop("team_1", ID).status, 502)
        for error, expected in (
            (
                answer({"code": "routine-run-uncertain", "error": "x", "trace_id": TRACE}, 409),
                (409, "routine-run-uncertain"),
            ),
            (answer({"code": "Bad Code", "error": "private detail"}, 500), (500, "routine-request-failed")),
            (answer({"detail": "team unavailable"}, 302), (502, "routine-request-failed")),
            (team.TeamResponse(503, ["not", "an", "object"]), (503, "routine-request-failed")),
        ):
            with self.subTest(error=error), self.call(error):
                response = manage.delete("team_1", ID)
                self.assertEqual((response.status, response.body), (expected[0], {"code": expected[1]}))

    def test_requests_are_refused_before_reaching_team(self) -> None:
        with mock.patch.object(transport, "_call") as call:
            for refused in (
                lambda: manage.preview("team_1", "x", {"timezone": "UTC"}),
                lambda: manage.preview("team_1", ID, {"timezone": "../etc"}),
                lambda: manage.preview("team_1", ID, {"timezone": "UTC", "extra": 1}),
                lambda: manage.confirm("team_1", {"proposal_id": "x", "timezone": "UTC"}),
                lambda: manage.confirm("Team 1", {"proposal_id": ID, "timezone": "UTC"}),
                lambda: manage.delete("team_1", "../x"),
                lambda: manage.stop("team_1", "x"),
                lambda: manage.resolve("team_1", ID, {"batch_fingerprint": "x"}),
                lambda: manage.resolve("team_1", ID, []),
            ):
                with self.assertRaises(team.TeamRequestError):
                    refused()
        call.assert_not_called()


class RoutineRouteTests(unittest.TestCase):
    def test_routes_exist_only_on_local_and_are_never_cached(self) -> None:
        hosted = FastAPI()
        routine_http.register(hosted, "hosted", mock.AsyncMock())
        self.assertEqual([route.path for route in hosted.routes if "routines" in route.path], [])
        local = FastAPI()
        routine_http.register(local, "local", mock.AsyncMock())
        self.assertEqual(sum("routines" in route.path for route in local.routes), 9)
        ok = team.TeamResponse(200, {"ok": True})
        with mock.patch.multiple(
            manage,
            list_routines=mock.Mock(return_value=ok),
            preview=mock.Mock(return_value=ok),
            confirm=mock.Mock(return_value=ok),
            delete=mock.Mock(return_value=ok),
            stop=mock.Mock(return_value=ok),
            resolve=mock.Mock(return_value=ok),
        ):
            responses = [
                routine_http.routines_list("team_1"),
                asyncio.run(routine_http.routine_preview("team_1", ID, request({"timezone": "UTC"}))),
                asyncio.run(routine_http.routine_confirm("team_1", request({"proposal_id": ID, "timezone": "UTC"}))),
                asyncio.run(routine_http.routine_delete("team_1", ID)),
                asyncio.run(routine_http.routine_stop("team_1", ID)),
                asyncio.run(routine_http.routine_resolve("team_1", ID, request({"batch_fingerprint": "e" * 64}))),
            ]
            manage.resolve.assert_called_once_with("team_1", ID, {"batch_fingerprint": "e" * 64})
        for response in responses:
            self.assertEqual((response.status_code, response.headers["Cache-Control"]), (200, "no-store"))


if __name__ == "__main__":
    unittest.main()
