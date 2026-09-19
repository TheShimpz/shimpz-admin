"""Durable, presentation-only Local Admin chat history storage."""

from __future__ import annotations

import base64
import contextlib
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

from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as chat_ws_common

STORE_PATH = Path(os.environ.get("SHIMPZ_CHAT_HISTORY_STORE") or "/data/chat-history.sqlite3")
SCHEMA_VERSION = 2
PAGE_ROWS = 64
MAX_PAGE_BYTES = 512 * 1024
MAX_ENTRY_BYTES = 256 * 1024
MAX_REPLY_CHARS = 60_000
_TURN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SEMANTIC_VERSION_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
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
            UNIQUE (team_id, event_key)
        );
        CREATE INDEX transcript_team_position ON transcript (team_id, position);
        CREATE TABLE active_turn (
            team_id TEXT PRIMARY KEY,
            turn_id TEXT NOT NULL
        );
        PRAGMA user_version = 2;
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
    active_turn: str | None = None,
    finish_turn: str | None = None,
) -> bool:
    with _database() as database:
        cursor = database.execute(
            "INSERT OR IGNORE INTO transcript (team_id, event_key, payload) VALUES (?, ?, ?)",
            (team_id, event_key, _encoded(payload)),
        )
        if cursor.rowcount == 1 and active_turn is not None:
            database.execute(
                "INSERT INTO active_turn (team_id, turn_id) VALUES (?, ?) "
                "ON CONFLICT(team_id) DO UPDATE SET turn_id = excluded.turn_id",
                (team_id, active_turn),
            )
        if finish_turn is not None:
            database.execute(
                "DELETE FROM active_turn WHERE team_id = ? AND turn_id = ?",
                (team_id, finish_turn),
            )
        return cursor.rowcount == 1


def append_user(team_id: object, turn_id: object, message: object) -> bool:
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    text = _text(message, team_contract.MAX_CHAT_MESSAGE_CHARS, "user message")
    return _append(
        canonical_team,
        f"{canonical_turn}:user",
        {"kind": "message", "role": "user", "text": text},
        active_turn=canonical_turn,
    )


