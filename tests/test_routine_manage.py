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

from protocol.http.v1 import routine as routine_contract
from routine import http as routine_http
from routine import manage

VECTORS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())["routine_views"]
ROUTINE = VECTORS["routine"]["valid"][0]
RUN = VECTORS["run"]["valid"][1]
INCIDENT = VECTORS["incident"]["valid"][0]
CARD = {**VECTORS["card"]["valid"][0], "incident_id": "c" * 32}
ANSWERED = {**VECTORS["card_answer"]["valid"][0], "incident_id": "c" * 32}
PAGE = VECTORS["page"]["valid"][1]
RUN_STEPS = VECTORS["run_steps"]["valid"][1]
DIAGNOSTICS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())["routine_diagnostics"]["valid"]
TRACE = "a" * 32
ID = "c" * 32


def answer(body: dict[str, object], status: int = 200) -> team.TeamResponse:
    return team.TeamResponse(status, {**body, "trace_id": TRACE} if status < 300 else body)


def request(payload: object, application: object = None) -> Request:
    body = json.dumps(payload).encode()
    delivered = False

    async def receive():
        nonlocal delivered
        chunk = b"" if delivered else body
        delivered = True
        return {"type": "http.request", "body": chunk, "more_body": False}

    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    scope = {"type": "http", "method": "POST", "path": "/", "headers": headers, "query_string": b""}
    return Request({**scope, "app": application or FastAPI()}, receive)


