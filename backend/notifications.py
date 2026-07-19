"""Private Assistant release notifications for the local Admin.

The public shimpz.com feed is display metadata only.  It can never select an image,
digest, Team, or Power.  Runtime upgrades continue to use the local controller's
build-pinned Assistant registry and are requested only by canonical Assistant id.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import logging
import os
import re
import stat
import threading
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path

import teams

log = logging.getLogger("shimpz-admin")

STORE_PATH = Path(os.environ.get("SHIMPZ_NOTIFICATION_STORE") or "/data/notifications.json")
FEED_HOST = "shimpz.com"
FEED_PATH = "/api/releases/assistants"
FEED_TIMEOUT_SECONDS = 5
MAX_FEED_BYTES = 512 * 1024
MAX_STORE_BYTES = 5 * 1024 * 1024
MAX_RELEASES = 256
MAX_NOTIFICATIONS = 256
MAX_TEAMS = teams.MAX_TEAMS
MAX_INSTALLED_PER_TEAM = 256
MAX_CURSORS = 1024
MAX_HEADLINE_BYTES = 160
MAX_CHANGELOG_BYTES = 32 * 1024
MAX_ETAG_CHARS = 256
MAX_SEQUENCE = (1 << 63) - 1

_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_NOTIFICATION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_EXECUTABLE_REFERENCE_RE = re.compile(
    r"(?:sha256:[0-9a-f]{64}|\bdocker\s+(?:pull|run|compose)\b|"
    r"\b(?:curl|wget)\b[^\r\n|]{0,512}\|\s*(?:ba)?sh\b)",
    re.IGNORECASE,
)
_RUNTIME_STATUSES = frozenset({"created", "restarting", "running", "removing", "paused", "exited", "dead", "outdated"})

_STORE_LOCK = threading.RLock()
_SYNC_LOCK = threading.Lock()


class NotificationStoreError(RuntimeError):
    """The private notification state is corrupt and must not be silently reset."""


class ReleaseFeedError(OSError):
    """The optional public release feed could not be safely consumed."""


def _utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _canonical_timestamp(value: object, *, field: str) -> str:
    if not isinstance(value, str) or _RFC3339_RE.fullmatch(value) is None:
        raise ValueError(f"invalid {field}")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError as exc:
        raise ValueError(f"invalid {field}") from exc
    if parsed.strftime("%Y-%m-%dT%H:%M:%SZ") != value:
        raise ValueError(f"invalid {field}")
    return value


def _canonical_sequence(value: object, *, allow_zero: bool = False) -> int:
    minimum = 0 if allow_zero else 1
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= MAX_SEQUENCE:
        raise ValueError("invalid release sequence")
    return value


def _canonical_headline(value: object) -> str:
    try:
        encoded = value.encode("utf-8") if isinstance(value, str) else b""
    except UnicodeError as exc:
        raise ValueError("invalid release headline") from exc
    if (
        not isinstance(value, str)
        or not 1 <= len(encoded) <= MAX_HEADLINE_BYTES
        or value.strip() != value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("invalid release headline")
    return value


def _canonical_changelog(value: object) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError("invalid release changelog")
    try:
        encoded = value.encode("utf-8")
    except UnicodeError as exc:
        raise ValueError("invalid release changelog") from exc
    if len(encoded) > MAX_CHANGELOG_BYTES:
        raise ValueError("release changelog is too large")
    if any(ord(character) < 32 and character not in "\n\r\t" for character in value) or "\x7f" in value:
        raise ValueError("invalid release changelog")
    return value


def _canonical_etag(value: object) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= MAX_ETAG_CHARS
        or any(not 33 <= ord(character) <= 126 for character in value)
    ):
        raise ValueError("invalid release feed ETag")
    return value


def _canonical_release(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != {
        "assistant_id",
        "sequence",
        "headline",
        "changelog",
        "published_at",
    }:
        raise ValueError("invalid release fields")
    assistant_id = teams.canonical_assistant_id(value["assistant_id"])
    if assistant_id != value["assistant_id"]:
        raise ValueError("non-canonical Assistant id")
    release = {
        "assistant_id": assistant_id,
        "sequence": _canonical_sequence(value["sequence"]),
        "headline": _canonical_headline(value["headline"]),
        "changelog": _canonical_changelog(value["changelog"]),
        "published_at": _canonical_timestamp(value["published_at"], field="published_at"),
    }
    if any(_EXECUTABLE_REFERENCE_RE.search(str(release[field])) is not None for field in ("headline", "changelog")):
        raise ValueError("release contains executable installation metadata")
    return release


def validate_feed(value: object, *, allow_empty: bool = True) -> dict[str, object]:
    """Validate and canonically order the exact public metadata feed contract."""
    if not isinstance(value, dict) or set(value) != {"schema_version", "releases"}:
        raise ValueError("invalid Assistant release feed")
    if value["schema_version"] != 1 or isinstance(value["schema_version"], bool):
        raise ValueError("unsupported Assistant release feed schema")
    releases = value["releases"]
    if not isinstance(releases, list) or not (0 if allow_empty else 1) <= len(releases) <= MAX_RELEASES:
        raise ValueError("invalid Assistant release list")
    canonical = [_canonical_release(item) for item in releases]
    previous: dict[str, int] = {}
    for item in canonical:
        assistant_id = str(item["assistant_id"])
        sequence = int(item["sequence"])
        if sequence <= previous.get(assistant_id, 0):
            raise ValueError("Assistant release sequence is not increasing")
        previous[assistant_id] = sequence
    return {"schema_version": 1, "releases": canonical}


def _notification_id(assistant_id: str, sequence: int) -> str:
    return hashlib.sha256(f"{assistant_id}\0{sequence}".encode("ascii")).hexdigest()[:32]


def _canonical_notification(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != {
        "id",
        "assistant_id",
        "sequence",
        "headline",
        "changelog",
        "published_at",
        "read_at",
    }:
        raise ValueError("invalid notification fields")
    release = _canonical_release(
        {key: value[key] for key in ("assistant_id", "sequence", "headline", "changelog", "published_at")}
    )
    notification_id = value["id"]
    if (
        not isinstance(notification_id, str)
        or _NOTIFICATION_ID_RE.fullmatch(notification_id) is None
        or notification_id != _notification_id(str(release["assistant_id"]), int(release["sequence"]))
    ):
        raise ValueError("invalid notification id")
    read_at = value["read_at"]
    if read_at is not None:
        read_at = _canonical_timestamp(read_at, field="read_at")
    return {"id": notification_id, **release, "read_at": read_at}


def _default_state() -> dict[str, object]:
    return {
        "schema_version": 1,
        "etag": None,
        "cached_feed": {"schema_version": 1, "releases": []},
        "cursors": {},
        "notifications": [],
    }


def _validate_state(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != {
        "schema_version",
        "etag",
        "cached_feed",
        "cursors",
        "notifications",
    }:
        raise ValueError("invalid notification state")
    if value["schema_version"] != 1 or isinstance(value["schema_version"], bool):
        raise ValueError("unsupported notification state schema")
    etag = _canonical_etag(value["etag"])
    cached_feed = validate_feed(value["cached_feed"])
    cursors = value["cursors"]
    if not isinstance(cursors, dict) or len(cursors) > MAX_CURSORS:
        raise ValueError("invalid notification cursors")
    canonical_cursors: dict[str, int] = {}
    for assistant_id, sequence in cursors.items():
        canonical_id = teams.canonical_assistant_id(assistant_id)
        if canonical_id != assistant_id:
            raise ValueError("invalid notification cursor")
        canonical_cursors[canonical_id] = _canonical_sequence(sequence)
    records = value["notifications"]
    if not isinstance(records, list) or len(records) > MAX_NOTIFICATIONS:
        raise ValueError("invalid notification records")
    canonical_records = [_canonical_notification(item) for item in records]
    ids = [str(item["id"]) for item in canonical_records]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate notification id")
    canonical_records.sort(
        key=lambda item: (str(item["published_at"]), str(item["assistant_id"]), int(item["sequence"]))
    )
    return {
        "schema_version": 1,
        "etag": etag,
        "cached_feed": cached_feed,
        "cursors": canonical_cursors,
        "notifications": canonical_records,
    }


def _read_unlocked() -> dict[str, object]:
    if not STORE_PATH.exists():
        return _default_state()
    try:
        info = STORE_PATH.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > MAX_STORE_BYTES:
            raise NotificationStoreError("notification store has unsafe metadata")
        raw = STORE_PATH.read_bytes()
        if len(raw) > MAX_STORE_BYTES:
            raise NotificationStoreError("notification store is too large")
        document = json.loads(raw)
        state = _validate_state(document)
    except NotificationStoreError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError, teams.TeamRequestError) as exc:
        raise NotificationStoreError("notification store is corrupt; refusing to continue") from exc
    return state


def _write_unlocked(state: dict[str, object]) -> None:
    try:
        canonical = _validate_state(state)
        payload = json.dumps(
            canonical,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, teams.TeamRequestError) as exc:
        raise NotificationStoreError("refusing to write invalid notification state") from exc
    if len(payload) > MAX_STORE_BYTES:
        raise NotificationStoreError("notification store is too large")
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STORE_PATH.with_name(f".{STORE_PATH.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    fd = -1
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_TRUNC, 0o600)
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short notification store write")
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        fd = -1
        temporary.replace(STORE_PATH)
    except OSError as exc:
        raise NotificationStoreError("notification store could not be written") from exc
    finally:
        if fd >= 0:
            os.close(fd)
        temporary.unlink(missing_ok=True)


def _read() -> dict[str, object]:
    with _STORE_LOCK:
        return _read_unlocked()


def _public_envelope(state: dict[str, object]) -> dict[str, object]:
    records = [dict(item) for item in state["notifications"]]
    return {
        "notifications": records,
        "unread_count": sum(item["read_at"] is None for item in records),
    }


def list_notifications() -> dict[str, object]:
    return _public_envelope(_read())


def _fetch_feed(etag: str | None) -> tuple[str, dict[str, object] | None, str | None]:
    """Fetch the one fixed HTTPS feed without redirects or caller-controlled authority."""
    connection = None
    try:
        connection = http.client.HTTPSConnection(FEED_HOST, 443, timeout=FEED_TIMEOUT_SECONDS)
        headers = {"Accept": "application/json", "User-Agent": "shimpz-admin-release-sync/1"}
        if etag is not None:
            headers["If-None-Match"] = etag
        connection.request("GET", FEED_PATH, headers=headers)
        response = connection.getresponse()
        if response.status == 304:
            raw = response.read(MAX_FEED_BYTES + 1)
            if raw:
                raise ReleaseFeedError("invalid not-modified response")
            return "not_modified", None, etag
        if response.status != 200:
            raise ReleaseFeedError("release feed unavailable")
        content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
        if content_type != "application/json":
            raise ReleaseFeedError("invalid release feed content type")
        raw_length = response.getheader("Content-Length")
        if raw_length is not None and (
            not raw_length.isascii() or not raw_length.isdigit() or int(raw_length) > MAX_FEED_BYTES
        ):
            raise ReleaseFeedError("invalid release feed length")
        raw = response.read(MAX_FEED_BYTES + 1)
        if not raw or len(raw) > MAX_FEED_BYTES:
            raise ReleaseFeedError("invalid release feed length")
        try:
            document = json.loads(raw)
            feed = validate_feed(document, allow_empty=False)
            response_etag = _canonical_etag(response.getheader("ETag"))
        except (json.JSONDecodeError, UnicodeError, TypeError, ValueError, teams.TeamRequestError) as exc:
            raise ReleaseFeedError("invalid release feed") from exc
        else:
            return "fresh", feed, response_etag
    except (OSError, http.client.HTTPException, UnicodeError) as exc:
        if isinstance(exc, ReleaseFeedError):
            raise
        raise ReleaseFeedError("release feed unavailable") from exc
    finally:
        if connection is not None:
            with suppress(OSError):
                connection.close()


def _allowed_envelope(body: object, field: str) -> object:
    if not isinstance(body, dict):
        raise ValueError("invalid controller response")
    allowed = {field}
    if "trace_id" in body:
        allowed.add("trace_id")
        trace_id = body["trace_id"]
        if not isinstance(trace_id, str) or _TRACE_ID_RE.fullmatch(trace_id) is None:
            raise ValueError("invalid controller trace id")
    if set(body) != allowed:
        raise ValueError("invalid controller response")
    return body[field]


def _team_ids(response: teams.DriverResponse) -> list[str]:
    if not 200 <= response.status < 300:
        raise OSError("Team inventory unavailable")
    inventory = _allowed_envelope(response.body, "teams")
    if not isinstance(inventory, list) or len(inventory) > MAX_TEAMS:
        raise ValueError("invalid Team inventory")
    ids: list[str] = []
    for item in inventory:
        if not isinstance(item, dict) or set(item) != {"team_id", "team_name", "status"}:
            raise ValueError("invalid Team inventory")
        team_id = teams.canonical_team_id(item["team_id"])
        team_name = teams.canonical_team_name(item["team_name"])
        if team_id != item["team_id"] or team_name != item["team_name"] or item["status"] != "running":
            raise ValueError("invalid Team inventory")
        ids.append(team_id)
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate Team inventory")
    return ids


def _installed(response: teams.DriverResponse) -> dict[str, str]:
    if not 200 <= response.status < 300:
        raise OSError("Assistant inventory unavailable")
    inventory = _allowed_envelope(response.body, "assistants")
    if not isinstance(inventory, list) or len(inventory) > MAX_INSTALLED_PER_TEAM:
        raise ValueError("invalid Assistant inventory")
    result: dict[str, str] = {}
    for item in inventory:
        if not isinstance(item, dict) or set(item) != {"assistant", "status"}:
            raise ValueError("invalid Assistant inventory")
        assistant_id = teams.canonical_assistant_id(item["assistant"])
        status = item["status"]
        if assistant_id != item["assistant"] or not isinstance(status, str) or status not in _RUNTIME_STATUSES:
            raise ValueError("invalid Assistant inventory")
        if assistant_id in result:
            raise ValueError("duplicate Assistant inventory")
        result[assistant_id] = status
    return result


def _upgrade(team_id: str, assistant_id: str) -> bool:
    """Use only the controller's ID-based, build-pinned install path and verify readiness."""
    response = teams.install_assistant(team_id, {"assistant": assistant_id})
    if not 200 <= response.status < 300:
        return False
    try:
        allowed = {"assistant", "installed"}
        if "trace_id" in response.body:
            allowed.add("trace_id")
            trace_id = response.body["trace_id"]
            if not isinstance(trace_id, str) or _TRACE_ID_RE.fullmatch(trace_id) is None:
                raise ValueError("invalid trace id")
        if (
            set(response.body) != allowed
            or response.body["assistant"] != assistant_id
            or not isinstance(response.body["installed"], bool)
        ):
            raise ValueError("invalid update response")
        verified = _installed(teams.list_installed_assistants(team_id))
    except KeyError, TypeError, ValueError, OSError, teams.TeamRequestError:
        return False
    return verified.get(assistant_id) == "running"