def append_reply(team_id: object, turn_id: object, event: object) -> bool:
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    if not isinstance(event, Mapping) or set(event) != {"type", "team_id", "team_name", "reply"}:
        raise ValueError("chat history reply event is invalid")
    if event["type"] != "done" or event["team_id"] != canonical_team:
        raise ValueError("chat history reply event is invalid")
    author = chat_ws_common.public_text(event["team_name"], team_contract.MAX_TEAM_NAME_CHARS, field="Team name")
    reply = _text(event["reply"], MAX_REPLY_CHARS, "assistant reply")
    return _append(
        canonical_team,
        f"{canonical_turn}:reply",
        {"kind": "message", "role": "assistant", "text": reply, "author": author},
        finish_turn=canonical_turn,
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
    if (
        any(provider is None for provider in canonical_providers)
        or canonical_providers != sorted(set(canonical_providers))
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
        finish_turn=canonical_turn if finished else None,
    )


def append_guidance(team_id: object, turn_id: object, code: object) -> bool:
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    if code != "uninstall-target-required":
        raise ValueError("chat history guidance is invalid")
    return _append(
        canonical_team,
        f"{canonical_turn}:guidance",
        {"kind": "guidance", "code": code},
        finish_turn=canonical_turn,
    )


def _uninstall_assistant(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping) or set(value) != {"id", "name", "summary", "version"}:
        raise ValueError("chat history uninstall Assistant is invalid")
    assistant_id = team_contract.canonical_assistant_id(value["id"])
    version = value["version"]
    if assistant_id is None or assistant_id != value["id"] or not isinstance(version, str):
        raise ValueError("chat history uninstall Assistant is invalid")
    if _SEMANTIC_VERSION_RE.fullmatch(version) is None:
        raise ValueError("chat history uninstall Assistant is invalid")
    return {
        "id": assistant_id,
        "name": chat_ws_common.public_text(value["name"], 80, field="Assistant name"),
        "summary": chat_ws_common.public_text(value["summary"], 160, field="Assistant summary"),
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
    except (UnicodeError, ValueError, struct.error):
        raise ValueError("chat history cursor is invalid") from None
    if _cursor(position) != value or position < 1:
        raise ValueError("chat history cursor is invalid")
    return position


def _decoded(raw: object) -> dict[str, object]:
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_ENTRY_BYTES:
        raise HistoryUnavailableError("chat history entry is invalid")
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        raise HistoryUnavailableError("chat history entry is invalid") from None
    if not isinstance(payload, dict) or payload.get("kind") not in {
        "message",
        "assistant-install",
        "assistant-uninstall",
        "guidance",
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
    if set(payload) != {"kind", "code"} or payload.get("code") != "uninstall-target-required":
        raise ValueError("invalid stored guidance")


def _validate_stored_install(payload: dict[str, object]) -> None:
    state = payload.get("state")
    expected = {"kind", "state", "assistants"} | ({"status"} if state == "failed" else set())
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


def _validate_stored_payload(payload: dict[str, object]) -> None:
    validators = {
        "message": _validate_stored_message,
        "assistant-install": _validate_stored_install,
        "assistant-uninstall": _validate_stored_uninstall,
        "guidance": _validate_stored_guidance,
    }
    validators[payload["kind"]](payload)


def page(team_id: object, *, before: object = None) -> dict[str, object]:
    canonical_team = _team_id(team_id)
    position = _position(before)
    with _database() as database:
        if position is None:
            rows = database.execute(
                "SELECT position, event_key, payload FROM transcript WHERE team_id = ? "
                "ORDER BY position DESC LIMIT ?",
                (canonical_team, PAGE_ROWS + 1),
            ).fetchall()
        else:
            rows = database.execute(
                "SELECT position, event_key, payload FROM transcript WHERE team_id = ? AND position < ? "
                "ORDER BY position DESC LIMIT ?",
                (canonical_team, position, PAGE_ROWS + 1),
            ).fetchall()
    selected: list[tuple[int, str, dict[str, object]]] = []
    size = 0
    for row_position, event_key, raw in rows[:PAGE_ROWS]:
        payload = _decoded(raw)
        entry_size = len(raw.encode("utf-8")) + len(event_key)
        if selected and size + entry_size > MAX_PAGE_BYTES:
            break
        selected.append((row_position, event_key, payload))
        size += entry_size
    if not selected:
        return {"entries": [], "before": None}
    oldest = selected[-1][0]
    has_older = len(selected) < len(rows)
    entries = [{"id": event_key, **payload} for _, event_key, payload in reversed(selected)]
    return {"entries": entries, "before": _cursor(oldest) if has_older else None}


def _absent() -> bool:
    try:
        STORE_PATH.lstat()
    except FileNotFoundError:
        return True
    except OSError as exc:
        raise HistoryUnavailableError("chat history store is unavailable") from exc
    return False


def active_turn(team_id: object) -> str | None:
    canonical_team = _team_id(team_id)
    if _absent():
        return None
    with _database() as database:
        row = database.execute(
            "SELECT turn_id FROM active_turn WHERE team_id = ?",
            (canonical_team,),
        ).fetchone()
    if row is None:
        return None
    try:
        return _turn_id(row[0])
    except ValueError:
        raise HistoryUnavailableError("chat history active turn is invalid") from None


def finish_turn(team_id: object, turn_id: object) -> bool:
    canonical_team = _team_id(team_id)
    canonical_turn = _turn_id(turn_id)
    if _absent():
        return False
    with _database() as database:
        cursor = database.execute(
            "DELETE FROM active_turn WHERE team_id = ? AND turn_id = ?",
            (canonical_team, canonical_turn),
        )
        return cursor.rowcount == 1


def clear_team(team_id: object) -> int:
    canonical_team = _team_id(team_id)
    if _absent():
        return 0
    with _database() as database:
        cursor = database.execute("DELETE FROM transcript WHERE team_id = ?", (canonical_team,))
        database.execute("DELETE FROM active_turn WHERE team_id = ?", (canonical_team,))
        return cursor.rowcount


def clear_all() -> int:
    if _absent():
        return 0
    with _database() as database:
        cursor = database.execute("DELETE FROM transcript")
        database.execute("DELETE FROM active_turn")
        return cursor.rowcount
