"""Durable Local Admin chat history and its bounded conversation projection."""

from __future__ import annotations

import base64
import contextlib
import datetime
import json
import os
import re
import secrets
import sqlite3
import stat
import struct
import threading
from collections.abc import Iterator, Mapping
from pathlib import Path

from history import context as conversation_context

from chat import store_catalog
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import routine as routine_contract
from protocol.http.v1 import websocket as chat_ws_common

STORE_PATH = Path(os.environ.get("SHIMPZ_CHAT_HISTORY_STORE") or "/data/chat-history.sqlite3")
SCHEMA_VERSION = 8
# A row's provenance is server-owned: `attached` marks every row of a turn whose message carried attachments, which
# never enters a conversation projection (ADR-0093); every other row is `plain`. An attached user row keeps the
# references of the files its message carried, exactly what the transcript shows of them and never their content.
PROVENANCES = frozenset({"plain", "attached"})
FILE_REFERENCE_KEYS = ("id", "name", "media_type", "size")
PAGE_ROWS = 64
MAX_PAGE_BYTES = 512 * 1024
MAX_ENTRY_BYTES = 256 * 1024
MAX_REPLY_CHARS = 60_000
MAX_GUIDANCE_REPLY_CHARS = 240
_MAX_POSITION = 2**63 - 1
_TURN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_INSTANT_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z")
_GUIDANCE_CODES = frozenset(
    {
        "assistant-install-target-required",
        "assistant-uninstall-target-required",
        "assistant-lifecycle-ambiguous",
        "assistant-lifecycle-attachments",
        "assistant-capability-attachments",
    }
)
_LOCK = threading.RLock()


class HistoryUnavailableError(RuntimeError):
    """The private presentation transcript cannot be read or committed safely."""


def new_turn_id() -> str:
    return secrets.token_hex(16)


def _team_id(value: object) -> str:
    canonical = team_contract.canonical_team_id(value)
    if canonical is None or canonical != value:
        raise ValueError("chat history Team id is invalid")
    return canonical


def _turn_id(value: object) -> str:
    if not isinstance(value, str) or _TURN_ID_RE.fullmatch(value) is None:
        raise ValueError("chat history turn id is invalid")
    return value


def _text(value: object, maximum: int, field: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or _CONTROL_RE.search(value) is not None
    ):
        raise ValueError(f"chat history {field} is invalid")
    return value


def _now() -> str:
    """The current UTC instant in whole seconds, written ``YYYY-MM-DDTHH:MM:SSZ`` like a Routine notice's."""
    return datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _instant(value: object) -> str:
    if not isinstance(value, str) or _INSTANT_RE.fullmatch(value) is None:
        raise HistoryUnavailableError("chat history entry time is invalid")
    try:
        datetime.datetime.fromisoformat(value)
    except ValueError:
        raise HistoryUnavailableError("chat history entry time is invalid") from None
    return value


def _private_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            raise HistoryUnavailableError("chat history store is not a regular file") from None
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            path.chmod(0o600)
    else:
        os.close(descriptor)


def _initialize(database: sqlite3.Connection) -> None:
    database.execute("PRAGMA trusted_schema = OFF")
    database.execute("PRAGMA secure_delete = ON")
    database.execute("PRAGMA journal_mode = DELETE")
    database.execute("PRAGMA synchronous = FULL")
    version = database.execute("PRAGMA user_version").fetchone()[0]
    if version == SCHEMA_VERSION:
        return
    if version != 0:
        raise HistoryUnavailableError("chat history schema version is unsupported")
    existing = database.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    if existing:
        raise HistoryUnavailableError("chat history schema is invalid")
    database.executescript(
        """
        CREATE TABLE transcript (
            position INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id TEXT NOT NULL,
            event_key TEXT NOT NULL,
            payload TEXT NOT NULL,
            provenance TEXT NOT NULL CHECK (provenance IN ('plain', 'attached')),
            created_at TEXT NOT NULL,
            UNIQUE (team_id, event_key)
        );
        CREATE INDEX transcript_team_position ON transcript (team_id, position);
        CREATE INDEX transcript_team_conversation ON transcript (team_id, position)
            WHERE provenance = 'plain' AND (substr(event_key, -5) = ':user' OR substr(event_key, -6) = ':reply'
            OR substr(event_key, -9) = ':guidance');
        CREATE TABLE resumable_turn (
            team_id TEXT PRIMARY KEY,
            turn_id TEXT NOT NULL UNIQUE
        );
        PRAGMA user_version = 8;
        """
    )


