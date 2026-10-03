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

import local_auth
from team import bridge as team
from team import transport

from routine import http as routine_http
from routine import manage

VECTORS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())["routine_views"]
ROUTINE = VECTORS["routine"]["valid"][0]
RUN = VECTORS["run"]["valid"][1]
INCIDENT = VECTORS["incident"]["valid"][0]
CARD = {**VECTORS["card"]["valid"][0], "incident_id": "c" * 32}
ANSWERED = {**VECTORS["card_answer"]["valid"][0], "incident_id": "c" * 32}
DIAGNOSTICS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())["routine_diagnostics"]["valid"]
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
        listed = {"team_id": "team_1", "routines": [ROUTINE], "runs": [RUN], "incidents": [INCIDENT]}
        with self.call(answer(listed)):
            self.assertEqual(manage.list_routines("team_1").body, listed)
        for untraced in (team.TeamResponse(200, dict(listed)), team.TeamResponse(200, {**listed, "trace_id": "x"})):
            with self.subTest(untraced=untraced), self.call(untraced):
                self.assertEqual(manage.list_routines("team_1").body, {"code": "routine-response-invalid"})
        for invalid in (
            {**listed, "runs": [{**RUN, "status": "running"}]},
            {**listed, "routines": [ROUTINE] * 9},
            {**listed, "incidents": [INCIDENT] * 33},
            {**listed, "incidents": [{**INCIDENT, "status": "unresolved"}]},
            {key: value for key, value in listed.items() if key != "incidents"},
        ):
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
        # A recovery card and its answer are admitted only for exactly the Team and incident asked for.
        with self.call(answer(CARD)) as call:
            self.assertEqual(manage.open_card("team_1", ID).body, CARD)
        call.assert_called_once_with("POST", f"/v1/teams/team_1/routines/incidents/{ID}/card", {})
        for foreign in ({**CARD, "incident_id": "d" * 32}, {**CARD, "team_id": "team_2"}, {**CARD, "choices": []}):
            with self.subTest(card=foreign), self.call(answer(foreign)):
                self.assertEqual(manage.open_card("team_1", ID).status, 502)
        chosen = {"nonce": CARD["nonce"], "choice": "verify"}
        with self.call(answer(ANSWERED)) as call:
            self.assertEqual(manage.answer_card("team_1", ID, chosen).body, ANSWERED)
        call.assert_called_once_with("POST", f"/v1/teams/team_1/routines/incidents/{ID}/answer", chosen)
        with self.call(answer({**ANSWERED, "status": "skipped"})):
            self.assertEqual(manage.answer_card("team_1", ID, chosen).status, 502)
        # A run's execution details are admitted only in their sanitized view, for exactly the run asked for.
        details = {**DIAGNOSTICS[1], "run_id": ID}
        with self.call(answer(details)) as call:
            self.assertEqual(manage.diagnostics("team_1", ID).body, details)
        call.assert_called_once_with("GET", f"/v1/teams/team_1/routines/runs/{ID}/diagnostics")
        for foreign in (
            {**details, "run_id": "d" * 32},
            {**details, "team_id": "team_2"},
            {**details, "diagnostics": [{**details["diagnostics"][0], "raw_output": "secret"}]},
        ):
            with self.subTest(diagnostics=foreign), self.call(answer(foreign)):
                self.assertEqual(manage.diagnostics("team_1", ID).status, 502)
        with self.call(answer({"team_id": "team_1", "routine_id": ID, "paused": False})) as call:
            self.assertFalse(manage.resume("team_1", ID).body["paused"])
        call.assert_called_once_with("POST", f"/v1/teams/team_1/routines/{ID}/resume", {})
        with self.call(answer({"team_id": "team_1", "routine_id": ID, "paused": True})):
            self.assertEqual(manage.resume("team_1", ID).status, 502)
        with self.call(answer({"team_id": "team_1", "routine_id": ID, "paused": True})) as call:
            self.assertTrue(manage.pause("team_1", ID).body["paused"])
        call.assert_called_once_with("POST", f"/v1/teams/team_1/routines/{ID}/pause", {})
        with self.call(answer({"team_id": "team_1", "routine_id": ID, "paused": False})):
            self.assertEqual(manage.pause("team_1", ID).status, 502)
        with self.call(answer({"team_id": "team_1", "run_id": "d" * 32, "stopped": True})):
            self.assertEqual(manage.stop("team_1", ID).status, 502)
        for error, expected in (
            (
                answer({"code": "routine-card-stale", "error": "x", "trace_id": TRACE}, 409),
                (409, "routine-card-stale"),
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
                lambda: manage.list_routines("Team 1"),
                lambda: manage.delete("team_1", "../x"),
                lambda: manage.stop("team_1", "x"),
                lambda: manage.open_card("team_1", "x"),
                lambda: manage.answer_card("team_1", "x", {"nonce": "c" * 32, "choice": "skip"}),
                lambda: manage.answer_card("team_1", ID, {"nonce": "c" * 32, "choice": "other"}),
                lambda: manage.answer_card("team_1", ID, []),
                lambda: manage.resume("team_1", "x"),
                lambda: manage.diagnostics("team_1", "../x"),
                lambda: manage.pause("team_1", "x"),
            ):
                with self.assertRaises(team.TeamRequestError):
                    refused()
        call.assert_not_called()


class RoutineRouteTests(unittest.TestCase):
    def test_routes_exist_only_on_local_and_are_never_cached(self) -> None:
        hosted = FastAPI()
        routine_http.register(hosted, "hosted", mock.AsyncMock(), local_auth.Context())
        self.assertEqual([route.path for route in hosted.routes if "routines" in route.path], [])
        local = FastAPI()
        routine_http.register(local, "local", mock.AsyncMock(), local_auth.Context())
        # A Routine is created from the chat (ADR-0092): there is no confirmation or preview route. Deleting one is
        # the Supervisor's password route then the second-factor DELETE (ADR-0051).
        self.assertEqual(sum("routines" in route.path for route in local.routes), 12)
        # The retired release of an uncertain run stays absent.
        self.assertFalse(any(route.path.endswith("/resolve") for route in local.routes))
        self.assertFalse(any("proposals" in route.path for route in local.routes))
        ok = team.TeamResponse(200, {"ok": True})
        with mock.patch.multiple(
            manage,
            list_routines=mock.Mock(return_value=ok),
            delete=mock.Mock(return_value=ok),
            stop=mock.Mock(return_value=ok),
            resume=mock.Mock(return_value=ok),
            open_card=mock.Mock(return_value=ok),
            answer_card=mock.Mock(return_value=ok),
            diagnostics=mock.Mock(return_value=ok),
            pause=mock.Mock(return_value=ok),
        ):
            chosen = {"nonce": "c" * 32, "choice": "pause"}
            responses = [
                routine_http.routines_list("team_1"),
                asyncio.run(routine_http.routine_stop("team_1", ID)),
                asyncio.run(routine_http.routine_resume("team_1", ID)),
                asyncio.run(routine_http.routine_card("team_1", ID)),
                asyncio.run(routine_http.routine_diagnostics("team_1", ID)),
                asyncio.run(routine_http.routine_pause("team_1", ID)),
                asyncio.run(routine_http.routine_card_answer("team_1", ID, request(chosen))),
            ]
            manage.answer_card.assert_called_once_with("team_1", ID, chosen)
            manage.open_card.assert_called_once_with("team_1", ID)
            manage.diagnostics.assert_called_once_with("team_1", ID)
        for response in responses:
            self.assertEqual((response.status_code, response.headers["Cache-Control"]), (200, "no-store"))


if __name__ == "__main__":
    unittest.main()
