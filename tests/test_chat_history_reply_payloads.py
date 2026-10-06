"""Reply payloads that Admin chat history keeps for reload: clarifications, Routine proposals, and task usage."""

from __future__ import annotations

import json
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from history import store as history
from tests.chat_history_case import ChatHistoryCase


class ChatHistoryReplyPayloadTests(ChatHistoryCase):
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

    def test_a_reply_never_carries_a_retired_routine_proposal(self) -> None:
        turn_id = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", turn_id, "Todo dia às 9, liste as zonas"))
        done = {
            "type": "done",
            "team_id": "marketing",
            "team_name": "Marketing",
            "reply": "Pronto: todo dia às 9 listo as zonas.",
            "clarification": None,
        }
        # A Routine is created from the message itself (ADR-0092); a reply with a proposal card is refused.
        with self.assertRaises(ValueError):
            history.append_reply("marketing", turn_id, {**done, "routine_proposal": None})
        self.assertTrue(history.append_reply("marketing", turn_id, done))
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
                            "routine_proposal": {},
                        }
                    ),
                    f"{turn_id}:reply",
                ),
            )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")

    def test_a_reply_keeps_the_actions_its_attachments_withheld_for_reload(self) -> None:
        restricted = {"actions": [{"assistant": "shimpz-cloudflare", "action": "list-zones"}], "total": 3}
        turn_id = self._admitted()
        done = {
            "type": "done",
            "team_id": "marketing",
            "team_name": "Marketing",
            "reply": "The contract names two zones.",
            "clarification": None,
        }
        for invalid in (None, {**restricted, "total": 0}, {"actions": [], "total": 0}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                history.append_reply("marketing", turn_id, {**done, "restricted_actions": invalid})
        self.assertTrue(history.append_reply("marketing", turn_id, {**done, "restricted_actions": restricted}))
        entry = history.page("marketing")["entries"][-1]
        self.assertEqual(entry["restricted_actions"], restricted)
        tampered = self._admitted()
        self.assertTrue(history.append_reply("marketing", tampered, done))
        stored = {
            "kind": "message",
            "role": "assistant",
            "text": "x",
            "author": "Marketing",
            "restricted_actions": {**restricted, "total": 0},
        }
        with sqlite3.connect(self.path) as database:
            database.execute(
                "UPDATE transcript SET payload = ? WHERE event_key = ?",
                (json.dumps(stored), f"{tampered}:reply"),
            )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")

    def test_a_reply_keeps_its_routine_card_or_refusal_for_reload(self) -> None:
        vectors = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())
        card = vectors["routine_proposal"]["valid"][0]
        done = {
            "type": "done",
            "team_id": "marketing",
            "team_name": "Marketing",
            "reply": "Listei os registros.",
            "clarification": None,
        }
        turn_id = self._admitted()
        self.assertTrue(history.append_reply("marketing", turn_id, {**done, "routine_proposal": card}))
        self.assertEqual(history.page("marketing")["entries"][-1]["routine_proposal"], card)
        refused = self._admitted()
        refusal = {"code": "routine-recording-empty"}
        self.assertTrue(history.append_reply("marketing", refused, {**done, "routine_refusal": refusal}))
        self.assertEqual(history.page("marketing")["entries"][-1]["routine_refusal"], refusal)
        ambiguous = {
            "code": "routine-binding-ambiguous",
            "options": [
                {"value": '"' + "a" * 32 + '"', "label": "shimpz.com"},
                {"value": '"' + "b" * 32 + '"', "label": "shimpz.com"},
            ],
            "value": None,
        }
        questioned = self._admitted()
        self.assertTrue(history.append_reply("marketing", questioned, {**done, "routine_question": ambiguous}))
        self.assertEqual(history.page("marketing")["entries"][-1]["routine_question"], ambiguous)
        asked = {
            "question": "Qual zona?",
            "options": [{"label": "a", "description": ""}, {"label": "b", "description": ""}],
            "default_index": 0,
        }
        for invalid in (
            {"routine_proposal": {**card, "name": ""}},
            {"routine_proposal": card, "routine_refusal": refusal},
            {"routine_refusal": refusal, "clarification": asked, "reply": "Qual zona?\n\n1. a\n2. b"},
            {"routine_question": ambiguous, "routine_refusal": refusal},
            {"routine_question": {**ambiguous, "code": "routine-schedule-unstated"}},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                history.append_reply("marketing", self._admitted(), {**done, **invalid})
        tampered = self._admitted()
        self.assertTrue(history.append_reply("marketing", tampered, done))
        stored = {"kind": "message", "role": "assistant", "text": "x", "author": "Marketing", "routine_refusal": {}}
        with sqlite3.connect(self.path) as database:
            database.execute(
                "UPDATE transcript SET payload = ? WHERE event_key = ?",
                (json.dumps(stored), f"{tampered}:reply"),
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