@contextlib.contextmanager
def _database() -> Iterator[sqlite3.Connection]:
    with _LOCK:
        database = None
        try:
            _private_file(STORE_PATH)
            database = sqlite3.connect(STORE_PATH, timeout=5)
            _initialize(database)
            yield database
            database.commit()
        except HistoryUnavailableError:
            if database is not None:
                database.rollback()
            raise
        except (OSError, sqlite3.Error) as exc:
            if database is not None:
                database.rollback()
            raise HistoryUnavailableError("chat history store is unavailable") from exc
        finally:
            if database is not None:
                database.close()


def _encoded(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode("utf-8")) > MAX_ENTRY_BYTES:
        raise ValueError("chat history entry is too large")
    return encoded


def _append(
    team_id: str,
    event_key: str,
    payload: Mapping[str, object],
    *,
    anchor_turn: str | None = None,
    finish_turn: str | None = None,
    provenance: str = "plain",
) -> bool:
    encoded = _encoded(payload)
    if provenance not in PROVENANCES:
        raise ValueError("chat history provenance is invalid")
    with _database() as database:
        # A turn's later event needs its user row in the same transaction: after Team deletion or Space reset cleared
        # the transcript, a delayed reply or outcome must not recreate that history.
        if anchor_turn is not None:
            anchor = database.execute(
                "SELECT provenance FROM transcript WHERE team_id = ? AND event_key = ?",
                (team_id, f"{anchor_turn}:user"),
            ).fetchone()
            if anchor is None:
                return False
            # Every row of a turn keeps the provenance its message was admitted with.
            provenance = anchor[0]
        # A row's time is when Admin first wrote it; an idempotent repeat keeps that first time.
        cursor = database.execute(
            "INSERT OR IGNORE INTO transcript (team_id, event_key, payload, provenance, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (team_id, event_key, encoded, provenance, _now()),
        )
        committed = cursor.rowcount == 1
        if not committed:
            existing = database.execute(
                "SELECT payload FROM transcript WHERE team_id = ? AND event_key = ?",
                (team_id, event_key),
            ).fetchone()
            committed = existing is not None and existing[0] == encoded
        if committed and finish_turn is not None:
            database.execute(
                "DELETE FROM resumable_turn WHERE team_id = ? AND turn_id = ?",
                (team_id, finish_turn),
            )
        return committed


# Serializes Routine notice delivery with Team deletion and Space reset, including their transcript cleanup, so a
# notice read before a Team is deleted is never written into the history after that Team's rows are removed.
LIFECYCLE_LOCK = threading.Lock()
_NOTICE_FIELDS = ("notice_id", "routine_id", "quote", "run_id", "outcome", "created_at", "detail", "version")


def append_routine_notice(notice: object) -> bool:
    """Write one Routine notice to its Team's transcript (ADR-0086); it never enters the Brain window.

    A run keeps one row, keyed by its notice id. A newer version replaces the row and moves it to the end, so an
    outcome that arrives long after the run froze is where the Supervisor looks; an older or equal version is already
    delivered and changes nothing.
    """
    admitted = routine_contract.canonical_notice(notice)
    if admitted is None:
        raise ValueError("Routine notice is invalid")
    team_id = _team_id(admitted["team_id"])
    event_key = f"{admitted['notice_id']}:routine"
    payload = {"kind": "routine-run", **{name: admitted[name] for name in _NOTICE_FIELDS}}
    encoded = _encoded(payload)
    with _database() as database:
        existing = database.execute(
            "SELECT payload FROM transcript WHERE team_id = ? AND event_key = ?", (team_id, event_key)
        ).fetchone()
        if existing is not None:
            stored = _decoded(existing[0])
            if stored["version"] > payload["version"]:
                return True
            if stored["version"] == payload["version"]:
                return existing[0] == encoded
            database.execute("DELETE FROM transcript WHERE team_id = ? AND event_key = ?", (team_id, event_key))
        # A notice's row time is the notice's own instant, so its day and the time it shows agree.
        database.execute(
            "INSERT INTO transcript (team_id, event_key, payload, provenance, created_at) VALUES (?, ?, ?, 'plain', ?)",
            (team_id, event_key, encoded, admitted["created_at"]),
        )
    return True


