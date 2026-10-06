"""Fast contracts for the browser-safe projection of a completed local chat terminal.

Usage, clarification, and Routine proposals reach the browser only in their closed shapes, free of the model key.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import models
from team import bridge as team

from chat import local

TRACE_ID = "a" * 32


REQUEST = {"issued_at": 1_700_000_000, "nonce": "0" * 32}


class LocalChatTerminalProjectionTests(unittest.TestCase):
    def test_relays_only_a_closed_turn_usage_free_of_forbidden_values(self) -> None:
        usage = {
            "duration_ms": 6200,
            "models": [{"provider": "openai", "model": "gpt-6.1-sol", "input_tokens": 12000, "output_tokens": 480}],
        }

        def turn(**extra: object) -> object:
            controller = team.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "team_name": "Marketing",
                    "reply": "Two zones are active.",
                    "clarification": None,
                    "trace_id": TRACE_ID,
                    **extra,
                },
            )
            with (
                mock.patch.object(
                    team,
                    "get_inference",
                    return_value=team.TeamResponse(200, {"provider": "openai", "model": "gpt-6.1-sol"}),
                ),
                mock.patch.object(models, "resolve_api_key", return_value="sk-test-0123456789abcdef"),
                mock.patch.object(team, "chat", return_value=controller),
            ):
                return local.turn(
                    "team_1",
                    {"message": "List zones", "files": [], "assistant_ids": [], "locale": "en", "timezone": None},
                    (),
                    REQUEST,
                )

        relayed = turn(usage=usage)
        self.assertEqual(relayed.body["usage"], usage)
        self.assertEqual(relayed.websocket_event("team_1"), {"type": "done", **relayed.body})
        self.assertNotIn("usage", turn().body)
        self.assertNotIn("usage", turn().websocket_event("team_1"))
        leaked_model = {**usage["models"][0], "model": "sk-test-0123456789abcdef"}
        for invalid in (
            None,
            {**usage, "duration_ms": -1},
            {**usage, "usd": 0.0015},
            {**usage, "models": []},
            {**usage, "models": [leaked_model]},
        ):
            with self.subTest(invalid=invalid):
                self.assertEqual(turn(usage=invalid).body, {"code": "chat-response-invalid"})
        self.assertEqual(turn(usage=usage, cost=1).body, {"code": "chat-response-invalid"})

        # The Actions a turn's attachments withheld reach the browser exactly, as identities only (ADR-0093).
        restricted = {"actions": [{"assistant": "shimpz-cloudflare", "action": "list-zones"}], "total": 2}
        named = turn(restricted_actions=restricted)
        self.assertEqual(named.websocket_event("team_1")["restricted_actions"], restricted)
        self.assertNotIn("restricted_actions", turn().body)
        for invalid in (None, {**restricted, "total": 0}, {"actions": [], "total": 0}):
            with self.subTest(restricted=invalid):
                self.assertEqual(turn(restricted_actions=invalid).body, {"code": "chat-response-invalid"})

    def test_relays_one_closed_routine_card_or_refusal_free_of_forbidden_values(self) -> None:
        """A recording turn ends with its Routine card or why it made none, never both and never beside a question."""
        card = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())["routine_proposal"]["valid"][0]
        asked = {
            "question": "Qual zona?",
            "options": [{"label": "a", "description": ""}, {"label": "b", "description": ""}],
            "default_index": 0,
        }

        def turn(**extra: object) -> object:
            body = {
                "team_id": "team_1",
                "team_name": "Marketing",
                "reply": "Listei os registros.",
                "clarification": None,
                "trace_id": TRACE_ID,
                **extra,
            }
            with (
                mock.patch.object(
                    team,
                    "get_inference",
                    return_value=team.TeamResponse(200, {"provider": "openai", "model": "gpt-6.1-sol"}),
                ),
                mock.patch.object(models, "resolve_api_key", return_value="sk-test-0123456789abcdef"),
                mock.patch.object(team, "chat", return_value=team.TeamResponse(200, body)),
            ):
                return local.turn(
                    "team_1",
                    {"message": "Cria uma rotina", "files": [], "assistant_ids": [], "locale": "pt", "timezone": None},
                    (),
                    REQUEST,
                )

        relayed = turn(routine_proposal=card)
        self.assertEqual(relayed.websocket_event("team_1")["routine_proposal"], card)
        refused = turn(routine_refusal={"code": "routine-secret-literal"})
        self.assertEqual(refused.websocket_event("team_1")["routine_refusal"], {"code": "routine-secret-literal"})
        self.assertNotIn("routine_proposal", turn().body)
        question = {"code": "routine-schedule-unstated", "options": [], "value": None}
        self.assertEqual(turn(routine_question=question).websocket_event("team_1")["routine_question"], question)
        leaked = {**card, "name": "sk-test-0123456789abcdef"}
        for extra in (
            {"routine_proposal": {**card, "clamped": False}},
            {"routine_proposal": leaked},
            {"routine_refusal": {"code": "Bad Code"}},
            {"routine_proposal": card, "routine_refusal": {"code": "routine-recording-empty"}},
            {"routine_refusal": {"code": "routine-recording-empty"}, "clarification": asked},
            {"routine_question": {"code": "routine-schedule-unstated", "options": [], "value": 30}},
            {"routine_question": question, "routine_refusal": {"code": "routine-recording-empty"}},
            {"routine_question": question, "clarification": asked},
        ):
            with self.subTest(extra=extra):
                self.assertEqual(turn(**extra).body, {"code": "chat-response-invalid"})

    def test_projects_only_a_closed_clarification_free_of_forbidden_values(self) -> None:
        asked = {
            "question": "Qual período?",
            "options": [{"label": "Hoje", "description": ""}, {"label": "Semana", "description": "Sete dias."}],
            "default_index": 0,
        }

        def turn(
            clarification: object,
            reply: str = "Qual período?\n\n1. Hoje ✓\n2. Semana — Sete dias.",
            proposal: object = None,
        ) -> object:
            controller = team.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "team_name": "Marketing",
                    "reply": reply,
                    "clarification": clarification,
                    **({} if proposal is None else {"routine_proposal": proposal}),
                    "trace_id": TRACE_ID,
                },
            )
            with (
                mock.patch.object(
                    team,
                    "get_inference",
                    return_value=team.TeamResponse(200, {"provider": "openai", "model": "gpt-6.1-sol"}),
                ),
                mock.patch.object(models, "resolve_api_key", return_value="sk-test-0123456789abcdef"),
                mock.patch.object(team, "chat", return_value=controller),
            ):
                return local.turn(
                    "team_1",
                    {"message": "Quais modelos?", "files": [], "assistant_ids": [], "locale": "en", "timezone": None},
                    (),
                    REQUEST,
                )

        self.assertEqual(turn(asked).body["clarification"], asked)
        # A retired Routine proposal field is never relayed; a Routine is created from the message (ADR-0092).
        self.assertEqual(turn(None, "Pronto.", {}).body, {"code": "chat-response-invalid"})
        self.assertEqual(turn(asked, "I deleted everything.").body, {"code": "chat-response-invalid"})
        self.assertEqual(turn(asked).websocket_event("team_1")["clarification"], asked)
        for invalid in ({**asked, "default_index": 7}, {**asked, "question": "Linha\nDupla"}):
            with self.subTest(invalid=invalid):
                self.assertEqual(turn(invalid).body, {"code": "chat-response-invalid"})
        leaked = {
            **asked,
            "options": [{"label": "Hoje", "description": "sk-test-0123456789abcdef"}, asked["options"][1]],
        }
        self.assertEqual(turn(leaked).body, {"code": "chat-response-invalid"})


if __name__ == "__main__":
    unittest.main()
