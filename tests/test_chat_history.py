"""Durable, Team-isolated Admin chat presentation history."""

from __future__ import annotations

import contextlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import history


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


class ChatHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "chat-history.sqlite3"
        self.path_patch = mock.patch.object(history, "STORE_PATH", self.path)
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)

    def test_records_idempotent_terminal_rows_in_presentation_order(self) -> None:
        first = history.new_turn_id()
        second = history.new_turn_id()

        self.assertTrue(history.append_user("marketing", first, "Install Cloudflare"))
        self.assertFalse(history.append_user("marketing", first, "Install Cloudflare"))
        self.assertTrue(history.append_install("marketing", first, _installed_event()))
        self.assertFalse(history.append_install("marketing", first, _installed_event()))
        self.assertTrue(history.append_user("marketing", second, "List my DNS zones"))
        self.assertTrue(
            history.append_reply(
                "marketing",
                second,
                {
                    "type": "done",
                    "team_id": "marketing",
                    "team_name": "Marketing",
                    "reply": "Two zones are active.",
                },
            )
        )

        page = history.page("marketing")
        self.assertIsNone(page["before"])
        self.assertEqual(
            [(entry["kind"], entry.get("text")) for entry in page["entries"]],
            [
                ("message", "Install Cloudflare"),
                ("assistant-install", None),
                ("message", "List my DNS zones"),
                ("message", "Two zones are active."),
            ],
        )
        install = page["entries"][1]
        self.assertEqual(install["state"], "installed")
        self.assertNotIn("plan_id", install)
        self.assertNotIn("continuation", install)

    def test_pages_without_eviction_and_never_crosses_team_scope(self) -> None:
        expected = []
        for index in range(history.PAGE_ROWS * 2 + 7):
            text = f"Marketing prompt {index}"
            expected.append(text)
            history.append_user("marketing", history.new_turn_id(), text)
        history.append_user("sales", history.new_turn_id(), "Sales secret")

        observed = []
        before = None
        while True:
            page = history.page("marketing", before=before)
            observed = [entry["text"] for entry in page["entries"]] + observed
            before = page["before"]
            if before is None:
                break

        self.assertEqual(observed, expected)
        self.assertNotIn("Sales secret", observed)
        self.assertEqual([entry["text"] for entry in history.page("sales")["entries"]], ["Sales secret"])

    def test_rejects_nonterminal_or_secret_bearing_install_state(self) -> None:
        event = _installed_event()
        for mutation in (
            {"state": "installing"},
            {"access_token": "secret"},
            {"assistants": [{**event["assistants"][0], "image_id": "sha256:" + "a" * 64}]},
        ):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                history.append_install("marketing", history.new_turn_id(), {**event, **mutation})

    def test_records_only_terminal_uninstall_presentation(self) -> None:
        assistant = {
            "id": "shimpz-cloudflare",
            "name": "Shimpz Cloudflare",
            "summary": "Manage DNS records.",
            "version": "0.4.5",
        }
        guidance = history.new_turn_id()
        removed = history.new_turn_id()
        self.assertTrue(history.append_guidance("marketing", guidance, "uninstall-target-required"))
        self.assertTrue(
            history.append_uninstall(
                "marketing",
                removed,
                assistant,
                {
                    "type": "assistant-uninstall",
                    "state": "uninstalled",
                    "proposal_id": "c" * 32,
                    "assistant_id": "shimpz-cloudflare",
                    "team_id": "marketing",
                    "uninstalled": True,
                },
            )
        )
        page = history.page("marketing")
        self.assertEqual(page["entries"][0]["code"], "uninstall-target-required")
        uninstall = page["entries"][1]
        self.assertEqual(uninstall["kind"], "assistant-uninstall")
        self.assertEqual(uninstall["assistant"], assistant)
        self.assertNotIn("proposal_id", uninstall)

        with self.assertRaises(ValueError):
            history.append_uninstall(
                "marketing",
                history.new_turn_id(),
                assistant,
                {
                    "type": "assistant-uninstall",
                    "state": "uninstalling",
                    "proposal_id": "d" * 32,
                    "assistant_id": "shimpz-cloudflare",
                },
            )

    def test_team_and_space_cleanup_are_idempotent(self) -> None:
        history.append_user("marketing", history.new_turn_id(), "One")
        history.append_user("sales", history.new_turn_id(), "Two")

        self.assertEqual(history.clear_team("marketing"), 1)
        self.assertEqual(history.clear_team("marketing"), 0)
        self.assertEqual(history.page("marketing")["entries"], [])
        self.assertEqual(history.clear_all(), 1)
        self.assertEqual(history.clear_all(), 0)

    def test_store_and_directory_are_private(self) -> None:
        history.append_user("marketing", history.new_turn_id(), "Private")

        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.path.with_name(f"{self.path.name}-wal").exists())

    def test_preserves_maximum_length_multibyte_reply(self) -> None:
        turn_id = history.new_turn_id()
        reply = "界" * history.MAX_REPLY_CHARS

        self.assertTrue(history.append_user("marketing", turn_id, "Reply in Chinese"))
        self.assertTrue(
            history.append_reply(
                "marketing",
                turn_id,
                {
                    "type": "done",
                    "team_id": "marketing",
                    "team_name": "Marketing",
                    "reply": reply,
                },
            )
        )
        self.assertEqual(history.page("marketing")["entries"][-1]["text"], reply)

    def test_rejects_invalid_cursor_and_wrong_schema_version(self) -> None:
        history.append_user("marketing", history.new_turn_id(), "Private")
        with self.assertRaises(ValueError):
            history.page("marketing", before="not-a-cursor")

        import sqlite3

        with contextlib.closing(sqlite3.connect(self.path)) as database:
            database.execute("PRAGMA user_version = 99")
            database.commit()
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")


if __name__ == "__main__":
    unittest.main()