def _file_reference(value: object) -> dict[str, object]:
    """One file a user message carried, as the transcript shows it: its id, literal name, media type, and size."""
    if not isinstance(value, dict) or set(value) != set(FILE_REFERENCE_KEYS):
        raise ValueError("chat history file reference is invalid")
    size = value["size"]
    if (
        team_contract.canonical_file_id(value["id"]) is None
        or team_contract.canonical_filename(value["name"]) != value["name"]
        or not isinstance(value["media_type"], str)
        or team_contract.canonical_media_type(value["media_type"]) != value["media_type"]
        or isinstance(size, bool)
        or not isinstance(size, int)
        or not 1 <= size <= team_contract.MAX_FILE_UPLOAD_BYTES
    ):
        raise ValueError("chat history file reference is invalid")
    return {key: value[key] for key in FILE_REFERENCE_KEYS}


def _file_references(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list) or not 1 <= len(value) <= team_contract.MAX_CHAT_FILES:
        raise ValueError("chat history file references are invalid")
    references = [_file_reference(item) for item in value]
    if len({item["id"] for item in references}) != len(references):
        raise ValueError("chat history file references are invalid")
    return references


def append_user(team_id: object, turn_id: object, message: object, *, files: object = ()) -> bool:
    """Admit one user message with the files it carried; files mark its whole turn ``attached`` (ADR-0093)."""
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    text = _text(message, team_contract.MAX_CHAT_MESSAGE_CHARS, "user message")
    if not isinstance(files, list | tuple):
        raise ValueError("chat history file references are invalid")
    payload: dict[str, object] = {"kind": "message", "role": "user", "text": text}
    if files:
        payload["files"] = _file_references(list(files))
    return _append(
        canonical_team,
        f"{canonical_turn}:user",
        payload,
        provenance="attached" if "files" in payload else "plain",
    )


def append_reply(team_id: object, turn_id: object, event: object) -> bool:
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    fields = {"type", "team_id", "team_name", "reply", "clarification"}
    if not isinstance(event, Mapping) or set(event) - {"usage", "restricted_actions"} != fields:
        raise ValueError("chat history reply event is invalid")
    if event["type"] != "done" or event["team_id"] != canonical_team:
        raise ValueError("chat history reply event is invalid")
    author = chat_ws_common.public_text(event["team_name"], team_contract.MAX_TEAM_NAME_CHARS, field="Team name")
    reply = _text(event["reply"], MAX_REPLY_CHARS, "assistant reply")
    entry: dict[str, object] = {"kind": "message", "role": "assistant", "text": reply, "author": author}
    if event["clarification"] is not None:
        clarification = team_contract.canonical_clarification(event["clarification"])
        if clarification is None or reply != team_contract.render_clarification(clarification):
            raise ValueError("chat history reply event is invalid")
        # Stored with its reply so a reload restores the same question card for the same turn.
        entry["clarification"] = clarification
    if "usage" in event:
        usage = team_contract.canonical_turn_usage(event["usage"])
        if usage is None:
            raise ValueError("chat history reply event is invalid")
        # Stored so a reload shows what the turn consumed under its reply; it never enters the Brain window.
        entry["usage"] = usage
    if "restricted_actions" in event:
        restricted = team_contract.canonical_restricted_actions(event["restricted_actions"])
        if restricted is None:
            raise ValueError("chat history reply event is invalid")
        # Stored so a reload shows the same guidance for the Actions the attachments withheld (ADR-0093).
        entry["restricted_actions"] = restricted
    return _append(
        canonical_team, f"{canonical_turn}:reply", entry, anchor_turn=canonical_turn, finish_turn=canonical_turn
    )