def _prune(records: list[dict[str, object]]) -> list[dict[str, object]]:
    records.sort(key=lambda item: (str(item["published_at"]), str(item["assistant_id"]), int(item["sequence"])))
    while len(records) > MAX_NOTIFICATIONS:
        read_index = next((index for index, item in enumerate(records) if item["read_at"] is not None), None)
        records.pop(0 if read_index is None else read_index)
    return records


def _resolve_feed(state: dict[str, object]) -> tuple[str, dict[str, object], str | None]:
    feed = state["cached_feed"]
    etag = state["etag"]
    try:
        result, fetched_feed, fetched_etag = _fetch_feed(etag if isinstance(etag, str) else None)
        if result == "fresh" and isinstance(fetched_feed, dict):
            return "ok", fetched_feed, fetched_etag
        if result != "not_modified":
            raise ReleaseFeedError("invalid release feed result")
    except ReleaseFeedError:
        log.warning("Assistant release feed unavailable")
        return "offline", feed, etag if isinstance(etag, str) else None
    return "ok", feed, etag if isinstance(etag, str) else None


def _inventories() -> dict[str, dict[str, str]]:
    return {team_id: _installed(teams.list_installed_assistants(team_id)) for team_id in _team_ids(teams.list_teams())}


def _inventory_failure(
    feed_status: str,
    feed: dict[str, object],
    etag: str | None,
) -> dict[str, object]:
    with _STORE_LOCK:
        state = _read_unlocked()
        if feed_status != "offline":
            state["cached_feed"] = feed
            state["etag"] = etag
            _write_unlocked(state)
        envelope = _public_envelope(state)
    return {
        **envelope,
        "sync": {
            "status": "partial",
            "updated_assistants": 0,
            "notifications_added": 0,
            "failed_updates": 1,
        },
    }


