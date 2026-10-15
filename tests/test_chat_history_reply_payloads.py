"""Reply payloads that Admin chat history keeps for reload: clarifications, Routine proposals, and task usage."""

import copy
import json
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from history import store as history
from team import transport
from tests.chat_history_case import ChatHistoryCase, done_event

from chat import local


class ChatHistoryReplyPayloadTests(ChatHistoryCase):
    def _store_payload(self, event_key: str, payload: dict[str, object]) -> None:
        """Overwrite one stored transcript payload behind the history store's back."""
        with sqlite3.connect(self.path) as database:
            database.execute("UPDATE transcript SET payload = ? WHERE event_key = ?", (json.dumps(payload), event_key))

    def test_an_unrecommended_question_keeps_no_default_through_the_turn_and_history(self) -> None:
        # A Routine question never steers a choice: no option is recommended, and the reply marks none.
        asked = {
            "question": "Com que frequência?",
            "options": [{"label": "A cada hora", "description": ""}, {"label": "Todo dia", "description": ""}],
            "default_index": None,
        }
        reply = "Com que frequência?\n\n1. A cada hora\n2. Todo dia"
        body = {"team_id": "marketing", "team_name": "Marketing", "reply": reply, "clarification": asked}
        projected = local._project_turn(
            transport.TeamResponse(200, {**body, "trace_id": "a" * 32}), "marketing", forbidden_values=("not-a-key",)
        )
        self.assertEqual((projected.status, projected.body["clarification"]), (200, asked))
        turn_id = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", turn_id, "Cria uma rotina"))
        self.assertTrue(history.append_reply("marketing", turn_id, {"type": "done", **projected.body}))
        self.assertEqual(history.page("marketing")["entries"][-1]["clarification"], asked)

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
        self._store_payload(
            f"{turn_id}:reply",
            {
                "kind": "message",
                "role": "assistant",
                "text": "x",
                "author": "Marketing",
                "clarification": {**asked, "options": asked["options"][:1]},
            },
        )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")
        self._store_payload(
            f"{turn_id}:reply",
            {
                "kind": "message",
                "role": "assistant",
                "text": "x",
                "author": "Marketing",
                "clarification": None,
            },
        )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")

    def test_a_reply_refuses_an_invalid_routine_proposal(self) -> None:
        turn_id = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", turn_id, "Todo dia às 9, liste as zonas"))
        done = done_event("Pronto: todo dia às 9 listo as zonas.")
        # A reply carries a Routine proposal only in its validated shape; an invalid value is refused.
        with self.assertRaises(ValueError):
            history.append_reply("marketing", turn_id, {**done, "routine_proposal": None})
        self.assertTrue(history.append_reply("marketing", turn_id, done))
        self._store_payload(
            f"{turn_id}:reply",
            {
                "kind": "message",
                "role": "assistant",
                "text": "x",
                "author": "Marketing",
                "routine_proposal": {},
            },
        )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")

    def test_a_projected_reply_commits_its_routine_card_refusal_or_question(self) -> None:
        """The socket commits the frozen projection of Team's reply as it relays it, Routine outcomes included."""
        vectors = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())
        outcomes = {
            "routine_proposal": vectors["routine_proposal"]["valid"][0],
            "routine_refusal": {"code": "routine-recording-empty"},
            "routine_question": {"code": "routine-output-unstated", "options": [], "value": None},
        }
        for name, value in outcomes.items():
            with self.subTest(outcome=name):
                projected = local.PublicResponse(
                    200,
                    {
                        "team_id": "marketing",
                        "team_name": "Marketing",
                        "reply": "Listei os registros.",
                        "clarification": None,
                        name: value,
                    },
                )
                turn_id = self._admitted()
                self.assertTrue(history.append_reply("marketing", turn_id, {"type": "done", **projected.body}))
                self.assertEqual(history.page("marketing")["entries"][-1][name], value)

    def test_a_copy_of_a_frozen_projection_is_plain_data(self) -> None:
        projected = local.PublicResponse(200, {"items": [{"a": 1}], "name": "x"}).body
        for copied in (copy.copy(projected), copy.deepcopy(projected)):
            with self.subTest(copied=type(copied).__name__):
                self.assertIs(type(copied), dict)
                self.assertEqual(copied, {"items": [{"a": 1}], "name": "x"})
        items = projected["items"]
        self.assertIs(type(copy.copy(items)), list)
        self.assertIs(type(copy.deepcopy(items)[0]), dict)

    def test_a_reply_keeps_its_routine_card_or_refusal_for_reload(self) -> None:
        vectors = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())
        card = vectors["routine_proposal"]["valid"][0]
        done = done_event("Listei os registros.")
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
        # A reply is empty only beside the card, question, or refusal that says everything.
        silent = self._admitted()
        self.assertTrue(history.append_reply("marketing", silent, {**done, "reply": "", "routine_proposal": card}))
        self.assertEqual(history.page("marketing")["entries"][-1]["text"], "")
        with self.assertRaises(ValueError):
            history.append_reply("marketing", self._admitted(), {**done, "reply": ""})
        tampered = self._admitted()
        self.assertTrue(history.append_reply("marketing", tampered, done))
        stored = {"kind": "message", "role": "assistant", "text": "x", "author": "Marketing", "routine_refusal": {}}
        self._store_payload(f"{tampered}:reply", stored)
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")

    def test_a_card_answer_is_kept_once_beside_its_card_and_reads_back(self) -> None:
        vectors = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())
        card = vectors["routine_proposal"]["valid"][0]
        turn_id = self._admitted()
        self.assertTrue(history.append_reply("marketing", turn_id, {**done_event("Pronto."), "routine_proposal": card}))
        answer = {
            "team_id": "marketing",
            "proposal_id": card["proposal_id"],
            "routine_id": "a" * 32,
            "status": "created",
        }
        self.assertTrue(history.append_proposal_answer(answer))
        # A later answer to the same card, such as a cancel after the confirmation, changes nothing.
        self.assertTrue(history.append_proposal_answer({**answer, "routine_id": None, "status": "revoked"}))
        kept = history.page("marketing")["entries"][-1]
        self.assertEqual(
            {key: kept[key] for key in ("kind", "proposal_id", "status", "name")},
            {"kind": "routine-answer", "proposal_id": card["proposal_id"], "status": "created", "name": card["name"]},
        )
        # A card the transcript does not hold writes nothing, and an answer outside the closed form is refused.
        self.assertFalse(history.append_proposal_answer({**answer, "proposal_id": "f" * 32}))
        with self.assertRaises(ValueError):
            history.append_proposal_answer({**answer, "status": "pending"})
        with self.assertRaises(ValueError):
            history.append_proposal_answer({**answer, "status": "unknown"})
        self._store_payload(
            f"{card['proposal_id']}:answer", {**{k: kept[k] for k in ("kind", "proposal_id", "name")}, "status": "x"}
        )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")

    def test_a_reply_keeps_its_closed_turn_usage_for_reload(self) -> None:
        usage = {
            "duration_ms": 6200,
            "models": [{"provider": "openai", "model": "gpt-6-luna", "input_tokens": 1331, "output_tokens": 36}],
        }
        turn_id = self._admitted()
        done = done_event("Two zones are active.")
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

    def test_a_reply_keeps_the_receipt_its_page_was_shown_for_reload(self) -> None:
        # Two deliveries of one logical turn: Team's model call, then, after a human request, its Action and reply.
        receipt = [
            {"segment": 0, "seq": 2, "origin": "team", "phase": "model", "state": "started"},
            {"segment": 0, "seq": 3, "origin": "team", "phase": "model", "state": "finished", "elapsed_ms": 40},
            {
                "segment": 1,
                "seq": 1,
                "origin": "team",
                "phase": "action",
                "state": "finished",
                "elapsed_ms": 7,
                "assistant_id": "shimpz-cloudflare",
                "action": "list-zones",
                "index": 1,
                "total": 1,
            },
        ]
        turn_id = self._admitted()
        done = done_event("Two zones are active.")
        self.assertTrue(history.append_reply("marketing", turn_id, done, receipt=copy.deepcopy(receipt)))
        entry = history.page("marketing")["entries"][-1]
        self.assertEqual((entry["id"], entry["receipt"]), (f"{turn_id}:reply", receipt))
        # The steps never enter the Brain's conversation window.
        following = self._admitted()
        self.assertNotIn("list-zones", repr(history.conversation("marketing", following)))
        # A reply stored without a receipt has none.
        self.assertTrue(history.append_reply("marketing", following, done))
        self.assertNotIn("receipt", history.page("marketing")["entries"][-1])
        model = receipt[0]
        for invalid in (
            [],
            {"0": model},
            [None],
            [{**model, "origin": "admin", "phase": "admin-preparation"}],
            [{**model, "state": "finished"}],
            [{**model, "secret": "value"}],
            [{**model, "segment": 1}],
            [{**model, "segment": "0"}],
            [{**model, "seq": 0}],
            [{**model, "seq": True}],
            [model, model],
            [model, {**receipt[1], "segment": 2}],
            [model] * (local.MAX_PUBLIC_PROGRESS_EVENTS + 1),
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                history.append_reply("marketing", self._admitted(), done, receipt=invalid)
        # A receipt too large for its row is left out, and the reply is kept without it.
        large = self._admitted()
        action = receipt[2]
        many = [
            {**action, "segment": 0, "seq": seq, "action": "a" * 128}
            for seq in range(1, local.MAX_PUBLIC_PROGRESS_EVENTS)
        ]
        self.assertTrue(history.append_reply("marketing", large, done, receipt=many))
        self.assertNotIn("receipt", history.page("marketing")["entries"][-1])
        # A tampered stored receipt makes the history unavailable.
        self._store_payload(
            f"{turn_id}:reply",
            {
                "kind": "message",
                "role": "assistant",
                "text": "x",
                "author": "Marketing",
                "receipt": [{**model, "seq": 0}],
            },
        )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")


if __name__ == "__main__":
    unittest.main()
