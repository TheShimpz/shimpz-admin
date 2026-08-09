"""Fail-closed public projections for every Power human request kind."""

from __future__ import annotations

import asyncio
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
    def test_local_reauthentication_is_bounded_and_maps_authority_failure(self) -> None:
        self.assertEqual(
            asyncio.run(
                human.authenticate_local(
                    "auth:second-factor",
                    "secret",
                    profile="local",
                    record_get=dict,
                )
            ),
            "unavailable",
        )

    def test_local_reauthentication_authority_locks_and_resets_without_rechecking(self) -> None:
        async def scenario() -> None:
            now = [100.0]
            verify = mock.AsyncMock(side_effect=["denied", "denied", "denied", "denied", "verified"])
            authority = human.LocalReauthenticationAuthority(verify, clock=lambda: now[0])

            first = await authority("auth:reauth", "wrong-1")
            second = await authority("auth:reauth", "wrong-2")
            third = await authority("auth:reauth", "wrong-3")
            blocked = await authority("auth:reauth", "correct-but-locked")

            self.assertEqual((first.status, first.attempts_remaining), ("denied", 2))
            self.assertEqual((second.status, second.attempts_remaining), ("denied", 1))
            self.assertEqual((third.status, third.retry_after), ("locked", 60))
            self.assertEqual((blocked.status, blocked.retry_after), ("locked", 60))
            self.assertEqual(verify.await_count, 3)

            now[0] += 60
            after_lock = await authority("auth:reauth", "wrong-after-lock")
            success = await authority("auth:reauth", "correct")
            self.assertEqual((after_lock.status, after_lock.attempts_remaining), ("denied", 2))
            self.assertEqual(success.status, "verified")

        asyncio.run(scenario())

    def test_unavailable_local_reauthentication_does_not_consume_an_attempt(self) -> None:
        async def scenario() -> None:
            verify = mock.AsyncMock(side_effect=["unavailable", "denied"])
            authority = human.LocalReauthenticationAuthority(verify)

            unavailable = await authority("auth:reauth", "secret")
            rejected = await authority("auth:reauth", "wrong")

            self.assertEqual(unavailable.status, "unavailable")
            self.assertEqual((rejected.status, rejected.attempts_remaining), ("denied", 2))

        asyncio.run(scenario())
        self.assertEqual(
            asyncio.run(
                human.authenticate_local(
                    "auth:reauth",
                    "secret",
                    profile="local",
                    record_get=lambda: (_ for _ in ()).throw(OSError("offline")),
                )
            ),
            "unavailable",
        )

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

    def test_projection_helpers_reject_invalid_nested_shapes(self) -> None:
        invalid_bodies = (
            _response(_request("approval"), trace_id="bad"),
            _response(_request("approval"), assistant=None),
            _response(_request("approval"), power=None),
            _response(_request("approval"), power={"id": "Bad", "summary": "summary"}),
            _response(None),
            _response(_fingerprinted({"kind": "unknown", "ordinal": 0, "title": "Title", "description": "Text"})),
        )
        for body in invalid_bodies:
            with self.assertRaises(human.HumanChallengeError):
                human.project(body, "team_1")

        duplicate = _request("input:select")
        duplicate["options"] = [duplicate["options"][0], duplicate["options"][0]]
        duplicate = _fingerprinted({key: value for key, value in duplicate.items() if key != "fingerprint"})
        with self.assertRaises(human.HumanChallengeError):
            human.project(_response(duplicate), "team_1")

        invalid_options = _request("input:select")
        invalid_options["options"] = []
        invalid_options = _fingerprinted({key: value for key, value in invalid_options.items() if key != "fingerprint"})
        with self.assertRaises(human.HumanChallengeError):
            human.project(_response(invalid_options), "team_1")

        self.assertFalse(human._fingerprint({"bad": object()}, "a" * 64))

    def test_browser_values_follow_each_projected_request_kind(self) -> None:
        self.assertTrue(human.browser_value(_request("input:select"), "one"))
        self.assertFalse(human.browser_value(_request("input:select"), "missing"))
        self.assertTrue(human.browser_value(_request("input:choices"), ["one", "two"]))
        self.assertFalse(human.browser_value(_request("input:choices"), ["one", "one"]))
        self.assertTrue(human.browser_value(_request("input:text"), "value"))
        self.assertFalse(human.browser_value(_request("input:text"), ""))
        self.assertFalse(human.browser_value(None, True))
        self.assertFalse(human.browser_value({"kind": "unknown"}, True))
        self.assertFalse(human._browser_choices({}, None))

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
