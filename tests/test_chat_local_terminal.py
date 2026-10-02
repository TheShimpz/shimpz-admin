"""Fast contracts for the browser-safe projection of a completed local chat terminal.

Usage, clarification, and Routine proposals reach the browser only in their closed shapes, free of the model key.
"""

from __future__ import annotations

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
