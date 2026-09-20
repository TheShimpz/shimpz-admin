"""Durable, Team-isolated Admin chat presentation history."""

from __future__ import annotations

import asyncio
import contextlib
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from history import delivery
from history import http as history_http
from history import store as history
from team import bridge as team


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
        self.assertTrue(history.append_user("marketing", first, "Install Cloudflare"))
        self.assertTrue(history.append_install("marketing", first, _installed_event()))
        self.assertTrue(history.append_install("marketing", first, _installed_event()))
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

    def test_correlates_concurrent_resumable_turns_by_challenge(self) -> None:
        first = history.new_turn_id()
        second = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", first, "Install and list zones"))
        self.assertTrue(history.append_install("marketing", first, _installed_event()))
        self.assertTrue(history.bind_resumable_turn("marketing", first))
        self.assertTrue(history.append_user("marketing", second, "Newest request"))
        self.assertFalse(history.bind_resumable_turn("marketing", second))
        self.assertEqual(history.resumable_turn("marketing"), first)
        self.assertTrue(
            history.append_reply(
                "marketing",
                first,
                {
                    "type": "done",
                    "team_id": "marketing",
                    "team_name": "Marketing",
                    "reply": "First finished.",
                },
            )
        )
        self.assertIsNone(history.resumable_turn("marketing"))
        self.assertTrue(
            history.append_reply(
                "marketing",
                second,
                {
                    "type": "done",
                    "team_id": "marketing",
                    "team_name": "Marketing",
                    "reply": "Finished.",
                },
            )
        )
        self.assertIsNone(history.resumable_turn("marketing"))

    def test_installation_only_terminal_clears_active_turn(self) -> None:
        turn_id = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", turn_id, "Install Cloudflare"))
        self.assertTrue(history.bind_resumable_turn("marketing", turn_id))
        event = {**_installed_event(), "continuation": "none"}

        self.assertTrue(history.append_install("marketing", turn_id, event))
        self.assertIsNone(history.resumable_turn("marketing"))

    def test_already_installed_outcome_round_trips_without_lifecycle_authority(self) -> None:
        turn_id = history.new_turn_id()
        event = {
            **_installed_event(),
            "continuation": "none",
            "outcome": "already-installed",
        }

        self.assertTrue(history.append_user("marketing", turn_id, "Install Cloudflare"))
        self.assertTrue(history.append_install("marketing", turn_id, event))

        installed = history.page("marketing")["entries"][1]
        self.assertEqual(installed["outcome"], "already-installed")
        self.assertNotIn("continuation", installed)
        self.assertNotIn("plan_id", installed)

    def test_finishing_one_resumable_turn_never_releases_its_successor(self) -> None:
        first = history.new_turn_id()
        second = history.new_turn_id()
        self.assertTrue(history.append_user("marketing", first, "First gated request"))
        self.assertTrue(history.append_user("marketing", second, "Second gated request"))
        self.assertTrue(history.bind_resumable_turn("marketing", first))

        history.finish_resumable_turn(first)
        self.assertIsNone(history.resumable_turn("marketing"))
        self.assertTrue(history.bind_resumable_turn("marketing", second))

        history.finish_resumable_turn(first)
        self.assertEqual(history.resumable_turn("marketing"), second)

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
        self.assertEqual(history.clear_team("marketing"), 0)
        self.assertEqual(history.clear_all(), 0)
        self.assertFalse(self.path.exists())

        history.append_user("marketing", history.new_turn_id(), "One")
        history.append_user("sales", history.new_turn_id(), "Two")

        self.assertEqual(history.clear_team("marketing"), 1)
        self.assertEqual(history.clear_team("marketing"), 0)
        self.assertEqual(history.page("marketing")["entries"], [])
        self.assertEqual(history.clear_all(), 1)
        self.assertEqual(history.clear_all(), 0)

    def test_cleanup_overwrites_deleted_transcript_bytes(self) -> None:
        team_marker = "private-team-transcript-7b2d"
        space_marker = "private-space-transcript-9e4f"
        history.append_user("marketing", history.new_turn_id(), team_marker)
        history.append_user("sales", history.new_turn_id(), space_marker)

        self.assertEqual(history.clear_team("marketing"), 1)
        self.assertNotIn(team_marker.encode(), self.path.read_bytes())
        self.assertEqual(history.clear_all(), 1)
        self.assertNotIn(space_marker.encode(), self.path.read_bytes())

    def test_hosted_delivery_never_opens_the_local_history_store(self) -> None:
        delivery.configure("hosted")
        self.addCleanup(delivery.configure, "local")

        with mock.patch.object(history, "append_user") as append:
            self.assertIsNone(asyncio.run(delivery.admit("marketing", "Hello")))
        append.assert_not_called()

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

    def test_rejects_malformed_scalar_and_install_boundaries(self) -> None:
        invalid_calls = (
            (history._team_id, ("Marketing",)),
            (history._turn_id, ("not-a-turn",)),
            (history._text, (None, 10, "value")),
            (history._text, ("", 10, "value")),
            (history._text, (" padded ", 10, "value")),
            (history._text, ("x" * 11, 10, "value")),
            (history._text, ("bad\x00value", 20, "value")),
            (history._encoded, ({"value": "x" * history.MAX_ENTRY_BYTES},)),
            (history.append_reply, ("marketing", "a" * 32, None)),
            (
                history.append_reply,
                (
                    "marketing",
                    "a" * 32,
                    {"type": "done", "team_id": "sales", "team_name": "Sales", "reply": "No"},
                ),
            ),
            (history._install_assistant, (None,)),
            (history._install_assistant, ({"id": "missing-fields"},)),
            (
                history._install_assistant,
                ({**_installed_event()["assistants"][0], "id": "Invalid"},),
            ),
            (
                history._install_assistant,
                ({**_installed_event()["assistants"][0], "providers": ()},),
            ),
            (
                history._install_assistant,
                ({**_installed_event()["assistants"][0], "providers": ["x"] * 33},),
            ),
            (
                history._install_assistant,
                ({**_installed_event()["assistants"][0], "provenance": "unknown"},),
            ),
            (
                history._install_assistant,
                ({**_installed_event()["assistants"][0], "status": "working"},),
            ),
            (
                history._install_assistant,
                ({**_installed_event()["assistants"][0], "providers": ["bad_provider"]},),
            ),
            (
                history._install_assistant,
                ({**_installed_event()["assistants"][0], "providers": ["x", "x"]},),
            ),
            (history._install_payload, (None, "marketing")),
            (history._install_payload, ({"type": "other"}, "marketing")),
            (
                history._install_payload,
                ({**_installed_event(), "state": "installing"}, "marketing"),
            ),
            (
                history._install_payload,
                ({**_installed_event(), "team_id": "sales"}, "marketing"),
            ),
            (
                history._install_payload,
                ({**_installed_event(), "plan_id": "invalid"}, "marketing"),
            ),
            (
                history._install_payload,
                ({**_installed_event(), "assistants": []}, "marketing"),
            ),
            (
                history._install_payload,
                ({**_installed_event(), "assistants": [_installed_event()["assistants"][0]] * 2}, "marketing"),
            ),
            (
                history._install_payload,
                ({**_installed_event(), "continuation": "later"}, "marketing"),
            ),
            (
                history._install_payload,
                (
                    {
                        **_installed_event(),
                        "assistants": [{**_installed_event()["assistants"][0], "status": "pending"}],
                    },
                    "marketing",
                ),
            ),
            (
                history._install_payload,
                ({**_installed_event(), "outcome": "new"}, "marketing"),
            ),
            (
                history._install_payload,
                ({**_installed_event(), "outcome": "already-installed"}, "marketing"),
            ),
            (
                history._install_payload,
                (
                    {
                        **_installed_event(),
                        "state": "failed",
                        "status": True,
                        "assistants": [_installed_event()["assistants"][0]],
                    },
                    "marketing",
                ),
            ),
            (history.append_guidance, ("marketing", "a" * 32, "unknown")),
        )
        for function, arguments in invalid_calls:
            with self.subTest(function=function.__name__, arguments=arguments), self.assertRaises(ValueError):
                function(*arguments)

        for state, fields in (
            ("failed", {"status": 503}),
            ("stopped", {}),
        ):
            event = {
                "type": "assistant-install-plan",
                "state": state,
                "plan_id": "b" * 32,
                "team_id": "marketing",
                "assistants": [{**_installed_event()["assistants"][0], "status": "failed"}],
                **fields,
            }
            self.assertTrue(history.append_install("marketing", history.new_turn_id(), event))

        invalid_failed = {
            "type": "assistant-install-plan",
            "state": "failed",
            "plan_id": "b" * 32,
            "team_id": "marketing",
            "assistants": [{**_installed_event()["assistants"][0], "status": "failed"}],
            "status": True,
        }
        with self.assertRaises(ValueError):
            history._install_payload(invalid_failed, "marketing")

    def test_rejects_malformed_uninstall_and_stored_payloads(self) -> None:
        assistant = _uninstall_assistant()
        base_event = {
            "type": "assistant-uninstall",
            "state": "cancelled",
            "proposal_id": "c" * 32,
            "assistant_id": assistant["id"],
        }
        invalid_calls = (
            (history._uninstall_assistant, (None,)),
            (history._uninstall_assistant, ({"id": "missing"},)),
            (history._uninstall_assistant, ({**assistant, "id": "Invalid"},)),
            (history._uninstall_assistant, ({**assistant, "version": 1},)),
            (history._uninstall_assistant, ({**assistant, "version": "latest"},)),
            (history._uninstall_payload, (None, "marketing", assistant)),
            (history._uninstall_payload, ({**base_event, "type": "other"}, "marketing", assistant)),
            (
                history._uninstall_payload,
                ({**base_event, "state": "uninstalling"}, "marketing", assistant),
            ),
            (
                history._uninstall_payload,
                ({**base_event, "proposal_id": "invalid"}, "marketing", assistant),
            ),
            (
                history._uninstall_payload,
                ({**base_event, "assistant_id": "other"}, "marketing", assistant),
            ),
            (
                history._uninstall_payload,
                (
                    {**base_event, "state": "uninstalled", "team_id": "sales", "uninstalled": True},
                    "marketing",
                    assistant,
                ),
            ),
            (
                history._uninstall_payload,
                ({**base_event, "state": "failed", "status": True}, "marketing", assistant),
            ),
            (history._position, ("",)),
            (history._position, ("not-base64",)),
            (history._position, (history._cursor(0),)),
            (history._decoded, (None,)),
            (history._decoded, ("{",)),
            (history._decoded, ("[]",)),
            (history._decoded, ('{"kind":"unknown"}',)),
            (history._decoded, ('{"kind":"guidance","code":"bad"}',)),
            (history._validate_stored_message, ({"kind": "message", "role": "system", "text": "x"},)),
            (history._validate_stored_guidance, ({"kind": "guidance", "code": "bad"},)),
            (history._validate_stored_install, ({"kind": "assistant-install", "state": "working"},)),
            (
                history._validate_stored_install,
                ({"kind": "assistant-install", "state": "stopped", "assistants": []},),
            ),
            (
                history._validate_stored_install,
                (
                    {
                        "kind": "assistant-install",
                        "state": "stopped",
                        "assistants": [_installed_event()["assistants"][0]] * 2,
                    },
                ),
            ),
            (
                history._validate_stored_install,
                (
                    {
                        "kind": "assistant-install",
                        "state": "installed",
                        "assistants": [_installed_event()["assistants"][0]],
                        "outcome": "unexpected",
                    },
                ),
            ),
            (
                history._validate_stored_install,
                (
                    {
                        "kind": "assistant-install",
                        "state": "installed",
                        "assistants": [{**_installed_event()["assistants"][0], "status": "pending"}],
                    },
                ),
            ),
            (
                history._validate_stored_install,
                (
                    {
                        "kind": "assistant-install",
                        "state": "failed",
                        "assistants": [{**_installed_event()["assistants"][0], "status": "failed"}],
                        "status": True,
                    },
                ),
            ),
            (history._validate_stored_uninstall, ({"kind": "assistant-uninstall", "state": "working"},)),
            (
                history._validate_stored_uninstall,
                ({"kind": "assistant-uninstall", "state": "cancelled", "assistant": assistant, "extra": True},),
            ),
            (
                history._validate_stored_uninstall,
                (
                    {
                        "kind": "assistant-uninstall",
                        "state": "uninstalled",
                        "assistant": assistant,
                        "uninstalled": "yes",
                    },
                ),
            ),
            (
                history._validate_stored_uninstall,
                (
                    {
                        "kind": "assistant-uninstall",
                        "state": "failed",
                        "assistant": assistant,
                        "status": True,
                    },
                ),
            ),
        )
        for function, arguments in invalid_calls:
            with (
                self.subTest(function=function.__name__, arguments=arguments),
                self.assertRaises((ValueError, history.HistoryUnavailableError)),
            ):
                function(*arguments)

        for state, fields in (
            ("cancelled", {}),
            ("expired", {}),
            ("failed", {"status": 503}),
            ("uninstalled", {"team_id": "marketing", "uninstalled": False}),
        ):
            event = {**base_event, "state": state, **fields}
            self.assertTrue(history.append_uninstall("marketing", history.new_turn_id(), assistant, event))

        history._validate_stored_install(
            {
                "kind": "assistant-install",
                "state": "failed",
                "assistants": [{**_installed_event()["assistants"][0], "status": "failed"}],
                "status": 503,
            }
        )
        history._validate_stored_uninstall(
            {
                "kind": "assistant-uninstall",
                "state": "failed",
                "assistant": assistant,
                "status": 503,
            }
        )

    def test_store_failures_and_private_file_contract_fail_closed(self) -> None:
        with (
            mock.patch.object(history, "_private_file", side_effect=history.HistoryUnavailableError("bad")),
            self.assertRaises(history.HistoryUnavailableError),
        ):
            history.page("marketing")
        with (
            mock.patch.object(history, "_private_file", side_effect=OSError("bad")),
            self.assertRaises(history.HistoryUnavailableError),
        ):
            history.page("marketing")

        for failure in (history.HistoryUnavailableError("bad"), sqlite3.OperationalError("bad")):
            self.path.unlink(missing_ok=True)
            with (
                mock.patch.object(history, "_initialize", side_effect=failure),
                self.assertRaises(history.HistoryUnavailableError),
            ):
                history.page("marketing")

        self.path.unlink(missing_ok=True)
        self.path.mkdir()
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")
        self.path.rmdir()

        self.path.touch(mode=0o644)
        history.page("marketing")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

        self.path.unlink()
        with contextlib.closing(sqlite3.connect(self.path)) as database:
            database.execute("CREATE TABLE unexpected (value TEXT)")
            database.commit()
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("marketing")

    def test_paging_and_resumable_corruption_edges_fail_closed(self) -> None:
        first = history.new_turn_id()
        second = history.new_turn_id()
        self.assertFalse(history.bind_resumable_turn("marketing", first))
        self.assertTrue(history.append_user("marketing", first, "First long history entry"))
        self.assertTrue(history.append_user("marketing", second, "Second long history entry"))
        with mock.patch.object(history, "MAX_PAGE_BYTES", 60):
            page = history.page("marketing")
        self.assertEqual(len(page["entries"]), 1)
        self.assertIsNotNone(page["before"])

        with contextlib.closing(sqlite3.connect(self.path)) as database:
            database.execute(
                "INSERT OR REPLACE INTO resumable_turn (team_id, turn_id) VALUES (?, ?)",
                ("marketing", "invalid"),
            )
            database.commit()
        with self.assertRaises(history.HistoryUnavailableError):
            history.resumable_turn("marketing")

        self.path.unlink()
        history.finish_resumable_turn(history.new_turn_id())
        self.assertIsNone(history.resumable_turn("marketing"))
        with (
            mock.patch.object(Path, "lstat", side_effect=OSError("offline")),
            self.assertRaises(history.HistoryUnavailableError),
        ):
            history.resumable_turn("marketing")

    def test_history_http_cleanup_and_projection_edges(self) -> None:
        failed = team.TeamResponse(500, {"detail": "failed"})
        untouched = mock.Mock()
        self.assertEqual(history_http.cleanup(failed, untouched), failed)
        untouched.assert_not_called()

        success = team.TeamResponse(200, {"created": True})
        self.assertEqual(history_http.cleanup(success, mock.Mock()), success)
        unavailable = history_http.cleanup(
            success,
            mock.Mock(side_effect=history.HistoryUnavailableError("offline")),
        )
        self.assertEqual(unavailable.status, 503)

        self.assertEqual(history_http.team_created("marketing", failed), failed)
        with mock.patch.object(history, "clear_team", return_value=0) as clear:
            self.assertEqual(history_http.team_created("marketing", success), success)
        clear.assert_called_once_with("marketing")

        with mock.patch.object(history, "clear_team", return_value=0):
            absent = history_http.team_delete(
                "marketing",
                lambda: team.TeamResponse(404, {"detail": "Team not found"}),
            )
        self.assertEqual(absent, team.TeamResponse(200, {"deleted": False}))
        with mock.patch.object(history, "clear_team", return_value=0) as clear:
            deleted = history_http.team_delete(
                "marketing",
                lambda: team.TeamResponse(200, {"deleted": True}),
            )
        self.assertEqual(deleted, team.TeamResponse(200, {"deleted": True}))
        clear.assert_called_once_with("marketing")
        with mock.patch.object(history, "clear_all", return_value=0) as clear:
            self.assertEqual(history_http.space_reset(lambda: success), success)
        clear.assert_called_once_with()

        with (
            mock.patch.object(
                history_http.team,
                "resolve_team_name",
                side_effect=team.TeamRequestError("invalid team"),
            ),
            self.assertRaises(HTTPException) as rejected,
        ):
            history_http.page("marketing")
        self.assertEqual(rejected.exception.status_code, 400)

        with mock.patch.object(
            history_http.team,
            "resolve_team_name",
            return_value=team.TeamResponse(404, {"detail": "Team not found"}),
        ):
            self.assertEqual(history_http.page("marketing").status_code, 404)

        with (
            mock.patch.object(history_http.team, "resolve_team_name", return_value="Marketing"),
            mock.patch.object(history, "page", side_effect=ValueError("invalid cursor")),
            self.assertRaises(HTTPException) as invalid_cursor,
        ):
            history_http.page("marketing")
        self.assertEqual(invalid_cursor.exception.status_code, 400)

        with (
            mock.patch.object(history_http.team, "resolve_team_name", return_value="Marketing"),
            mock.patch.object(
                history,
                "page",
                side_effect=history.HistoryUnavailableError("offline"),
            ),
            self.assertRaises(HTTPException) as unavailable_history,
        ):
            history_http.page("marketing")
        self.assertEqual(unavailable_history.exception.status_code, 503)

        with (
            mock.patch.object(history_http.team, "resolve_team_name", return_value="Marketing"),
            mock.patch.object(history, "page", return_value={"entries": [], "before": None}),
        ):
            response = history_http.page("marketing", before=None)
        self.assertEqual(response.headers["Cache-Control"], "no-store")


if __name__ == "__main__":
    unittest.main()
