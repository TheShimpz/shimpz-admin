"""Release notification state, reconciliation, and authenticated route contracts."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import notifications
import teams

TRACE_ID = "a" * 32


def _release(assistant_id: str, sequence: int) -> dict[str, object]:
    return {
        "assistant_id": assistant_id,
        "sequence": sequence,
        "headline": f"Release {sequence}",
        "changelog": f"## Release {sequence}\n\nA safe change.",
        "published_at": f"2026-07-{sequence:02d}T12:00:00Z",
    }


def _feed(*releases: dict[str, object]) -> dict[str, object]:
    return {"schema_version": 1, "releases": list(releases)}


def _teams(*team_ids: str) -> teams.DriverResponse:
    return teams.DriverResponse(
        200,
        {
            "teams": [{"team_id": team_id, "team_name": team_id.title(), "status": "running"} for team_id in team_ids],
            "trace_id": TRACE_ID,
        },
    )


def _installed(**statuses: str) -> teams.DriverResponse:
    return teams.DriverResponse(
        200,
        {
            "assistants": [{"assistant": assistant_id, "status": status} for assistant_id, status in statuses.items()],
            "trace_id": TRACE_ID,
        },
    )


def _install_response(assistant_id: str, *, status: int = 200) -> teams.DriverResponse:
    if status != 200:
        return teams.DriverResponse(status, {"detail": "update failed"})
    return teams.DriverResponse(
        200,
        {"assistant": assistant_id, "installed": False, "trace_id": TRACE_ID},
    )


class NotificationStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.previous_store = notifications.STORE_PATH
        notifications.STORE_PATH = Path(self.tempdir.name) / "notifications.json"
        self.addCleanup(setattr, notifications, "STORE_PATH", self.previous_store)

    def _sync_mocks(
        self,
        feed: dict[str, object],
        *,
        inventory: teams.DriverResponse,
        fetch_status: str = "fresh",
    ):
        return (
            mock.patch.object(
                notifications,
                "_fetch_feed",
                return_value=(fetch_status, feed if fetch_status == "fresh" else None, '"v1"'),
            ),
            mock.patch.object(notifications.teams, "list_teams", return_value=_teams("marketing")),
            mock.patch.object(notifications.teams, "list_installed_assistants", return_value=inventory),
        )

    def test_first_current_observation_baselines_only_installed_assistants(self) -> None:
        feed = _feed(_release("shimpz-assistant", 1), _release("other-assistant", 1))
        fetch, list_teams, list_installed = self._sync_mocks(
            feed,
            inventory=_installed(**{"shimpz-assistant": "running"}),
        )
        with fetch, list_teams, list_installed, mock.patch.object(notifications.teams, "install_assistant") as install:
            result = notifications.sync()

        self.assertEqual(result["notifications"], [])
        self.assertEqual(result["unread_count"], 0)
        self.assertEqual(
            result["sync"],
            {
                "status": "ok",
                "updated_assistants": 0,
                "notifications_added": 0,
                "failed_updates": 0,
            },
        )
        self.assertEqual(notifications._read()["cursors"], {"shimpz-assistant": 1})
        install.assert_not_called()

    def test_newer_feed_waits_for_controller_to_report_outdated(self) -> None:
        state = notifications._default_state()
        state["cached_feed"] = _feed(_release("shimpz-assistant", 1))
        state["cursors"] = {"shimpz-assistant": 1}
        with notifications._STORE_LOCK:
            notifications._write_unlocked(state)
        feed = _feed(_release("shimpz-assistant", 1), _release("shimpz-assistant", 2))

        with (
            mock.patch.object(notifications, "_fetch_feed", return_value=("fresh", feed, '"v2"')),
            mock.patch.object(notifications.teams, "list_teams", return_value=_teams("marketing")),
            mock.patch.object(
                notifications.teams,
                "list_installed_assistants",
                return_value=_installed(**{"shimpz-assistant": "running"}),
            ),
            mock.patch.object(notifications.teams, "install_assistant") as install,
        ):
            result = notifications.sync()

        self.assertEqual(result["notifications"], [])
        self.assertEqual(notifications._read()["cursors"], {"shimpz-assistant": 1})
        install.assert_not_called()

    def test_outdated_assistant_uses_id_only_update_then_emits_unseen_notice(self) -> None:
        state = notifications._default_state()
        state["cached_feed"] = _feed(_release("shimpz-assistant", 1))
        state["cursors"] = {"shimpz-assistant": 1}
        with notifications._STORE_LOCK:
            notifications._write_unlocked(state)
        feed = _feed(_release("shimpz-assistant", 1), _release("shimpz-assistant", 2))

        with (
            mock.patch.object(notifications, "_fetch_feed", return_value=("fresh", feed, '"v2"')),
            mock.patch.object(notifications.teams, "list_teams", return_value=_teams("marketing")),
            mock.patch.object(
                notifications.teams,
                "list_installed_assistants",
                side_effect=[
                    _installed(**{"shimpz-assistant": "outdated"}),
                    _installed(**{"shimpz-assistant": "running"}),
                ],
            ),
            mock.patch.object(
                notifications.teams,
                "install_assistant",
                return_value=_install_response("shimpz-assistant"),
            ) as install,
        ):
            result = notifications.sync()

        install.assert_called_once_with("marketing", {"assistant": "shimpz-assistant"})
        self.assertEqual(result["sync"]["updated_assistants"], 1)
        self.assertEqual(result["sync"]["notifications_added"], 1)
        self.assertEqual(result["unread_count"], 1)
        self.assertEqual(result["notifications"][0]["sequence"], 2)
        self.assertIsNone(result["notifications"][0]["read_at"])
        self.assertEqual(notifications._read()["cursors"], {"shimpz-assistant": 2})

    def test_304_reuses_cached_feed(self) -> None:
        state = notifications._default_state()
        state["etag"] = '"v2"'
        state["cached_feed"] = _feed(_release("shimpz-assistant", 1), _release("shimpz-assistant", 2))
        state["cursors"] = {"shimpz-assistant": 1}
        with notifications._STORE_LOCK:
            notifications._write_unlocked(state)

        with (
            mock.patch.object(notifications, "_fetch_feed", return_value=("not_modified", None, '"v2"')),
            mock.patch.object(notifications.teams, "list_teams", return_value=_teams("marketing")),
            mock.patch.object(
                notifications.teams,
                "list_installed_assistants",
                side_effect=[
                    _installed(**{"shimpz-assistant": "outdated"}),
                    _installed(**{"shimpz-assistant": "running"}),
                ],
            ),
            mock.patch.object(
                notifications.teams,
                "install_assistant",
                return_value=_install_response("shimpz-assistant"),
            ),
        ):
            result = notifications.sync()

        self.assertEqual([item["sequence"] for item in result["notifications"]], [2])

    def test_offline_feed_is_nonfatal_and_still_uses_local_upgrade_authority(self) -> None:
        with (
            mock.patch.object(notifications, "_fetch_feed", side_effect=notifications.ReleaseFeedError("offline")),
            mock.patch.object(notifications.teams, "list_teams", return_value=_teams("marketing")),
            mock.patch.object(
                notifications.teams,
                "list_installed_assistants",
                side_effect=[
                    _installed(**{"shimpz-assistant": "outdated"}),
                    _installed(**{"shimpz-assistant": "running"}),
                ],
            ),
            mock.patch.object(
                notifications.teams,
                "install_assistant",
                return_value=_install_response("shimpz-assistant"),
            ) as install,
        ):
            result = notifications.sync()

        self.assertEqual(result["sync"]["status"], "offline")
        self.assertEqual(result["sync"]["updated_assistants"], 1)
        self.assertEqual(result["notifications"], [])
        install.assert_called_once_with("marketing", {"assistant": "shimpz-assistant"})

    def test_update_failure_retains_cursor_and_emits_nothing(self) -> None:
        state = notifications._default_state()
        state["cursors"] = {"shimpz-assistant": 1}
        with notifications._STORE_LOCK:
            notifications._write_unlocked(state)
        feed = _feed(_release("shimpz-assistant", 1), _release("shimpz-assistant", 2))

        with (
            mock.patch.object(notifications, "_fetch_feed", return_value=("fresh", feed, '"v2"')),
            mock.patch.object(notifications.teams, "list_teams", return_value=_teams("marketing")),
            mock.patch.object(
                notifications.teams,
                "list_installed_assistants",
                return_value=_installed(**{"shimpz-assistant": "outdated"}),
            ),
            mock.patch.object(
                notifications.teams,
                "install_assistant",
                return_value=_install_response("shimpz-assistant", status=503),
            ),
        ):
            result = notifications.sync()

        self.assertEqual(result["sync"]["status"], "partial")
        self.assertEqual(result["sync"]["failed_updates"], 1)
        self.assertEqual(result["notifications"], [])
        self.assertEqual(notifications._read()["cursors"], {"shimpz-assistant": 1})

    def test_feed_cannot_supply_a_digest_or_expand_the_update_request(self) -> None:
        unsafe = _release("shimpz-assistant", 1)
        unsafe["digest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ValueError, "release fields"):
            notifications.validate_feed(_feed(unsafe))
        textual_digest = _release("shimpz-assistant", 1)
        textual_digest["changelog"] = "Run sha256:" + "f" * 64
        with self.assertRaisesRegex(ValueError, "executable installation metadata"):
            notifications.validate_feed(_feed(textual_digest), allow_empty=False)

        with (
            mock.patch.object(notifications, "_fetch_feed", side_effect=notifications.ReleaseFeedError("invalid")),
            mock.patch.object(notifications.teams, "list_teams", return_value=_teams("marketing")),
            mock.patch.object(
                notifications.teams,
                "list_installed_assistants",
                side_effect=[
                    _installed(**{"shimpz-assistant": "outdated"}),
                    _installed(**{"shimpz-assistant": "running"}),
                ],
            ),
            mock.patch.object(
                notifications.teams,
                "install_assistant",
                return_value=_install_response("shimpz-assistant"),
            ) as install,
        ):
            notifications.sync()
        self.assertEqual(install.call_args.args, ("marketing", {"assistant": "shimpz-assistant"}))
        self.assertNotIn("digest", json.dumps(install.call_args.args))

    def test_fixed_https_fetch_sends_only_public_conditional_headers_and_never_redirects(self) -> None:
        body = json.dumps(_feed(_release("shimpz-assistant", 1)), separators=(",", ":")).encode()

        class Response:
            status = 200

            @staticmethod
            def getheader(name):
                return {
                    "Content-Type": "application/json",
                    "Content-Length": str(len(body)),
                    "ETag": '"v1"',
                }.get(name)

            @staticmethod
            def read(_maximum):
                return body

        class Connection:
            def __init__(self):
                self.request_args = None

            def request(self, *args, **kwargs):
                self.request_args = (args, kwargs)

            @staticmethod
            def getresponse():
                return Response()

            @staticmethod
            def close():
                pass

        connection = Connection()
        with mock.patch.object(notifications.http.client, "HTTPSConnection", return_value=connection) as constructor:
            status, fetched, etag = notifications._fetch_feed('"previous"')

        constructor.assert_called_once_with("shimpz.com", 443, timeout=notifications.FEED_TIMEOUT_SECONDS)
        args, kwargs = connection.request_args
        self.assertEqual(args, ("GET", "/api/releases/assistants"))
        self.assertEqual(
            kwargs["headers"],
            {
                "Accept": "application/json",
                "User-Agent": "shimpz-admin-release-sync/1",
                "If-None-Match": '"previous"',
            },
        )
        self.assertNotIn("authorization", {key.lower() for key in kwargs["headers"]})
        self.assertNotIn("cookie", {key.lower() for key in kwargs["headers"]})
        self.assertEqual((status, fetched, etag), ("fresh", _feed(_release("shimpz-assistant", 1)), '"v1"'))

        Response.status = 302
        with (
            mock.patch.object(notifications.http.client, "HTTPSConnection", return_value=Connection()),
            self.assertRaises(notifications.ReleaseFeedError),
        ):
            notifications._fetch_feed(None)

    def test_feed_and_private_state_are_strictly_bounded(self) -> None:
        oversized_feed = _feed(*(_release(f"assistant-{index}", 1) for index in range(notifications.MAX_RELEASES + 1)))
        with self.assertRaisesRegex(ValueError, "release list"):
            notifications.validate_feed(oversized_feed)

        state = notifications._default_state()
        state["unexpected"] = True
        notifications.STORE_PATH.write_text(json.dumps(state), encoding="utf-8")
        notifications.STORE_PATH.chmod(0o600)
        with self.assertRaises(notifications.NotificationStoreError):
            notifications.list_notifications()

    def test_mark_read_mark_all_and_clear_retain_cursors(self) -> None:
        state = notifications._default_state()
        state["cursors"] = {"shimpz-assistant": 2}
        state["notifications"] = [
            {
                "id": notifications._notification_id("shimpz-assistant", sequence),
                **_release("shimpz-assistant", sequence),
                "read_at": None,
            }
            for sequence in (1, 2)
        ]
        with notifications._STORE_LOCK:
            notifications._write_unlocked(state)

        first_id = state["notifications"][0]["id"]
        marked = notifications.mark_read(first_id)
        self.assertEqual(marked["unread_count"], 1)
        self.assertRegex(marked["notifications"][0]["read_at"], r"^\d{4}-\d{2}-\d{2}T")
        all_read = notifications.mark_all_read()
        self.assertEqual(all_read["unread_count"], 0)
        cleared = notifications.clear()
        self.assertEqual(cleared, {"notifications": [], "unread_count": 0})
        self.assertEqual(notifications._read()["cursors"], {"shimpz-assistant": 2})

    def test_store_is_0600_and_corruption_fails_loud(self) -> None:
        with notifications._STORE_LOCK:
            notifications._write_unlocked(notifications._default_state())
        self.assertEqual(notifications.STORE_PATH.stat().st_mode & 0o777, 0o600)
        notifications.STORE_PATH.write_text("not json", encoding="utf-8")
        with self.assertRaises(notifications.NotificationStoreError):
            notifications.list_notifications()


async def _asgi_request(admin_app, method: str, path: str, *, token: str = ""):
    headers = [(b"accept", b"application/json"), (b"content-length", b"0")]
    if token:
        headers.append((b"cookie", f"{admin_app.COOKIE}={token}".encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.5"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.Event().wait()
        raise AssertionError("unreachable receive state")

    messages: list[dict[str, object]] = []

    async def send(message):
        messages.append(message)

    await asyncio.wait_for(admin_app.app(scope, receive, send), timeout=5)
    start = next(message for message in messages if message["type"] == "http.response.start")
    raw = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return int(start["status"]), json.loads(raw or b"{}")


class NotificationRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        root = Path(cls.tempdir.name)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(root),
                "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
                "SHIMPZ_NOTIFICATION_STORE": str(root / "notifications.json"),
            },
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")
        previous_admin_store = cls.admin_app.adminstore.STORE_PATH
        previous_notification_store = cls.admin_app.notifications.STORE_PATH
        cls.admin_app.adminstore.STORE_PATH = root / "admin.json"
        cls.admin_app.notifications.STORE_PATH = root / "notifications.json"
        cls.addClassCleanup(setattr, cls.admin_app.adminstore, "STORE_PATH", previous_admin_store)
        cls.addClassCleanup(setattr, cls.admin_app.notifications, "STORE_PATH", previous_notification_store)
        cls.admin_app.adminstore.set_password("test-admin-password")
        cls.token = cls.admin_app.auth.issue_session(cls.admin_app.adminstore.get()["session_secret"])

    def setUp(self) -> None:
        self.admin_app.notifications.STORE_PATH.unlink(missing_ok=True)

    def test_notification_routes_are_session_gated_and_return_exact_envelopes(self) -> None:
        anonymous_status, _ = asyncio.run(_asgi_request(self.admin_app, "GET", "/api/notifications"))
        self.assertEqual(anonymous_status, 401)

        with mock.patch.object(
            self.admin_app.notifications,
            "sync",
            return_value={
                "notifications": [],
                "unread_count": 0,
                "sync": {
                    "status": "offline",
                    "updated_assistants": 0,
                    "notifications_added": 0,
                    "failed_updates": 0,
                },
            },
        ):
            sync_status, sync_body = asyncio.run(
                _asgi_request(self.admin_app, "POST", "/api/notifications/sync", token=self.token)
            )
        self.assertEqual(sync_status, 200)
        self.assertEqual(sync_body["sync"]["status"], "offline")

        list_status, list_body = asyncio.run(
            _asgi_request(self.admin_app, "GET", "/api/notifications", token=self.token)
        )
        self.assertEqual(list_status, 200)
        self.assertEqual(list_body, {"notifications": [], "unread_count": 0})

        missing_status, missing_body = asyncio.run(
            _asgi_request(self.admin_app, "POST", f"/api/notifications/{'f' * 32}/read", token=self.token)
        )
        self.assertEqual(missing_status, 404)
        self.assertEqual(missing_body, {"detail": "notification not found"})

        all_status, all_body = asyncio.run(
            _asgi_request(self.admin_app, "POST", "/api/notifications/read-all", token=self.token)
        )
        clear_status, clear_body = asyncio.run(
            _asgi_request(self.admin_app, "DELETE", "/api/notifications", token=self.token)
        )
        self.assertEqual((all_status, all_body), (200, {"notifications": [], "unread_count": 0}))
        self.assertEqual((clear_status, clear_body), (200, {"notifications": [], "unread_count": 0}))


if __name__ == "__main__":
    unittest.main()