def _upgrade_outdated(
    inventories: dict[str, dict[str, str]],
) -> tuple[set[str], set[tuple[str, str]], int]:
    had_outdated: set[str] = set()
    successful: set[tuple[str, str]] = set()
    failed = 0
    for team_id, inventory in inventories.items():
        for assistant_id, status in inventory.items():
            if status != "outdated":
                continue
            had_outdated.add(assistant_id)
            if _upgrade(team_id, assistant_id):
                successful.add((team_id, assistant_id))
                inventory[assistant_id] = "running"
            else:
                failed += 1
    return had_outdated, successful, failed


def _installed_releases(
    feed: dict[str, object],
    installed_ids: set[str],
) -> dict[str, list[dict[str, object]]]:
    releases_by_assistant: dict[str, list[dict[str, object]]] = {}
    for release in feed["releases"]:
        assistant_id = str(release["assistant_id"])
        if assistant_id in installed_ids:
            releases_by_assistant.setdefault(assistant_id, []).append(release)
    return releases_by_assistant


def _unseen_releases(
    assistant_id: str,
    releases: list[dict[str, object]],
    cursors: dict[str, int],
    inventories: dict[str, dict[str, str]],
    had_outdated: set[str],
) -> list[dict[str, object]] | None:
    instances = [inventory[assistant_id] for inventory in inventories.values() if assistant_id in inventory]
    if not instances or any(status != "running" for status in instances):
        return None
    cursor = cursors.get(assistant_id)
    if cursor is None:
        if assistant_id not in had_outdated:
            # A current first observation is the baseline, not historical noise.
            cursors[assistant_id] = int(releases[-1]["sequence"])
            return None
        return releases
    # A newer metadata feed alone does not prove that the local build contains the release.
    # Wait until the controller reports the artifact as outdated.
    if assistant_id not in had_outdated:
        return None
    return [release for release in releases if int(release["sequence"]) > cursor]


