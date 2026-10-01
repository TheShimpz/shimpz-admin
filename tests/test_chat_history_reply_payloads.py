"""Reply payloads that Admin chat history keeps for reload: clarifications, Routine proposals, and task usage."""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from history import store as history


def _installed_event() -> dict[str, object]:
    return {
        "type": "assistant-install-plan",
        "state": "installed",
        "plan_id": "a" * 32,
        "team_id": "marketing",
        "assistants": [
            {
                "id": "shimpz-cloudflare",
                "name": "Shimpz Cloudflare",
                "summary": "Manage DNS records.",
                "providers": ["cloudflare"],
                "provenance": "local",
                "status": "installed",
            }
        ],
        "continuation": "dispatch",
    }


def _uninstall_assistant() -> dict[str, str]:
    return {
        "id": "shimpz-cloudflare",
        "name": "Shimpz Cloudflare",
        "summary": "Manage DNS records.",
        "version": "0.4.5",
    }


class ChatHistoryReplyPayloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "chat-history.sqlite3"
        self.path_patch = mock.patch.object(history, "STORE_PATH", self.path)
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)

    @staticmethod
    def _admitted(team_id: str = "marketing") -> str:
        # Every turn event follows its admitted user row, as chat delivery writes it.
        turn = history.new_turn_id()
        history.append_user(team_id, turn, "Request")
        return turn

    def test_a_reply_keeps_its_closed_clarification_for_reload(self) -> None:
        asked = {
            "question": "Qual período?",
            "options": [{"label": "Hoje", "description": ""}, {"label": "Semana", "description": "Sete dias."}],
            "default_index": 1,
        }
        turn_id = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", turn_id, "Quais modelos?"))
        done = {
            "type": "done",
            "team_id": "marketing",
            "team_name": "Marketing",
            "reply": "Qual período?\n\n1. Hoje\n2. Semana ✓ — Sete dias.",
            "routine_proposal": None,
        }
        with self.assertRaises(ValueError):
            history.append_reply("marketing", turn_id, {**done, "reply": "Other text", "clarification": asked})
        with self.assertRaises(ValueError):
            history.append_reply("marketing", turn_id, {**done, "clarification": {**asked, "default_index": 9}})
        self.assertTrue(history.append_reply("marketing", turn_id, {**done, "clarification": asked}))
        entry = history.page("marketing")["entries"][-1]
        self.assertEqual(entry["clarification"], asked)
        self.assertEqual(entry["id"], f"{turn_id}:reply")

        # A tampered stored question makes the history unavailable instead of rendering it.
        with sqlite3.connect(self.path) as database:
            database.execute(
                "UPDATE transcript SET payload = ? WHERE event_key = ?",
                (
                    json.dumps(
                        {
                            "kind": "message",
                            "role": "assistant",
                            "text": "x",
                            "author": "Marketing",
                            "clarification": {**asked, "options": asked["options"][:1]},
                        }
                    ),
                    f"{turn_id}:reply",
                ),
            )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")
        with sqlite3.connect(self.path) as database:
            database.execute(
                "UPDATE transcript SET payload = ? WHERE event_key = ?",
                (
                    json.dumps(
                        {
                            "kind": "message",
                            "role": "assistant",
                            "text": "x",
                            "author": "Marketing",
                            "clarification": None,
                        }
                    ),
                    f"{turn_id}:reply",
                ),
            )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")

    def test_a_reply_keeps_its_closed_routine_proposal_for_reload(self) -> None:
        proposal = {
            "proposal_id": "c" * 32,
            "op": "propose",
            "quote": "Todo dia às 9, liste as zonas",
            "schedule": {"kind": "daily", "time": "09:00"},
            "timezone": None,
            "routine_id": None,
            "assistant_ids": ["shimpz-cloudflare"],
            "expires_in": 900,
        }
        turn_id = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", turn_id, "Todo dia às 9, liste as zonas"))
        done = {
            "type": "done",
            "team_id": "marketing",
            "team_name": "Marketing",
            "reply": "Posso agendar isso; confirme no cartão.",
            "clarification": None,
        }
        with self.assertRaises(ValueError):
            history.append_reply("marketing", turn_id, {**done, "routine_proposal": {**proposal, "op": "run"}})
        self.assertTrue(history.append_reply("marketing", turn_id, {**done, "routine_proposal": proposal}))
        entry = history.page("marketing")["entries"][-1]
        self.assertEqual(entry["routine_proposal"], proposal)
        # A proposal never enters the Brain's conversation window; only the reply text does.
        following = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", following, "Obrigado"))
        window = history.conversation("marketing", following)
        self.assertIn("Posso agendar isso; confirme no cartão.", repr(window))
        self.assertNotIn(proposal["proposal_id"], repr(window))
        with sqlite3.connect(self.path) as database:
            database.execute(
                "UPDATE transcript SET payload = ? WHERE event_key = ?",
                (
                    json.dumps(
                        {
                            "kind": "message",
                            "role": "assistant",
                            "text": "x",
                            "author": "Marketing",
                            "routine_proposal": {**proposal, "expires_in": -1},
                        }
                    ),
                    f"{turn_id}:reply",
                ),
            )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")

    def test_a_reply_keeps_its_closed_turn_usage_for_reload(self) -> None:
        usage = {
            "duration_ms": 6200,
            "models": [{"provider": "openai", "model": "gpt-6-luna", "input_tokens": 1331, "output_tokens": 36}],
        }
        turn_id = self._admitted()
        done = {
            "type": "done",
            "team_id": "marketing",
            "team_name": "Marketing",
            "reply": "Two zones are active.",
            "clarification": None,
            "routine_proposal": None,
        }
        for invalid in (None, {**usage, "models": []}, {**usage, "duration_ms": 86_400_001}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                history.append_reply("marketing", turn_id, {**done, "usage": invalid})
        self.assertTrue(history.append_reply("marketing", turn_id, {**done, "usage": usage}))
        self.assertTrue(history.append_reply("marketing", turn_id, {**done, "usage": usage}))
        entry = history.page("marketing")["entries"][-1]
        self.assertEqual((entry["id"], entry["usage"]), (f"{turn_id}:reply", usage))
        # What a turn consumed never enters the Brain's conversation window.
        following = self._admitted()
        self.assertNotIn("gpt-6-luna", repr(history.conversation("marketing", following)))
        # A reply stored without usage stays valid; a tampered or misplaced usage makes the history unavailable.
        plain = self._admitted()
        self.assertTrue(history.append_reply("marketing", plain, done))
        self.assertNotIn("usage", history.page("marketing")["entries"][-1])
        for stored, key in (
            (
                {
                    "kind": "message",
                    "role": "assistant",
                    "text": "x",
                    "author": "Marketing",
                    "usage": {**usage, "models": []},
                },
                f"{turn_id}:reply",
            ),
            ({"kind": "message", "role": "user", "text": "x", "usage": usage}, f"{following}:user"),
            (
                {"kind": "message", "role": "assistant", "text": "x", "author": "Marketing", "usage": None},
                f"{plain}:reply",
            ),
        ):
            with self.subTest(stored=stored):
                with sqlite3.connect(self.path) as database:
                    [original] = database.execute(
                        "SELECT payload FROM transcript WHERE event_key = ?", (key,)
                    ).fetchone()
                    database.execute("UPDATE transcript SET payload = ? WHERE event_key = ?", (json.dumps(stored), key))
                with self.assertRaises(history.HistoryUnavailableError):
                    history.page("marketing")
                with sqlite3.connect(self.path) as database:
                    database.execute("UPDATE transcript SET payload = ? WHERE event_key = ?", (original, key))
                self.assertEqual(history.page("marketing")["entries"][-1]["text"], "Two zones are active.")


if __name__ == "__main__":
    unittest.main()