def _install_assistant(value: object) -> dict[str, object]:
    expected = {"id", "name", "summary", "providers", "provenance", "status"}
    if not isinstance(value, Mapping) or set(value) != expected:
        raise ValueError("chat history Assistant install item is invalid")
    assistant_id = team_contract.canonical_assistant_id(value["id"])
    providers = value["providers"]
    if (
        assistant_id is None
        or assistant_id != value["id"]
        or not isinstance(providers, list)
        or len(providers) > 32
        or value["provenance"] not in {"local", "published"}
        or value["status"] not in {"pending", "installed", "failed"}
    ):
        raise ValueError("chat history Assistant install item is invalid")
    canonical_providers = [team_contract.canonical_assistant_id(provider) for provider in providers]
    if any(provider is None for provider in canonical_providers) or canonical_providers != sorted(
        set(canonical_providers)
    ):
        raise ValueError("chat history Assistant install providers are invalid")
    return {
        "id": assistant_id,
        "name": chat_ws_common.public_text(value["name"], 80, field="Assistant name"),
        "summary": chat_ws_common.public_text(value["summary"], 160, field="Assistant summary"),
        "providers": canonical_providers,
        "provenance": value["provenance"],
        "status": value["status"],
    }


def _install_payload(event: object, team_id: str) -> dict[str, object]:
    if not isinstance(event, Mapping) or event.get("type") != "assistant-install-plan":
        raise ValueError("chat history Assistant install event is invalid")
    state = event.get("state")
    expected = {"type", "state", "plan_id", "team_id", "assistants"}
    if state == "installed":
        expected.add("continuation")
        if "outcome" in event:
            expected.add("outcome")
    elif state == "failed":
        expected.add("status")
    elif state != "stopped":
        raise ValueError("chat history Assistant install event is not terminal")
    if (
        set(event) != expected
        or event.get("team_id") != team_id
        or _TURN_ID_RE.fullmatch(str(event.get("plan_id"))) is None
    ):
        raise ValueError("chat history Assistant install event is invalid")
    assistants = event.get("assistants")
    if not isinstance(assistants, list) or not 1 <= len(assistants) <= 4:
        raise ValueError("chat history Assistant install event is invalid")
    canonical = [_install_assistant(item) for item in assistants]
    identifiers = [item["id"] for item in canonical]
    if identifiers != sorted(set(identifiers)):
        raise ValueError("chat history Assistant install items are invalid")
    if state == "installed" and (
        event.get("continuation") not in {"dispatch", "none"}
        or any(item["status"] != "installed" for item in canonical)
        or ("outcome" in event and event.get("outcome") != "already-installed")
    ):
        raise ValueError("chat history installed result is invalid")
    if state == "failed" and (
        not isinstance(event.get("status"), int)
        or isinstance(event.get("status"), bool)
        or not 400 <= event["status"] <= 599
    ):
        raise ValueError("chat history failed result is invalid")
    return {
        "kind": "assistant-install",
        "state": state,
        "assistants": canonical,
        **({"status": event["status"]} if state == "failed" else {}),
        **({"outcome": event["outcome"]} if "outcome" in event else {}),
    }


def append_install(team_id: object, turn_id: object, event: object) -> bool:
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    payload = _install_payload(event, canonical_team)
    finished = payload["state"] != "installed" or event.get("continuation") == "none"
    return _append(
        canonical_team,
        f"{canonical_turn}:install",
        payload,
        anchor_turn=canonical_turn,
        finish_turn=canonical_turn if finished else None,
    )


def append_guidance(team_id: object, turn_id: object, code: object, reply: object) -> bool:
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    if code not in _GUIDANCE_CODES:
        raise ValueError("chat history guidance is invalid")
    text = _text(reply, MAX_GUIDANCE_REPLY_CHARS, "guidance reply")
    return _append(
        canonical_team,
        f"{canonical_turn}:guidance",
        {"kind": "guidance", "code": code, "reply": text},
        anchor_turn=canonical_turn,
        finish_turn=canonical_turn,
    )