def _reconcile_state(
    *,
    feed_status: str,
    feed: dict[str, object],
    etag: str | None,
    inventories: dict[str, dict[str, str]],
    installed_ids: set[str],
    had_outdated: set[str],
) -> tuple[dict[str, object], int]:
    releases_by_assistant = _installed_releases(feed, installed_ids)
    added = 0
    with _STORE_LOCK:
        state = _read_unlocked()
        if feed_status != "offline":
            state["cached_feed"] = feed
            state["etag"] = etag
        cursors: dict[str, int] = state["cursors"]
        records: list[dict[str, object]] = state["notifications"]
        existing_ids = {str(item["id"]) for item in records}
        for assistant_id in sorted(installed_ids):
            releases = releases_by_assistant.get(assistant_id, [])
            if not releases:
                continue
            unseen = _unseen_releases(assistant_id, releases, cursors, inventories, had_outdated)
            if unseen is None:
                continue
            for release in unseen:
                notification_id = _notification_id(assistant_id, int(release["sequence"]))
                if notification_id in existing_ids:
                    continue
                records.append({"id": notification_id, **release, "read_at": None})
                existing_ids.add(notification_id)
                added += 1
            cursors[assistant_id] = int(releases[-1]["sequence"])
        state["notifications"] = _prune(records)
        _write_unlocked(state)
        return _public_envelope(state), added