class RoutineManageTests(unittest.TestCase):
    def call(self, response: team.TeamResponse):
        return mock.patch.object(transport, "_call", return_value=response)

    def test_each_answer_is_admitted_only_in_its_view_and_errors_carry_only_a_safe_code(self) -> None:
        listed = {"team_id": "team_1", "routines": [ROUTINE], "runs": [RUN], "incidents": [INCIDENT]}
        with self.call(answer(listed)) as call:
            self.assertEqual(manage.list_routines("team_1").body, listed)
        # The whole list is read within its own protocol allowance, never another answer's cap.
        call.assert_called_once_with(
            "GET", "/v1/teams/team_1/routines", max_response_bytes=routine_contract.MAX_ROUTINE_LIST_BYTES
        )
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

    def test_a_card_and_its_answer_are_admitted_only_for_the_team_and_incident_asked_for(self) -> None:
        # A recovery card and its answer are admitted only for exactly the Team and incident asked for.
        with self.call(answer(CARD)) as call:
            self.assertEqual(manage.open_card("team_1", ID).body, CARD)
        call.assert_called_once_with("POST", f"/v1/teams/team_1/routines/incidents/{ID}/card", {})
        for foreign in ({**CARD, "incident_id": "d" * 32}, {**CARD, "team_id": "team_2"}, {**CARD, "choices": []}):
            with self.subTest(card=foreign), self.call(answer(foreign)):
                self.assertEqual(manage.open_card("team_1", ID).status, 502)
        # Rodar runs no model, so it never carries the model credential.
        chosen = {"nonce": CARD["nonce"], "choice": "run"}
        with self.call(answer(ANSWERED)) as call:
            self.assertEqual(manage.answer_card("team_1", ID, chosen).body, ANSWERED)
        call.assert_called_once_with(
            "POST", f"/v1/teams/team_1/routines/incidents/{ID}/answer", chosen, model_credential=None
        )
        with self.call(answer({**ANSWERED, "status": "recreated"})):
            self.assertEqual(manage.answer_card("team_1", ID, chosen).status, 502)
        # Recriar carries exactly the Team's model credential, which the Supervisor assertion then binds.
        recreate = {"nonce": CARD["nonce"], "choice": "recreate"}
        recreated = {**ANSWERED, "choice": "recreate", "status": "recreated"}
        with (
            mock.patch.object(manage.chat_local, "model_credential", return_value=("openai", "sk-test")) as key,
            self.call(answer(recreated)) as call,
        ):
            self.assertEqual(manage.answer_card("team_1", ID, recreate).body, recreated)
        key.assert_called_once_with("team_1")
        call.assert_called_once_with(
            "POST",
            f"/v1/teams/team_1/routines/incidents/{ID}/answer",
            recreate,
            model_credential=("openai", "sk-test"),
        )
        # Without a stored key, Team is never asked and the person is told why.
        missing = team.TeamResponse(409, {"code": "model-credential-missing"})
        with (
            mock.patch.object(manage.chat_local, "model_credential", return_value=missing),
            self.call(answer(recreated)) as call,
        ):
            self.assertIs(manage.answer_card("team_1", ID, recreate), missing)
        call.assert_not_called()

    def test_a_plan_page_is_admitted_only_for_exactly_the_routine_revision_and_offset_asked_for(self) -> None:
        routine = PAGE["routine_id"]
        with self.call(answer(PAGE)) as call:
            self.assertEqual(manage.plan_steps("team_1", routine, "2", "1").body, PAGE)
        call.assert_called_once_with("GET", f"/v1/teams/team_1/routines/{routine}/revisions/2/steps/1")
        for foreign, asked in (
            (PAGE, (ID, "2", "1")),
            (PAGE, (routine, "3", "1")),
            (PAGE, (routine, "2", "0")),
            ({**PAGE, "steps": [{**PAGE["steps"][0], "id": "zones"}, PAGE["steps"][1]]}, (routine, "2", "1")),
        ):
            with self.subTest(asked=asked), self.call(answer(foreign)):
                self.assertEqual(manage.plan_steps("team_1", *asked).status, 502)
        # A revision that is no longer current is refused by Team and passed on by its safe code.
        changed = answer({"code": "routine-revision-changed", "trace_id": TRACE}, 409)
        with self.call(changed):
            response = manage.plan_steps("team_1", routine, "2", "1")
        self.assertEqual((response.status, response.body), (409, {"code": "routine-revision-changed"}))

    def test_a_run_steps_page_is_admitted_only_for_its_run_offset_and_snapshot(self) -> None:
        run, snapshot = RUN_STEPS["run_id"], RUN_STEPS["snapshot"]
        # latest names no snapshot yet, so it admits the one Team names; a later page asks for exactly that one.
        for asked in ("latest", snapshot):
            with self.subTest(snapshot=asked), self.call(answer(RUN_STEPS)) as call:
                self.assertEqual(manage.run_steps("team_1", run, asked, "64").body, RUN_STEPS)
            call.assert_called_once_with("GET", f"/v1/teams/team_1/routines/runs/{run}/steps/{asked}/64")
        for foreign, asked in (
            (RUN_STEPS, (ID, "latest", "64")),
            (RUN_STEPS, (run, "latest", "0")),
            (RUN_STEPS, (run, "e" * 32, "64")),
            ({**RUN_STEPS, "team_id": "team_2"}, (run, "latest", "64")),
            ({**RUN_STEPS, "steps": [{**RUN_STEPS["steps"][0], "raw_input": "x"}]}, (run, "latest", "64")),
        ):
            with self.subTest(asked=asked), self.call(answer(foreign)):
                self.assertEqual(manage.run_steps("team_1", *asked).status, 502)
        changed = answer({"code": "routine-run-changed", "trace_id": TRACE}, 409)
        with self.call(changed):
            response = manage.run_steps("team_1", run, snapshot, "64")
        self.assertEqual((response.status, response.body), (409, {"code": "routine-run-changed"}))

    def test_requests_are_refused_before_reaching_team(self) -> None:
        with mock.patch.object(transport, "_call") as call:
            for refused in (
                lambda: manage.list_routines("Team 1"),
                lambda: manage.delete("team_1", "../x"),
                lambda: manage.stop("team_1", "x"),
                lambda: manage.open_card("team_1", "x"),
                lambda: manage.answer_card("team_1", "x", {"nonce": "c" * 32, "choice": "run"}),
                lambda: manage.answer_card("team_1", ID, {"nonce": "c" * 32, "choice": "other"}),
                # Excluir is the confirmed deletion route, and the retired choices are refused before Team.
                lambda: manage.answer_card("team_1", ID, {"nonce": "c" * 32, "choice": "delete"}),
                lambda: manage.answer_card("team_1", ID, {"nonce": "c" * 32, "choice": "verify"}),
                lambda: manage.answer_card("team_1", ID, {"nonce": "c" * 32, "choice": "skip"}),
                lambda: manage.answer_card("team_1", ID, {"nonce": "c" * 32, "choice": "pause"}),
                lambda: manage.answer_card("team_1", ID, []),
                lambda: manage.resume("team_1", "x"),
                lambda: manage.diagnostics("team_1", "../x"),
                lambda: manage.pause("team_1", "x"),
                lambda: manage.plan_steps("team_1", "x", "1", "0"),
                lambda: manage.plan_steps("team_1", ID, "0", "0"),
                lambda: manage.plan_steps("team_1", ID, "01", "0"),
                lambda: manage.plan_steps("team_1", ID, str(2**31), "0"),
                lambda: manage.plan_steps("team_1", ID, "1", "-1"),
                lambda: manage.plan_steps("team_1", ID, "1", str(routine_contract.MAX_ROUTINE_STEPS)),
                lambda: manage.plan_steps("team_1", ID, 1, "0"),
                lambda: manage.run_steps("team_1", "x", "latest", "0"),
                lambda: manage.run_steps("team_1", ID, "LATEST", "0"),
                lambda: manage.run_steps("team_1", ID, None, "0"),
                lambda: manage.run_steps("team_1", ID, "latest", "1e3"),
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
        self.assertEqual(sum("routines" in route.path for route in local.routes), 14)
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
            plan_steps=mock.Mock(return_value=ok),
            run_steps=mock.Mock(return_value=ok),
        ):
            chosen = {"nonce": "c" * 32, "choice": "run"}
            # A successful answer wakes the scheduler, so a Rodar run is claimed at once.
            scheduled = FastAPI()
            scheduled.state.routine_scheduler = mock.Mock()
            responses = [
                routine_http.routines_list("team_1"),
                asyncio.run(routine_http.routine_stop("team_1", ID)),
                asyncio.run(routine_http.routine_resume("team_1", ID)),
                asyncio.run(routine_http.routine_card("team_1", ID)),
                asyncio.run(routine_http.routine_diagnostics("team_1", ID)),
                asyncio.run(routine_http.routine_pause("team_1", ID)),
                asyncio.run(routine_http.routine_plan_steps("team_1", ID, "2", "0")),
                asyncio.run(routine_http.routine_run_steps("team_1", ID, "latest", "0")),
                asyncio.run(routine_http.routine_card_answer("team_1", ID, request(chosen, scheduled))),
            ]
            scheduled.state.routine_scheduler.wake.assert_called_once_with()
            manage.answer_card.assert_called_once_with("team_1", ID, chosen)
            manage.open_card.assert_called_once_with("team_1", ID)
            manage.diagnostics.assert_called_once_with("team_1", ID)
            manage.plan_steps.assert_called_once_with("team_1", ID, "2", "0")
            manage.run_steps.assert_called_once_with("team_1", ID, "latest", "0")
        for response in responses:
            self.assertEqual((response.status_code, response.headers["Cache-Control"]), (200, "no-store"))

    def test_only_an_answered_card_wakes_the_scheduler_and_none_is_needed(self) -> None:
        chosen = {"nonce": "c" * 32, "choice": "run"}
        stale = team.TeamResponse(409, {"code": "routine-card-stale"})
        scheduled = FastAPI()
        scheduled.state.routine_scheduler = mock.Mock()
        with mock.patch.object(manage, "answer_card", return_value=stale):
            refused = asyncio.run(routine_http.routine_card_answer("team_1", ID, request(chosen, scheduled)))
        self.assertEqual((refused.status_code, refused.headers["Cache-Control"]), (409, "no-store"))
        scheduled.state.routine_scheduler.wake.assert_not_called()
        # An Admin without a running scheduler still answers the card; nothing is woken.
        with mock.patch.object(manage, "answer_card", return_value=team.TeamResponse(200, {"ok": True})):
            answered = asyncio.run(routine_http.routine_card_answer("team_1", ID, request(chosen)))
        self.assertEqual((answered.status_code, answered.headers["Cache-Control"]), (200, "no-store"))


if __name__ == "__main__":
    unittest.main()