def _uninstall_assistant(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping) or set(value) != {"id", "name", "version"}:
        raise ValueError("chat history uninstall Assistant is invalid")
    assistant_id = team_contract.canonical_assistant_id(value["id"])
    version = value["version"]
    if assistant_id is None or assistant_id != value["id"] or not isinstance(version, str):
        raise ValueError("chat history uninstall Assistant is invalid")
    if store_catalog.VERSION_RE.fullmatch(version) is None:
        raise ValueError("chat history uninstall Assistant is invalid")
    return {
        "id": assistant_id,
        "name": chat_ws_common.public_text(value["name"], 80, field="Assistant name"),
        "version": version,
    }


def _uninstall_payload(event: object, team_id: str, assistant: object) -> dict[str, object]:
    if not isinstance(event, Mapping) or event.get("type") != "assistant-uninstall":
        raise ValueError("chat history uninstall event is invalid")
    state = event.get("state")
    expected = {"type", "state", "proposal_id", "assistant_id"}
    if state == "uninstalled":
        expected.update({"team_id", "uninstalled"})
    elif state == "failed":
        expected.add("status")
    elif state not in {"cancelled", "expired"}:
        raise ValueError("chat history uninstall event is not terminal")
    canonical_assistant = _uninstall_assistant(assistant)
    if (
        set(event) != expected
        or _TURN_ID_RE.fullmatch(str(event.get("proposal_id"))) is None
        or event.get("assistant_id") != canonical_assistant["id"]
    ):
        raise ValueError("chat history uninstall event is invalid")
    payload: dict[str, object] = {
        "kind": "assistant-uninstall",
        "state": state,
        "assistant": canonical_assistant,
    }
    if state == "uninstalled":
        if event.get("team_id") != team_id or not isinstance(event.get("uninstalled"), bool):
            raise ValueError("chat history uninstall result is invalid")
        payload["uninstalled"] = event["uninstalled"]
    elif state == "failed":
        status = event.get("status")
        if isinstance(status, bool) or not isinstance(status, int) or not 400 <= status <= 599:
            raise ValueError("chat history uninstall failure is invalid")
        payload["status"] = status
    return payload


def append_uninstall(
    team_id: object,
    turn_id: object,
    assistant: object,
    event: object,
) -> bool:
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    return _append(
        canonical_team,
        f"{canonical_turn}:uninstall",
        _uninstall_payload(event, canonical_team, assistant),
        anchor_turn=canonical_turn,
        finish_turn=canonical_turn,
    )


def _cursor(position: int) -> str:
    return base64.urlsafe_b64encode(struct.pack(">Q", position)).rstrip(b"=").decode("ascii")


def _position(value: object) -> int | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > 16:
        raise ValueError("chat history cursor is invalid")
    try:
        encoded = value.encode("ascii")
        raw = base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4))
        position = struct.unpack(">Q", raw)[0]
    except UnicodeError, ValueError, struct.error:
        raise ValueError("chat history cursor is invalid") from None
    # A transcript position is a signed 64-bit SQLite rowid; a larger unsigned value is malformed, not unavailable.
    if _cursor(position) != value or not 1 <= position <= _MAX_POSITION:
        raise ValueError("chat history cursor is invalid")
    return position


def _decoded(raw: object) -> dict[str, object]:
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_ENTRY_BYTES:
        raise HistoryUnavailableError("chat history entry is invalid")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError, UnicodeError, RecursionError:
        raise HistoryUnavailableError("chat history entry is invalid") from None
    if not isinstance(payload, dict) or payload.get("kind") not in {
        "message",
        "assistant-install",
        "assistant-uninstall",
        "guidance",
        "routine-run",
    }:
        raise HistoryUnavailableError("chat history entry is invalid")
    try:
        _validate_stored_payload(payload)
    except ValueError:
        raise HistoryUnavailableError("chat history entry is invalid") from None
    return payload