def sync() -> dict[str, object]:
    """Reconcile locally installed Assistants and their metadata-only release notices."""
    with _SYNC_LOCK:
        feed_status, feed, etag = _resolve_feed(_read())
        try:
            inventories = _inventories()
        except OSError, TypeError, ValueError, teams.TeamRequestError:
            return _inventory_failure(feed_status, feed, etag)

        installed_ids = {assistant_id for inventory in inventories.values() for assistant_id in inventory}
        if len(installed_ids) > MAX_CURSORS:
            raise NotificationStoreError("installed Assistant inventory exceeds notification bounds")
        had_outdated, successful_updates, failed_updates = _upgrade_outdated(inventories)
        envelope, notifications_added = _reconcile_state(
            feed_status=feed_status,
            feed=feed,
            etag=etag,
            inventories=inventories,
            installed_ids=installed_ids,
            had_outdated=had_outdated,
        )
        return {
            **envelope,
            "sync": {
                "status": "partial" if failed_updates else feed_status,
                "updated_assistants": len(successful_updates),
                "notifications_added": notifications_added,
                "failed_updates": failed_updates,
            },
        }


def mark_read(notification_id: object) -> dict[str, object]:
    if not isinstance(notification_id, str) or _NOTIFICATION_ID_RE.fullmatch(notification_id) is None:
        raise KeyError("notification not found")
    with _STORE_LOCK:
        state = _read_unlocked()
        found = False
        now = _utc_now()
        for record in state["notifications"]:
            if record["id"] == notification_id:
                found = True
                if record["read_at"] is None:
                    record["read_at"] = now
                break
        if not found:
            raise KeyError("notification not found")
        _write_unlocked(state)
        return _public_envelope(state)


def mark_all_read() -> dict[str, object]:
    with _STORE_LOCK:
        state = _read_unlocked()
        now = _utc_now()
        changed = False
        for record in state["notifications"]:
            if record["read_at"] is None:
                record["read_at"] = now
                changed = True
        if changed:
            _write_unlocked(state)
        return _public_envelope(state)


def clear() -> dict[str, object]:
    """Clear visible records while retaining release cursors to prevent resurrection."""
    with _STORE_LOCK:
        state = _read_unlocked()
        if state["notifications"]:
            state["notifications"] = []
            _write_unlocked(state)
        return _public_envelope(state)
