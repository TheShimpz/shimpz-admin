"""Bounded semantic conversation projection from durable Local chat history."""

from __future__ import annotations

import asyncio
import sqlite3
import sys
import tempfile
import unicodedata
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from history import context as conversation_context
from history import delivery
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
        "version": "0.4.5",
    }


class ChatHistoryConversationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "chat-history.sqlite3"
        self.path_patch = mock.patch.object(history, "STORE_PATH", self.path)
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)

    def test_conversation_text_keeps_exact_control_and_format_boundaries(self) -> None:
        allowed_ascii = {9, 10, 13, *range(32, 127)}
        for codepoint in range(128):
            value = f"a{chr(codepoint)}b"
            with self.subTest(codepoint=codepoint):
                if codepoint in allowed_ascii:
                    self.assertEqual(conversation_context.canonical_text(value), value)
                else:
                    with self.assertRaises(ValueError):
                        conversation_context.canonical_text(value)
        for value in (
            "a\u200bb",
            "a\u00adb",
            "a\ufeffb",
            "a\u2028b",
            "a\u00a0b",
            "a\nb\u200dc",
            "a👩\u200d💻b",
        ):
            with self.subTest(value=value):
                self.assertEqual(conversation_context.canonical_text(value), value)
        for value in ("a\u0085b", "a\ue000b", "a\ud800b", "a\u0378b", "a" * 60_000 + "\x00"):
            with self.subTest(value=value[:10]), self.assertRaises(ValueError):
                conversation_context.canonical_text(value)

    def test_projects_bounded_same_team_conversation_before_the_current_turn(self) -> None:
        listed = history.new_turn_id()
        uninstall = history.new_turn_id()
        inventory = history.new_turn_id()
        current = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", listed, "Quais Assistants estão instalados?"))
        self.assertTrue(
            history.append_reply(
                "marketing",
                listed,
                {
                    "type": "done",
                    "team_id": "marketing",
                    "team_name": "Marketing",
                    "reply": "Temos apenas Cloudflare/DNS.",
                    "clarification": None,
                },
            )
        )
        self.assertTrue(history.append_user("other_team", history.new_turn_id(), "Must not cross Teams"))
        self.assertTrue(history.append_user("marketing", uninstall, "Quero desinstalar ele."))
        self.assertTrue(
            history.append_guidance(
                "marketing",
                uninstall,
                "assistant-uninstall-target-required",
                "Qual Assistant você quer desinstalar?",
            )
        )
        self.assertTrue(history.append_user("marketing", inventory, "Quais temos?"))
        self.assertTrue(
            history.append_reply(
                "marketing",
                inventory,
                {
                    "type": "done",
                    "team_id": "marketing",
                    "team_name": "Marketing",
                    "reply": "Temos apenas Cloudflare/DNS.",
                    "clarification": None,
                },
            )
        )
        self.assertTrue(history.append_user("marketing", current, "Desinstala esse então."))

        projected = history.conversation("marketing", current)

        self.assertEqual(
            [(entry.role, entry.text, entry.truncated) for entry in projected],
            [
                ("user", "Quais Assistants estão instalados?", False),
                ("assistant", "Temos apenas Cloudflare/DNS.", False),
                ("user", "Quero desinstalar ele.", False),
                ("assistant", "Qual Assistant você quer desinstalar?", False),
                ("user", "Quais temos?", False),
                ("assistant", "Temos apenas Cloudflare/DNS.", False),
            ],
        )

    def test_conversation_projection_excludes_lifecycle_cards(self) -> None:
        installed = history.new_turn_id()
        uninstalled = history.new_turn_id()
        current = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", installed, "Instale o Cloudflare"))
        self.assertTrue(history.append_install("marketing", installed, _installed_event()))
        self.assertTrue(history.append_user("marketing", uninstalled, "Desinstale o Cloudflare"))
        self.assertTrue(
            history.append_uninstall(
                "marketing",
                uninstalled,
                _uninstall_assistant(),
                {
                    "type": "assistant-uninstall",
                    "state": "uninstalled",
                    "proposal_id": "b" * 32,
                    "assistant_id": "shimpz-cloudflare",
                    "team_id": "marketing",
                    "uninstalled": True,
                },
            )
        )
        self.assertTrue(history.append_user("marketing", current, "Instale ele novamente"))

        projected = history.conversation("marketing", current)

        self.assertEqual(
            [(entry.role, entry.text) for entry in projected],
            [
                ("user", "Instale o Cloudflare"),
                ("user", "Desinstale o Cloudflare"),
            ],
        )

    def test_an_attached_turn_never_enters_the_projection_but_stays_in_the_history(self) -> None:
        done = {"type": "done", "team_id": "marketing", "team_name": "Marketing", "clarification": None}
        plain = history.new_turn_id()
        attached = history.new_turn_id()
        refused = history.new_turn_id()
        current = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", plain, "Quais zonas temos?"))
        self.assertTrue(history.append_reply("marketing", plain, {**done, "reply": "Duas zonas."}))
        self.assertTrue(history.append_user("marketing", attached, "Resuma o contrato anexo.", attached=True))
        self.assertTrue(history.append_reply("marketing", attached, {**done, "reply": "O contrato diz X."}))
        self.assertTrue(history.append_user("marketing", refused, "Instale isso.", attached=True))
        self.assertTrue(
            history.append_guidance(
                "marketing", refused, "assistant-lifecycle-attachments", "Envie esse pedido de novo sem anexos."
            )
        )
        self.assertTrue(history.append_user("marketing", current, "E agora?"))

        projected = history.conversation("marketing", current)

        # Neither the attached message nor anything its turn produced reaches routing or the bridge (ADR-0093).
        self.assertEqual([entry.text for entry in projected], ["Quais zonas temos?", "Duas zonas."])
        texts = [entry.get("text", entry.get("reply")) for entry in history.page("marketing")["entries"]]
        self.assertIn("O contrato diz X.", texts)
        with sqlite3.connect(self.path) as database:
            rows = dict(database.execute("SELECT event_key, provenance FROM transcript").fetchall())
        self.assertEqual(rows[f"{attached}:reply"], "attached")
        self.assertEqual(rows[f"{refused}:guidance"], "attached")
        self.assertEqual(rows[f"{plain}:reply"], "plain")
        for invalid in (1, "yes", None):
            with self.subTest(attached=invalid), self.assertRaises(ValueError):
                history.append_user("marketing", history.new_turn_id(), "x", attached=invalid)
        with self.assertRaises(ValueError):
            history._append("marketing", f"{history.new_turn_id()}:user", {}, provenance="other")
        with sqlite3.connect(self.path) as database, self.assertRaises(sqlite3.IntegrityError):
            database.execute(
                "INSERT INTO transcript (team_id, event_key, payload, provenance, created_at) "
                "VALUES ('m', 'k', '{}', 'other', '2026-10-03T12:00:00Z')"
            )

    def test_conversation_projection_keeps_only_the_newest_eight_eligible_entries(self) -> None:
        for index in range(5):
            turn_id = history.new_turn_id()
            self.assertTrue(history.append_user("marketing", turn_id, f"Pergunta {index}"))
            self.assertTrue(
                history.append_reply(
                    "marketing",
                    turn_id,
                    {
                        "type": "done",
                        "team_id": "marketing",
                        "team_name": "Marketing",
                        "reply": f"Resposta {index}",
                        "clarification": None,
                    },
                )
            )
        current = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", current, "Continue"))

        projected = history.conversation("marketing", current)

        self.assertEqual(len(projected), conversation_context.MAX_ENTRIES)
        self.assertEqual(projected[0].text, "Pergunta 1")
        self.assertEqual(projected[-1].text, "Resposta 4")

    def test_conversation_projection_reads_only_the_eligible_partial_index(self) -> None:
        turn_id = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", turn_id, "Pergunta"))
        with sqlite3.connect(self.path) as database:
            plan = database.execute(
                f"EXPLAIN QUERY PLAN {history.CONVERSATION_QUERY}", ("marketing", 2, conversation_context.MAX_ENTRIES)
            ).fetchall()
            version = database.execute("PRAGMA user_version").fetchone()[0]

        self.assertEqual(version, history.SCHEMA_VERSION)
        self.assertEqual(len(plan), 1)
        self.assertIn("USING INDEX transcript_team_conversation (team_id=? AND position<?)", plan[0][3])

    def test_conversation_projection_truncates_head_and_tail_and_requires_an_exact_anchor(self) -> None:
        prior = history.new_turn_id()
        current = history.new_turn_id()
        reply = f"{'a' * 400} middle {'z' * 400}"
        self.assertTrue(history.append_user("marketing", prior, "Long reply"))
        self.assertTrue(
            history.append_reply(
                "marketing",
                prior,
                {
                    "type": "done",
                    "team_id": "marketing",
                    "team_name": "Marketing",
                    "reply": reply,
                    "clarification": None,
                },
            )
        )
        self.assertTrue(history.append_user("marketing", current, "Continue"))

        projected = history.conversation("marketing", current)

        self.assertEqual(len(projected[-1].text), conversation_context.MAX_TEXT_CHARS)
        self.assertTrue(projected[-1].truncated)
        self.assertTrue(projected[-1].text.startswith("a" * 200))
        self.assertTrue(projected[-1].text.endswith("z" * 200))
        self.assertIn(conversation_context.TRUNCATION_MARKER, projected[-1].text)
        with self.assertRaises(history.HistoryUnavailableError):
            history.conversation("marketing", history.new_turn_id())
        with self.assertRaises(history.HistoryUnavailableError):
            history.conversation("other_team", current)

    def test_conversation_projection_rejects_every_malformed_boundary(self) -> None:
        turn_id = history.new_turn_id()
        user = {"kind": "message", "role": "user", "text": "Hello"}
        for role, text in (
            ("user", None),
            ("user", " padded"),
            ("user", "bad\x00text"),
            ("user", "bad\u0085text"),
            ("system", "Hello"),
        ):
            with self.subTest(role=role, text=text), self.assertRaises(ValueError):
                conversation_context.bounded(role, text)
        with self.assertRaises(ValueError):
            conversation_context.admit((conversation_context.Entry("user", "x" * 513, False),))
        for malformed in ([], (object(),)):
            with self.subTest(malformed=malformed), self.assertRaises(ValueError):
                conversation_context.admit(malformed)
        self.assertEqual(
            conversation_context.admit((conversation_context.Entry("user", "Hello", False),)),
            (conversation_context.Entry("user", "Hello", False),),
        )
        with (
            mock.patch.object(conversation_context, "MAX_TOTAL_CHARS", 1),
            self.assertRaises(ValueError),
        ):
            conversation_context.admit((conversation_context.Entry("user", "Hello", False),))

        invalid_entries = (
            (None, user, None),
            ("invalid:user", user, None),
            (turn_id, user, history._turn_id),
            (f"{turn_id}:install", user, None),
        )
        for event_key, payload, patched_turn_id in invalid_entries:
            with self.subTest(event_key=event_key), self.assertRaises(history.HistoryUnavailableError):
                if patched_turn_id is None:
                    history._conversation_entry(event_key, payload)
                else:
                    with mock.patch.object(history, "_turn_id", return_value=turn_id):
                        history._conversation_entry(event_key, payload)

        self.assertIsNone(
            history._conversation_entry(
                f"{turn_id}:user",
                {**user, "text": "bad\x00text"},
            )
        )

        self.assertTrue(history.append_user("marketing", turn_id, "Current"))
        with (
            mock.patch.object(
                history,
                "_decoded",
                return_value={"kind": "message", "role": "assistant", "text": "Forged"},
            ),
            self.assertRaises(history.HistoryUnavailableError),
        ):
            history.conversation("marketing", turn_id)

        delivery.configure("hosted")
        self.addCleanup(delivery.configure, "local")
        self.assertEqual(asyncio.run(delivery.conversation("marketing", None)), ())
        delivery.configure("local")
        with self.assertRaises(history.HistoryUnavailableError):
            asyncio.run(delivery.conversation("marketing", None))

        unsuitable = history.new_turn_id()
        prior = history.new_turn_id()
        current = history.new_turn_id()
        decomposed = unicodedata.normalize("NFD", "informação café")
        canonical = unicodedata.normalize("NFC", decomposed)
        self.assertNotEqual(decomposed, canonical)
        self.assertTrue(history.append_user("marketing", unsuitable, "desinstale\ue000"))
        self.assertTrue(history.append_user("marketing", prior, decomposed))
        self.assertTrue(history.append_user("marketing", current, "Continue"))
        self.assertEqual(history.conversation("marketing", current)[-1].text, canonical)
        self.assertEqual(history.page("marketing")["entries"][-2]["text"], decomposed)
