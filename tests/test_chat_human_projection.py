"""Fail-closed public projections for every Power human request kind."""

from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team

from chat import human, local

TRACE_ID = "a" * 32
CHALLENGE_ID = "b" * 32


def _fingerprinted(request: dict[str, object]) -> dict[str, object]:
    canonical = json.dumps(
        request,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return {**request, "fingerprint": hashlib.sha256(canonical).hexdigest()}


def _request(kind: str) -> dict[str, object]:
    base: dict[str, object] = {
        "kind": kind,
        "ordinal": 0,
        "title": "Need your decision",
        "description": "This exact Power is waiting for you.",
    }
    if kind in human.LENGTH_KINDS:
        base.update(
            label="Value",
            required=True,
            placeholder="Enter a value",
            min_length=1,
            max_length=human.LENGTH_KINDS[kind],
        )
    elif kind in human.CHOICE_KINDS or kind == "input:choices":
        base.update(
            label="Options",
            required=True,
            options=[
                {"value": "one", "label": "One", "description": "The first option."},
                {"value": "two", "label": "Two", "description": None},
            ],
        )
        if kind == "input:choices":
            base.update(min_selections=1, max_selections=2)
    return _fingerprinted(base)


def _response(request: dict[str, object], **overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "team_id": "team_1",
        "status": "human-required",
        "turn_id": CHALLENGE_ID,
        "challenge_id": CHALLENGE_ID,
        "expires_in": 300,
        "assistant": {"id": "shimpz-cloudflare", "name": "Shimpz Cloudflare"},
        "power": {"id": "list-zones", "summary": "List reviewed Cloudflare zones."},
        "request": request,
        "trace_id": TRACE_ID,
    }
    value.update(overrides)
    return value


class HumanChallengeProjectionTests(unittest.TestCase):
    def test_every_reviewed_kind_projects_without_internal_metadata(self) -> None:
        kinds = {
            "approval",
            *human.LENGTH_KINDS,
            *human.CHOICE_KINDS,
            "input:choices",
            *human.AUTH_KINDS,
        }
        for kind in sorted(kinds):
            with self.subTest(kind=kind):
                projected = local._project_pending_challenge(
                    team.TeamResponse(428, _response(_request(kind))),
                    "team_1",
                )

                self.assertEqual(projected.status, 428)
                self.assertEqual(projected.body["status"], "human-required")
                self.assertEqual(projected.body["request"]["kind"], kind)
                self.assertNotIn("trace_id", projected.body)
                self.assertEqual(
                    projected.websocket_event("team_1")["type"],
                    "human-required",
                )

    def test_tampered_or_augmented_challenges_fail_without_reflection(self) -> None:
        request = _request("input:select")
        tampered = dict(request)
        tampered["title"] = "Changed after review"
        private = _response(request)
        private["access_token"] = "must-not-cross"
        invalid = (
            _response(request, team_id="team_2"),
            private,
            _response(tampered),
            _response({**request, "fingerprint": "0" * 64}),
            _response({**request, "options": [request["options"][0], request["options"][0]]}),
            _response(request, expires_in=True),
            _response(request, assistant={"id": "INVALID", "name": "Private"}),
        )
        for body in invalid:
            with self.subTest(body=body):
                projected = local._project_pending_challenge(
                    team.TeamResponse(428, body),
                    "team_1",
                )
            self.assertEqual(
                projected,
                team.TeamResponse(502, {"code": "human-challenge-response-invalid"}),
            )
            self.assertNotIn("must-not-cross", json.dumps(projected.body))

    def test_pending_human_is_team_bound_and_none_is_closed(self) -> None:
        pending = team.TeamResponse(200, _response(_request("approval")))
        with mock.patch.object(team, "pending_chat_human", return_value=pending):
            projected = local.pending_human("team_1")
        self.assertEqual(projected.body["status"], "human-required")

        none = team.TeamResponse(200, {"team_id": "team_1", "status": "none", "trace_id": TRACE_ID})
        with mock.patch.object(team, "pending_chat_human", return_value=none):
            self.assertEqual(
                local.pending_human("team_1"),
                team.TeamResponse(200, {"team_id": "team_1", "status": "none"}),
            )


if __name__ == "__main__":
    unittest.main()
