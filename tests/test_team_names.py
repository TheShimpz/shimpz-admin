"""Local Team names (ADR-0088): rename and create through the real ASGI stack, and the bridge's own checks."""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi import FastAPI, HTTPException
from team import bridge as team
from team import names as team_names
from test_app_route_edges import _request
from test_team_bridge_assistants import _asgi_request, _LiveTeamCase, _probe_session, _TeamHandler

TRACE_ID = "a" * 32


def _team(method: str, path: str, body: bytes) -> tuple[int, bytes]:
    """A Local Team: renames echo the name, one name is taken, and create conflicts on two held ids."""
    name = json.loads(body)["team_name"] if body else None
    if method == "PATCH" and name == "Taken":
        return 409, json.dumps({"detail": "another Team already has this name", "code": "team-name-taken"}).encode()
    if method == "PATCH":
        echoed = "Other" if name == "Tampered" else name
        return 200, json.dumps({"team_id": "team_1", "team_name": echoed, "trace_id": TRACE_ID}).encode()
    team_id = path.split("/")[3]
    if team_id in {"marketing", "marketing_2"}:
        conflict = {"detail": "Team id already belongs to a different name", "code": "team-name-conflict"}
        return 409, json.dumps(conflict).encode()
    created = {"team_id": team_id, "team_name": name, "status": "running", "created": True}
    return 200, json.dumps(created).encode()


class TeamNameRouteTests(_LiveTeamCase):
    def setUp(self) -> None:
        super().setUp()
        _TeamHandler.responder = staticmethod(_team)

    def probe(self, scenario: str) -> dict[str, object]:
        return self._run_asgi_probe(scenario, Path(__file__).resolve())

    def test_rename_needs_an_admitted_origin_and_sends_exactly_one_nfc_name(self) -> None:
        document = self.probe("team-rename")
        refused = {"status": 403, "body": {"detail": "browser origin is not admitted"}}
        self.assertEqual((document["no_origin"], document["foreign_origin"]), (refused, refused))
        self.assertEqual(document["malformed"]["status"], 400)
        self.assertEqual(document["decomposed"], {"status": 200, "body": {"team_id": "team_1", "team_name": "Équipe"}})
        self.assertEqual(document["valid"], {"status": 200, "body": {"team_id": "team_1", "team_name": "Growth"}})
        self.assertEqual(
            document["taken"],
            {"status": 409, "body": {"detail": "another Team already has this name", "code": "team-name-taken"}},
        )
        self.assertEqual(document["tampered"], {"status": 502, "body": {"detail": "Team rename response is invalid."}})
        self.assertEqual(
            [json.loads(request["body"]) for request in _TeamHandler.requests],
            [{"team_name": name} for name in ("Équipe", "Growth", "Taken", "Tampered")],
        )
        self.assertTrue(all(request["method"] == "PATCH" for request in _TeamHandler.requests))

    def test_a_name_whose_id_a_renamed_team_holds_is_created_under_the_next_free_suffix(self) -> None:
        document = self.probe("team-create")
        self.assertEqual(document["status"], 200)
        self.assertEqual(document["body"]["team_id"], "marketing_3")
        self.assertEqual(
            [request["path"] for request in _TeamHandler.requests],
            [f"/v1/teams/{team_id}/create" for team_id in ("marketing", "marketing_2", "marketing_3")],
        )


class TeamNameBoundaryTests(unittest.TestCase):
    def test_rename_admits_only_the_exact_answer_for_its_own_request(self) -> None:
        for body in (
            {"team_id": "team_2", "team_name": "Growth"},
            {"team_id": "team_1", "team_name": "Growth", "extra": 1},
            {"team_id": "team_1", "team_name": "Growth", "trace_id": "bad"},
        ):
            with self.subTest(body=body), mock.patch.object(team, "_call", return_value=team.TeamResponse(200, body)):
                self.assertEqual(team.rename("team_1", "Growth").status, 502)
        exact = {"team_id": "team_1", "team_name": "Growth"}
        with mock.patch.object(team, "_call", return_value=team.TeamResponse(200, exact)):
            self.assertEqual(team.rename("team_1", "Growth").body, exact)
        with self.assertRaises(team.TeamRequestError):
            team.rename("team_1", "Équipe")

    def test_confirmed_deletion_sends_the_expected_name_to_team(self) -> None:
        with mock.patch.object(team, "_call", return_value=team.TeamResponse(200, {})) as call:
            team.destroy_confirmed("team_1", "Growth")
        call.assert_called_once_with("DELETE", "/v1/teams/team_1", {"team_name": "Growth"})

    def test_suffixes_stay_inside_the_id_grammar_and_exhaustion_keeps_the_conflict(self) -> None:
        ids = team_names._candidate_ids("x" * 60)
        self.assertEqual(len(ids), team_names.MAX_ID_SUFFIX)
        self.assertTrue(all(len(team_id) <= 40 and team.canonical_team_id(team_id) == team_id for team_id in ids))
        conflict = team.TeamResponse(409, {"code": "team-name-conflict"})
        with mock.patch.object(team_names.bridge, "create", return_value=conflict) as create:
            self.assertEqual(team_names._create("Marketing"), ("marketing_9", conflict))
        self.assertEqual(create.call_count, team_names.MAX_ID_SUFFIX)
        with self.assertRaises(team_names.HTTPException):
            team_names._candidate_ids("!!!")


