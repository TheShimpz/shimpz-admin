"""Fail-closed edges for private release-notification state and projections."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import notifications
from team import bridge as team

TRACE_ID = "a" * 32


def _release(assistant_id: str = "assistant", sequence: int = 1) -> dict[str, object]:
    return {
        "assistant_id": assistant_id,
        "sequence": sequence,
        "headline": "Safe release",
        "changelog": "A safe change.",
        "published_at": "2026-08-01T00:00:00Z",
    }


def _response(status: int, body: object) -> team.TeamResponse:
    return team.TeamResponse(status, body)


class _FeedResponse:
    def __init__(self, status: int, body: bytes = b"", headers: dict[str, str] | None = None) -> None:
        self.status = status
        self.body = body
        self.headers = headers or {}

    def getheader(self, name: str) -> str | None:
        return self.headers.get(name)

    def read(self, limit: int) -> bytes:
        return self.body[:limit]


class _FeedConnection:
    response = _FeedResponse(500)

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    def request(self, *_args, **_kwargs) -> None:
        pass

    def getresponse(self) -> _FeedResponse:
        return self.response

    def close(self) -> None:
        pass


class NotificationEdgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.previous_store = notifications.STORE_PATH
        notifications.STORE_PATH = Path(self.temporary.name) / "notifications.json"
        self.addCleanup(setattr, notifications, "STORE_PATH", self.previous_store)
        with notifications._STORE_LOCK:
            notifications._state_cache = None

    def test_scalar_release_and_feed_contracts_reject_invalid_values(self) -> None:
        operations = (
            lambda: notifications._canonical_timestamp("bad", field="time"),
            lambda: notifications._canonical_timestamp("2026-13-01T00:00:00Z", field="time"),
            lambda: notifications._canonical_sequence(True),
            lambda: notifications._canonical_headline("\ud800"),
            lambda: notifications._canonical_headline(" bad "),
            lambda: notifications._canonical_changelog(""),
            lambda: notifications._canonical_changelog("\ud800"),
            lambda: notifications._canonical_changelog("bad\x00"),
            lambda: notifications._canonical_etag("bad etag"),
            lambda: notifications._canonical_release({}),
            lambda: notifications.validate_feed([]),
            lambda: notifications.validate_feed({"schema_version": True, "releases": []}),
            lambda: notifications.validate_feed(
                {"schema_version": 1, "releases": [_release(sequence=1), _release(sequence=1)]}
            ),
        )
        for operation in operations:
            with self.assertRaises((ValueError, team.TeamRequestError)):
                operation()

        with (
            mock.patch.object(notifications.team, "canonical_assistant_id", return_value="different"),
            self.assertRaisesRegex(ValueError, "non-canonical"),
        ):
            notifications._canonical_release(_release())
        with (
            mock.patch.object(notifications, "MAX_CHANGELOG_BYTES", 1),
            self.assertRaisesRegex(ValueError, "too large"),
        ):
            notifications._canonical_changelog("long")

    def test_notification_and_state_contracts_reject_invalid_records(self) -> None:
        release = _release()
        valid = {
            "id": notifications._notification_id("assistant", 1),
            **release,
            "read_at": None,
        }
        invalid_records = ({}, {**valid, "id": "a" * 32})
        for record in invalid_records:
            with self.assertRaises(ValueError):
                notifications._canonical_notification(record)

        state = notifications._default_state()
        invalid_states = (
            [],
            {**state, "schema_version": True},
            {**state, "cursors": []},
            {**state, "cursors": {"Bad": 1}},
            {**state, "notifications": "bad"},
            {**state, "notifications": [valid, valid]},
        )
        for value in invalid_states:
            with self.assertRaises((ValueError, team.TeamRequestError)):
                notifications._validate_state(value)
        with (
            mock.patch.object(notifications.team, "canonical_assistant_id", return_value="different"),
            self.assertRaisesRegex(ValueError, "invalid notification cursor"),
        ):
            notifications._validate_state({**state, "cursors": {"assistant": 1}})

    def test_store_metadata_races_bounds_and_write_failures_are_loud(self) -> None:
        notifications.STORE_PATH.write_text("{}", encoding="utf-8")
        notifications.STORE_PATH.chmod(0o644)
        with self.assertRaisesRegex(notifications.NotificationStoreError, "unsafe metadata"):
            notifications._store_identity(notifications.STORE_PATH)

        notifications.STORE_PATH.chmod(0o600)
        identity = notifications._store_identity(notifications.STORE_PATH)
        with (
            mock.patch.object(notifications, "_store_identity", side_effect=[identity, None]),
            self.assertRaisesRegex(notifications.NotificationStoreError, "changed while reading"),
        ):
            notifications._read_unlocked()

        with (
            mock.patch.object(notifications, "MAX_STORE_BYTES", 1),
            mock.patch.object(notifications, "_store_identity", return_value=identity),
            mock.patch.object(notifications, "_read_store_bytes", return_value=b"xx"),
            self.assertRaisesRegex(notifications.NotificationStoreError, "too large"),
        ):
            notifications._read_unlocked()

        with self.assertRaisesRegex(notifications.NotificationStoreError, "invalid notification state"):
            notifications._write_unlocked({})

        state = notifications._default_state()
        with (
            mock.patch.object(notifications, "MAX_STORE_BYTES", 1),
            self.assertRaisesRegex(notifications.NotificationStoreError, "too large"),
        ):
            notifications._write_unlocked(state)

        with (
            mock.patch.object(notifications.os, "write", return_value=0),
            self.assertRaisesRegex(notifications.NotificationStoreError, "could not be written"),
        ):
            notifications._write_unlocked(state)

    def test_feed_transport_rejects_ambiguous_responses(self) -> None:
        invalid = (
            _FeedResponse(304, b"residue"),
            _FeedResponse(200, b"{}", {"Content-Type": "text/plain"}),
            _FeedResponse(200, b"", {"Content-Type": "application/json"}),
            _FeedResponse(200, b"{", {"Content-Type": "application/json"}),
        )
        for response in invalid:
            _FeedConnection.response = response
            with (
                self.subTest(status=response.status),
                mock.patch.object(notifications.http.client, "HTTPSConnection", _FeedConnection),
                self.assertRaises(notifications.ReleaseFeedError),
            ):
                notifications._fetch_feed(None)

        _FeedConnection.response = _FeedResponse(304)
        with mock.patch.object(notifications.http.client, "HTTPSConnection", _FeedConnection):
            self.assertEqual(notifications._fetch_feed('"etag"'), ("not_modified", None, '"etag"'))

        with self.assertRaises(notifications.ReleaseFeedError):
            notifications._require_feed_length(_FeedResponse(200, headers={"Content-Length": "bad"}))
        with (
            mock.patch.object(notifications.http.client, "HTTPSConnection", side_effect=OSError("offline")),
            self.assertRaisesRegex(notifications.ReleaseFeedError, "unavailable"),
        ):
            notifications._fetch_feed(None)

    def test_controller_inventory_projections_are_closed(self) -> None:
        with self.assertRaises(ValueError):
            notifications._allowed_envelope([], "teams")
        with self.assertRaises(ValueError):
            notifications._allowed_envelope({"teams": [], "trace_id": "bad"}, "teams")
        with self.assertRaises(ValueError):
            notifications._allowed_envelope({"teams": [], "extra": True}, "teams")

        invalid_teams = (
            _response(503, {}),
            _response(200, {"teams": "bad"}),
            _response(200, {"teams": [{}]}),
            _response(200, {"teams": [{"team_id": "team", "team_name": "Team", "status": "stopped"}]}),
            _response(
                200,
                {
                    "teams": [
                        {"team_id": "team", "team_name": "Team", "status": "running"},
                        {"team_id": "team", "team_name": "Team", "status": "running"},
                    ]
                },
            ),
        )
        for response in invalid_teams:
            with self.assertRaises((OSError, ValueError, team.TeamRequestError)):
                notifications._team_ids(response)

        invalid_assistants = (
            _response(503, {}),
            _response(200, {"assistants": "bad"}),
            _response(200, {"assistants": [{}]}),
            _response(200, {"assistants": [{"assistant": "assistant", "status": "unknown"}]}),
            _response(
                200,
                {
                    "assistants": [
                        {"assistant": "assistant", "status": "running"},
                        {"assistant": "assistant", "status": "running"},
                    ]
                },
            ),
        )
        for response in invalid_assistants:
            with self.assertRaises((OSError, ValueError, team.TeamRequestError)):
                notifications._installed(response)

    def test_pruning_resolution_and_reconciliation_edges(self) -> None:
        records = [
            {
                "id": str(index),
                **_release(sequence=index + 1),
                "read_at": "2026-08-01T00:00:00Z" if index == 1 else None,
            }
            for index in range(3)
        ]
        with mock.patch.object(notifications, "MAX_NOTIFICATIONS", 2):
            self.assertEqual(len(notifications._prune(records)), 2)

        state = notifications._default_state()
        with mock.patch.object(notifications, "_fetch_feed", return_value=("invalid", None, None)):
            self.assertEqual(notifications._resolve_feed(state)[0], "offline")

        feed = {"schema_version": 1, "releases": [_release()]}
        state = notifications._default_state()
        state["cursors"] = {"assistant": 1}
        with notifications._STORE_LOCK:
            notifications._write_unlocked(state)
        result = notifications._inventory_failure("ok", feed, '"etag"')
        self.assertEqual(result["sync"]["status"], "partial")
        self.assertEqual(notifications._read()["etag"], '"etag"')
        offline = notifications._inventory_failure("offline", feed, None)
        self.assertEqual(offline["sync"]["status"], "partial")

        self.assertEqual(
            notifications._unseen_releases(
                "assistant",
                [_release()],
                {},
                {"team": {"assistant": "running"}},
                {"assistant"},
            ),
            [_release()],
        )
        self.assertEqual(
            notifications._unseen_releases(
                "assistant",
                [_release(sequence=1), _release(sequence=2)],
                {"assistant": 1},
                {"team": {"assistant": "running"}},
                {"assistant"},
            ),
            [_release(sequence=2)],
        )

        state = notifications._default_state()
        state["cursors"] = {"assistant": 1}
        with notifications._STORE_LOCK:
            notifications._write_unlocked(state)
        envelope, added = notifications._reconcile_state(
            feed_status="ok",
            feed={"schema_version": 1, "releases": [_release(sequence=1), _release(sequence=2)]},
            etag='"v2"',
            inventories={"team": {"assistant": "running"}},
            installed_ids={"assistant"},
            had_outdated={"assistant"},
        )
        self.assertEqual((added, envelope["unread_count"]), (1, 1))

        duplicate_state = notifications._read()
        duplicate_state["cursors"]["assistant"] = 1
        with notifications._STORE_LOCK:
            notifications._write_unlocked(duplicate_state)
        _, duplicate_added = notifications._reconcile_state(
            feed_status="ok",
            feed={"schema_version": 1, "releases": [_release(sequence=1), _release(sequence=2)]},
            etag='"v2"',
            inventories={"team": {"assistant": "running"}},
            installed_ids={"assistant"},
            had_outdated={"assistant"},
        )
        self.assertEqual(duplicate_added, 0)

    def test_sync_bounds_and_read_mutation_edges(self) -> None:
        inventories = {"team": {f"assistant-{index}": "running" for index in range(2)}}
        empty_feed = notifications._default_state()["cached_feed"]
        with (
            mock.patch.object(notifications, "MAX_CURSORS", 1),
            mock.patch.object(notifications, "_resolve_feed", return_value=("offline", empty_feed, None)),
            mock.patch.object(notifications, "_inventories", return_value=inventories),
            self.assertRaises(notifications.NotificationStoreError),
        ):
            notifications.sync()

        with (
            mock.patch.object(notifications, "_resolve_feed", return_value=("offline", empty_feed, None)),
            mock.patch.object(notifications, "_inventories", side_effect=OSError("offline")),
        ):
            self.assertEqual(notifications.sync()["sync"]["status"], "partial")

        with self.assertRaises(KeyError):
            notifications.mark_read("bad")
        with self.assertRaises(KeyError):
            notifications.mark_read("a" * 32)

        state = notifications._default_state()
        state["notifications"] = [
            {
                "id": notifications._notification_id("assistant", sequence),
                **_release(sequence=sequence),
                "read_at": None,
            }
            for sequence in (1, 2)
        ]
        with notifications._STORE_LOCK:
            notifications._write_unlocked(state)
        second_id = state["notifications"][1]["id"]
        self.assertEqual(notifications.mark_read(second_id)["unread_count"], 1)
        self.assertEqual(notifications.mark_read(second_id)["unread_count"], 1)
        self.assertEqual(notifications.mark_all_read()["unread_count"], 0)
        self.assertEqual(notifications.clear()["notifications"], [])


if __name__ == "__main__":
    unittest.main()
