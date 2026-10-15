"""Local Team names (ADR-0088): rename and create over a real session socket, and the bridge's own checks."""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team
from team import names as team_names
from team import transport
from test_team_bridge_assistants import _LiveTeamCase, _probe_session, _socket_results, _TeamHandler

from chat import payloads

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

    def test_rename_sends_exactly_one_nfc_name(self) -> None:
        document = self.probe("team-rename")
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
            with (
                self.subTest(body=body),
                mock.patch.object(transport, "call", return_value=transport.TeamResponse(200, body)),
            ):
                self.assertEqual(team.rename("team_1", "Growth").status, 502)
        exact = {"team_id": "team_1", "team_name": "Growth"}
        with mock.patch.object(transport, "call", return_value=transport.TeamResponse(200, exact)):
            self.assertEqual(team.rename("team_1", "Growth").body, exact)
        with self.assertRaises(transport.TeamRequestError):
            team.rename("team_1", "Équipe")

    def test_confirmed_deletion_sends_the_expected_name_to_team(self) -> None:
        with mock.patch.object(transport, "call", return_value=transport.TeamResponse(200, {})) as call:
            team.destroy_confirmed("team_1", "Growth")
        call.assert_called_once_with("DELETE", "/v1/teams/team_1", {"team_name": "Growth"})

    def test_suffixes_stay_inside_the_id_grammar_and_exhaustion_keeps_the_conflict(self) -> None:
        ids = team_names._candidate_ids("x" * 60)
        self.assertEqual(len(ids), team_names.MAX_ID_SUFFIX)
        self.assertTrue(all(len(team_id) <= 40 and payloads.canonical_team_id(team_id) == team_id for team_id in ids))
        conflict = transport.TeamResponse(409, {"code": "team-name-conflict"})
        with mock.patch.object(team_names.bridge, "create", return_value=conflict) as create:
            self.assertEqual(team_names._create("Marketing"), ("marketing_9", conflict))
        self.assertEqual(create.call_count, team_names.MAX_ID_SUFFIX)
        with self.assertRaises(team_names.HTTPException):
            team_names._candidate_ids("!!!")


class TeamNameInProcessTests(unittest.TestCase):
    """The operations in process: a rename passes Team's refusals through, and creation clears stale history."""

    def test_a_rename_passes_team_refusals_through_and_refuses_an_invalid_name_before_team(self) -> None:
        taken = transport.TeamResponse(409, {"detail": "another Team already has this name", "code": "team-name-taken"})
        with mock.patch.object(transport, "call", return_value=taken) as call:
            response = team_names.rename("team_1", {"team_name": "Growth"})
        call.assert_called_once_with("PATCH", "/v1/teams/team_1", {"team_name": "Growth"})
        self.assertEqual(response.status_code, 409)
        for body in ({"team_name": 1}, {"team_name": ""}):
            with (
                self.subTest(body=body),
                mock.patch.object(transport, "call") as unreached,
                self.assertRaises(team_names.HTTPException) as invalid,
            ):
                team_names.rename("team_1", body)
            self.assertEqual(invalid.exception.status_code, 400)
            unreached.assert_not_called()

    def test_local_creation_clears_history_for_the_id_it_created(self) -> None:
        created = transport.TeamResponse(200, {"team_id": "marketing", "team_name": "Marketing", "created": True})
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
    if scenario == "team-rename":
        cases = (
            ("malformed", {"team_name": "Growth", "extra": 1}),
            ("decomposed", {"team_name": " Équipe "}),
            ("valid", {"team_name": "Growth"}),
            ("taken", {"team_name": "Taken"}),
            ("tampered", {"team_name": "Tampered"}),
        )
        calls = tuple(("teams.rename", {"team_id": "team_1", "body": body}) for _key, body in cases)
        results = asyncio.run(_socket_results(admin_app, token, calls))
        output = {
            key: {"status": result["status"], "body": result["body"]}
            for (key, _), result in zip(cases, results, strict=True)
        }
    else:
        (result,) = asyncio.run(
            _socket_results(admin_app, token, (("teams.create", {"body": {"team_name": "Marketing"}}),))
        )
        output = {"status": result["status"], "body": result["body"]}
    print(json.dumps(output))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--asgi-probe":
        _run_asgi_probe(sys.argv[2])
    else:
        unittest.main()
