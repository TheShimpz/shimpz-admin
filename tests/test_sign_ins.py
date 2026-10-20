"""A Team's Sign-ins through Admin (ADR-0117, Sign-ins amendment): exact bodies, exact answers, closed refusals."""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from session import topics
from team import sign_ins, transport

TRACE = "f" * 32
SESSION = "a" * 32
SIGN_IN = {
    "sign_in_id": "b" * 32,
    "site": "example.com",
    "label": "Work",
    "created_at": "2026-10-19T10:00:00Z",
    "last_used_at": "2026-10-19T10:00:00Z",
    "expires_at": "2026-11-18T10:00:00Z",
}


def traced(body: dict) -> transport.TeamResponse:
    return transport.TeamResponse(200, {**body, "trace_id": TRACE})


class SignInBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.raised: list[str] = []

        def listener(topic: str, _revision: int) -> None:
            self.raised.append(topic)

        topics.listen(listener)
        self.addCleanup(topics.forget, listener)

    def test_each_operation_reaches_its_team_route_and_answers_teams_exact_body_untraced(self) -> None:
        started = {"sign_in_session_id": SESSION, "view_id": "c" * 32, "site": "example.com"}
        cases = (
            (
                sign_ins.start,
                {"url": "https://example.com/login", "locale": "pt"},
                "sign-in",
                started,
            ),
            (sign_ins.save, {"sign_in_session_id": SESSION, "label": "Work"}, "sign-in/save", SIGN_IN),
            (sign_ins.cancel, {"sign_in_session_id": SESSION}, "sign-in/cancel", {"cancelled": True}),
            (sign_ins.forget, {"sign_in_id": "b" * 32}, "sign-ins/forget", {"forgotten": True}),
        )
        for operation, body, route, answer in cases:
            with self.subTest(route=route), mock.patch.object(transport, "call", return_value=traced(answer)) as call:
                response = operation("team_1", body)
            self.assertEqual((response.status, response.body), (200, answer))
            call.assert_called_once_with("POST", f"/v1/teams/team_1/browser/{route}", body)
        with mock.patch.object(transport, "call", return_value=traced({"sign_ins": [SIGN_IN]})) as call:
            response = sign_ins.listing("team_1")
        self.assertEqual((response.status, response.body), (200, {"sign_ins": [SIGN_IN]}))
        call.assert_called_once_with("GET", "/v1/teams/team_1/browser/sign-ins")
        # Only a saved and a forgotten Sign-in change what the Team's Sign-ins show.
        self.assertEqual(self.raised, ["team/team_1/sign-ins", "team/team_1/sign-ins"])

    def test_a_body_outside_teams_protocol_never_reaches_team(self) -> None:
        cases = (
            (sign_ins.start, {"url": "http://example.com/", "locale": "en"}),
            (sign_ins.start, {"url": "https://example.com/", "locale": "en", "extra": 1}),
            (sign_ins.save, {"sign_in_session_id": SESSION, "label": " Work"}),
            (sign_ins.cancel, {"sign_in_session_id": "A" * 32}),
            (sign_ins.forget, {}),
        )
        for operation, body in cases:
            with (
                self.subTest(body=body),
                mock.patch.object(transport, "call") as call,
                self.assertRaises(transport.TeamRequestError),
            ):
                operation("team_1", body)
            call.assert_not_called()
        with mock.patch.object(transport, "call") as call, self.assertRaises(transport.TeamRequestError):
            sign_ins.listing("Team 1")
        call.assert_not_called()

    def test_only_the_closed_refusals_pass_and_anything_else_is_team_unavailable(self) -> None:
        cases = (
            ((409, {"code": "sign-in-identity-provider", "error": "x"}), (409, "sign-in-identity-provider")),
            ((409, {"code": "sign-in-windows"}), (409, "sign-in-windows")),
            ((404, {"code": "sign-in-not-running"}), (404, "sign-in-not-running")),
            ((503, {"code": "sign-in-unsaved"}), (503, "sign-in-unsaved")),
            ((409, {"code": "sign-in-unsaved"}), (502, None)),
            ((200, SIGN_IN), (502, None)),
            ((200, {**SIGN_IN, "trace_id": "x"}), (502, None)),
            ((200, {**SIGN_IN, "capsule": "x", "trace_id": TRACE}), (502, None)),
            ((200, {**SIGN_IN, "label": " Work", "trace_id": TRACE}), (502, None)),
        )
        body = {"sign_in_session_id": SESSION, "label": "Work"}
        for (status, answer), (expected, code) in cases:
            with (
                self.subTest(status=status, answer=answer),
                mock.patch.object(transport, "call", return_value=transport.TeamResponse(status, answer)),
            ):
                response = sign_ins.save("team_1", body)
            self.assertEqual((response.status, response.body.get("code")), (expected, code))
        # A Sign-in that was not saved changes nothing the page shows.
        self.assertEqual(self.raised, [])


if __name__ == "__main__":
    unittest.main()