def _validate_stored_message(payload: dict[str, object]) -> None:
    role = payload.get("role")
    expected = {"kind", "role", "text"} | ({"author"} if role == "assistant" else set())
    if role == "assistant" and "clarification" in payload:
        expected.add("clarification")
        clarification = team_contract.canonical_clarification(payload["clarification"])
        # A stored reply carries a clarification only when there is one; null or any other shape is invalid.
        if (
            clarification is None
            or clarification != payload["clarification"]
            or payload.get("text") != team_contract.render_clarification(clarification)
        ):
            raise ValueError("invalid stored message")
    if role == "assistant" and "restricted_actions" in payload:
        expected.add("restricted_actions")
        restricted = team_contract.canonical_restricted_actions(payload["restricted_actions"])
        if restricted is None or restricted != payload["restricted_actions"]:
            raise ValueError("invalid stored message")
    if role == "assistant" and "usage" in payload:
        expected.add("usage")
        usage = team_contract.canonical_turn_usage(payload["usage"])
        if usage is None or usage != payload["usage"]:
            raise ValueError("invalid stored message")
    if role == "user" and "files" in payload:
        expected.add("files")
        _file_references(payload["files"])
    if set(payload) != expected or role not in {"user", "assistant"}:
        raise ValueError("invalid stored message")
    _text(
        payload.get("text"),
        team_contract.MAX_CHAT_MESSAGE_CHARS if role == "user" else MAX_REPLY_CHARS,
        "stored message",
    )
    if role == "assistant":
        chat_ws_common.public_text(payload.get("author"), team_contract.MAX_TEAM_NAME_CHARS)


def _validate_stored_guidance(payload: dict[str, object]) -> None:
    if set(payload) != {"kind", "code", "reply"} or payload.get("code") not in _GUIDANCE_CODES:
        raise ValueError("invalid stored guidance")
    _text(payload.get("reply"), MAX_GUIDANCE_REPLY_CHARS, "stored guidance reply")


def _validate_stored_install(payload: dict[str, object]) -> None:
    state = payload.get("state")
    expected = {"kind", "state", "assistants"} | ({"status"} if state == "failed" else set())
    if "outcome" in payload:
        expected.add("outcome")
    assistants = payload.get("assistants")
    if set(payload) != expected or state not in {"installed", "failed", "stopped"}:
        raise ValueError("invalid stored install")
    if not isinstance(assistants, list) or not 1 <= len(assistants) <= 4:
        raise ValueError("invalid stored install")
    canonical = [_install_assistant(item) for item in assistants]
    identifiers = [item["id"] for item in canonical]
    if identifiers != sorted(set(identifiers)):
        raise ValueError("invalid stored install")
    if state == "installed" and any(item["status"] != "installed" for item in canonical):
        raise ValueError("invalid stored install")
    if "outcome" in payload and (state != "installed" or payload.get("outcome") != "already-installed"):
        raise ValueError("invalid stored install")
    if state == "failed":
        status = payload.get("status")
        if isinstance(status, bool) or not isinstance(status, int) or not 400 <= status <= 599:
            raise ValueError("invalid stored install")


def _validate_stored_uninstall(payload: dict[str, object]) -> None:
    state = payload.get("state")
    expected = {"kind", "state", "assistant"}
    if state == "uninstalled":
        expected.add("uninstalled")
    elif state == "failed":
        expected.add("status")
    elif state not in {"cancelled", "expired"}:
        raise ValueError("invalid stored uninstall")
    if set(payload) != expected:
        raise ValueError("invalid stored uninstall")
    _uninstall_assistant(payload.get("assistant"))
    if state == "uninstalled" and not isinstance(payload.get("uninstalled"), bool):
        raise ValueError("invalid stored uninstall")
    if state == "failed":
        status = payload.get("status")
        if isinstance(status, bool) or not isinstance(status, int) or not 400 <= status <= 599:
            raise ValueError("invalid stored uninstall")


def _validate_stored_routine(payload: dict[str, object]) -> None:
    if set(payload) != {"kind", *_NOTICE_FIELDS}:
        raise ValueError("invalid stored Routine notice")
    fields = {name: payload[name] for name in _NOTICE_FIELDS}
    # The Team is the row's own; any valid id stands in for it while the notice's closed shape is checked.
    if routine_contract.canonical_notice({**fields, "team_id": "stored"}) != {**fields, "team_id": "stored"}:
        raise ValueError("invalid stored Routine notice")