class TeamNameInProcessTests(unittest.TestCase):
    """The same routes in process: the rename endpoint and Team creation."""

    def rename_endpoint(self):
        app = FastAPI()
        team_names.register(app, lambda: frozenset({"https://admin.example.test"}))
        (route,) = [route for route in app.routes if getattr(route, "methods", None) == {"PATCH"}]
        return route.endpoint

    def test_the_rename_endpoint_answers_without_caching_and_passes_team_refusals_through(self) -> None:
        endpoint = self.rename_endpoint()
        headers = [(b"origin", b"https://admin.example.test"), (b"content-type", b"application/json")]
        taken = team.TeamResponse(409, {"detail": "another Team already has this name", "code": "team-name-taken"})
        with mock.patch.object(team, "_call", return_value=taken) as call:
            response = asyncio.run(endpoint("team_1", _request(body=b'{"team_name":"Growth"}', headers=headers)))
        call.assert_called_once_with("PATCH", "/v1/teams/team_1", {"team_name": "Growth"})
        self.assertEqual((response.status_code, response.headers["Cache-Control"]), (409, "no-store"))
        for origin in (None, b"HTTPS://ADMIN.EXAMPLE.TEST", b" https://admin.example.test", b"https://other.test"):
            sent = [(b"content-type", b"application/json")] + ([] if origin is None else [(b"origin", origin)])
            with self.subTest(origin=origin), self.assertRaises(HTTPException) as refused:
                asyncio.run(endpoint("team_1", _request(body=b'{"team_name":"Growth"}', headers=sent)))
            self.assertEqual(refused.exception.status_code, 403)
            self.assertEqual(refused.exception.headers, {"Cache-Control": "no-store"})
        for body in (b'{"team_name":1}', b'{"team_name":""}'):
            with self.subTest(body=body), self.assertRaises(HTTPException) as invalid:
                asyncio.run(endpoint("team_1", _request(body=body, headers=headers)))
            self.assertEqual(invalid.exception.status_code, 400)
            self.assertEqual(invalid.exception.headers, {"Cache-Control": "no-store"})

    def test_local_creation_clears_history_for_the_id_it_created(self) -> None:
        created = team.TeamResponse(200, {"team_id": "marketing", "team_name": "Marketing", "created": True})
        with (
            mock.patch.object(team_names.bridge, "create", return_value=created),
            mock.patch.object(
                team_names.chat_history_http, "team_created", side_effect=lambda _id, result: result
            ) as history,
        ):
            response = team_names.create({"team_name": " Marketing "})
        history.assert_called_once_with("marketing", created)
        self.assertEqual(response.status_code, 200)


def _run_asgi_probe(scenario: str) -> None:
    admin_app, token = _probe_session()
    origin = sorted(admin_app._allowed_browser_origins())[0]

    async def send(method: str, path: str, payload: dict, request_origin: str | None) -> dict[str, object]:
        encoded = json.dumps(payload).encode()
        headers = {} if request_origin is None else {"origin": request_origin}
        status, body = await _asgi_request(admin_app, method, path, encoded, token=token, headers=headers)
        return {"status": status, "body": body}

    async def renames() -> dict[str, object]:
        cases = (
            ("no_origin", {"team_name": "Growth"}, None),
            ("foreign_origin", {"team_name": "Growth"}, "https://attacker.example"),
            ("malformed", {"team_name": "Growth", "extra": 1}, origin),
            ("decomposed", {"team_name": " Équipe "}, origin),
            ("valid", {"team_name": "Growth"}, origin),
            ("taken", {"team_name": "Taken"}, origin),
            ("tampered", {"team_name": "Tampered"}, origin),
        )
        return {key: await send("PATCH", "/api/teams/team_1", payload, sent) for key, payload, sent in cases}

    if scenario == "team-rename":
        output = asyncio.run(renames())
    else:
        output = asyncio.run(send("POST", "/api/teams", {"team_name": "Marketing"}, None))
    print(json.dumps(output))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--asgi-probe":
        _run_asgi_probe(sys.argv[2])
    else:
        unittest.main()