def _validate_stored_payload(payload: dict[str, object]) -> None:
    validators = {
        "routine-run": _validate_stored_routine,
        "message": _validate_stored_message,
        "assistant-install": _validate_stored_install,
        "assistant-uninstall": _validate_stored_uninstall,
        "guidance": _validate_stored_guidance,
    }
    validators[payload["kind"]](payload)


def _page_rows(database: sqlite3.Connection, team_id: str, position: int | None) -> sqlite3.Cursor:
    if position is None:
        return database.execute(
            "SELECT position, event_key, payload, provenance, created_at FROM transcript WHERE team_id = ? "
            "ORDER BY position DESC LIMIT ?",
            (team_id, PAGE_ROWS + 1),
        )
    return database.execute(
        "SELECT position, event_key, payload, provenance, created_at FROM transcript WHERE team_id = ? "
        "AND position < ? ORDER BY position DESC LIMIT ?",
        (team_id, position, PAGE_ROWS + 1),
    )


def _page_entry(event_key: str, raw: object, provenance: object, created_at: object) -> dict[str, object]:
    payload = _decoded(raw)
    instant = _instant(created_at)
    # A user row carries file references exactly when its turn is attached.
    if payload.get("role") == "user" and ("files" in payload) != (provenance == "attached"):
        raise HistoryUnavailableError("chat history entry provenance is invalid")
    # A Routine notice keeps its own instant in its closed shape; its row time must be that same instant.
    if payload["kind"] == "routine-run" and payload["created_at"] != instant:
        raise HistoryUnavailableError("chat history entry time is invalid")
    return {"id": event_key, **payload, "created_at": instant}


def page(team_id: object, *, before: object = None) -> dict[str, object]:
    """Return one newest-first page, fetching rows one at a time so the byte cap bounds the memory it holds.

    Iteration stops at the first row that would exceed the row or byte bound; that one-row lookahead is what
    proves an older entry exists and keeps the older-history cursor.
    """
    canonical_team = _team_id(team_id)
    position = _position(before)
    selected: list[tuple[int, dict[str, object]]] = []
    size = 0
    has_older = False
    with _database() as database, contextlib.closing(_page_rows(database, canonical_team, position)) as rows:
        for row_position, event_key, raw, provenance, created_at in rows:
            if len(selected) == PAGE_ROWS:
                has_older = True
                break
            entry = _page_entry(event_key, raw, provenance, created_at)
            entry_size = len(raw.encode("utf-8")) + len(event_key) + len(created_at)
            if selected and size + entry_size > MAX_PAGE_BYTES:
                has_older = True
                break
            selected.append((row_position, entry))
            size += entry_size
    if not selected:
        return {"entries": [], "before": None}
    oldest = selected[-1][0]
    entries = [entry for _, entry in reversed(selected)]
    return {"entries": entries, "before": _cursor(oldest) if has_older else None}


def _conversation_entry(event_key: object, payload: dict[str, object]) -> conversation_context.Entry | None:
    if not isinstance(event_key, str):
        raise HistoryUnavailableError("chat history conversation entry is invalid")
    turn_id, separator, suffix = event_key.rpartition(":")
    try:
        _turn_id(turn_id)
    except ValueError:
        raise HistoryUnavailableError("chat history conversation entry is invalid") from None
    if not separator:
        raise HistoryUnavailableError("chat history conversation entry is invalid")
    # Every projected row is plain, and a plain user row never carries file references.
    if (
        suffix == "user"
        and payload.get("kind") == "message"
        and payload.get("role") == "user"
        and "files" not in payload
    ):
        role, text = "user", payload.get("text")
    elif suffix == "reply" and payload.get("kind") == "message" and payload.get("role") == "assistant":
        role, text = "assistant", payload.get("text")
    elif suffix == "guidance" and payload.get("kind") == "guidance":
        role, text = "assistant", payload.get("reply")
    else:
        raise HistoryUnavailableError("chat history conversation entry is invalid")
    try:
        return conversation_context.bounded(role, text)
    except ValueError:
        return None


# The eligibility predicate repeats the partial index `transcript_team_conversation` exactly, so the projection
# skips every Routine notice, every row of a turn whose message carried attachments (ADR-0093), and every other row
# between the anchor and the latest eligible entries. Lifecycle routing and the empty-checkpoint bridge both read it.
CONVERSATION_QUERY = (
    "SELECT event_key, payload FROM transcript "
    "WHERE team_id = ? AND position < ? AND provenance = 'plain' AND "
    "(substr(event_key, -5) = ':user' OR substr(event_key, -6) = ':reply' "
    "OR substr(event_key, -9) = ':guidance') "
    "ORDER BY position DESC LIMIT ?"
)


def conversation(team_id: object, before_turn_id: object) -> tuple[conversation_context.Entry, ...]:
    """Return the latest eligible same-Team entries before one exact admitted user turn."""
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(before_turn_id)
    with _database() as database:
        anchor = database.execute(
            "SELECT position, payload FROM transcript WHERE team_id = ? AND event_key = ?",
            (canonical_team, f"{canonical_turn}:user"),
        ).fetchone()
        if anchor is None:
            raise HistoryUnavailableError("chat history conversation anchor is unavailable")
        anchor_payload = _decoded(anchor[1])
        if anchor_payload.get("kind") != "message" or anchor_payload.get("role") != "user":
            raise HistoryUnavailableError("chat history conversation anchor is invalid")
        rows = database.execute(
            CONVERSATION_QUERY, (canonical_team, anchor[0], conversation_context.MAX_ENTRIES)
        ).fetchall()
    projected = (_conversation_entry(event_key, _decoded(raw)) for event_key, raw in reversed(rows))
    return tuple(entry for entry in projected if entry is not None)


def _absent() -> bool:
    try:
        STORE_PATH.lstat()
    except FileNotFoundError:
        return True
    except OSError as exc:
        raise HistoryUnavailableError("chat history store is unavailable") from exc
    return False


def bind_resumable_turn(team_id: object, turn_id: object) -> bool:
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    with _database() as database:
        admitted = database.execute(
            "SELECT 1 FROM transcript WHERE team_id = ? AND event_key = ?",
            (canonical_team, f"{canonical_turn}:user"),
        ).fetchone()
        if admitted is None:
            return False
        database.execute(
            "INSERT OR IGNORE INTO resumable_turn (team_id, turn_id) VALUES (?, ?)",
            (canonical_team, canonical_turn),
        )
        row = database.execute(
            "SELECT turn_id FROM resumable_turn WHERE team_id = ?",
            (canonical_team,),
        ).fetchone()
    return row is not None and row[0] == canonical_turn


def resumable_turn(team_id: object) -> str | None:
    canonical_team = _team_id(team_id)
    if _absent():
        return None
    with _database() as database:
        row = database.execute(
            "SELECT turn_id FROM resumable_turn WHERE team_id = ?",
            (canonical_team,),
        ).fetchone()
    if row is None:
        return None
    try:
        return _turn_id(row[0])
    except ValueError:
        raise HistoryUnavailableError("chat history resumable turn is invalid") from None


def finish_resumable_turn(turn_id: object) -> None:
    canonical_turn = _turn_id(turn_id)
    if _absent():
        return
    with _database() as database:
        database.execute("DELETE FROM resumable_turn WHERE turn_id = ?", (canonical_turn,))


def clear_team(team_id: object) -> int:
    canonical_team = _team_id(team_id)
    if _absent():
        return 0
    with _database() as database:
        cursor = database.execute("DELETE FROM transcript WHERE team_id = ?", (canonical_team,))
        database.execute("DELETE FROM resumable_turn WHERE team_id = ?", (canonical_team,))
        return cursor.rowcount


def clear_all() -> int:
    if _absent():
        return 0
    with _database() as database:
        cursor = database.execute("DELETE FROM transcript")
        database.execute("DELETE FROM resumable_turn")
        return cursor.rowcount
