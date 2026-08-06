"""Fail-closed canonicalizers for Admin chat request payloads."""

from __future__ import annotations

import re

from team.transport import TeamRequestError

from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import supervisor as supervisor_contract
from protocol.http.v1 import websocket as chat_ws_common

_FILE_ID_RE = team_contract.FILE_ID_RE
MAX_CHAT_MESSAGE_CHARS = team_contract.MAX_CHAT_MESSAGE_CHARS
MAX_CHAT_FILES = team_contract.MAX_CHAT_FILES
MAX_CHAT_ASSISTANTS = team_contract.MAX_CHAT_ASSISTANTS
MAX_HUMAN_TEXT_CHARS = 16_000
MAX_HUMAN_CHOICES = 32
MAX_HUMAN_CHOICE_CHARS = 128


def canonical_assistant_id(value: object) -> str:
    canonical = team_contract.canonical_assistant_id(value)
    if canonical is None:
        raise TeamRequestError("assistant id must be a canonical lowercase identifier")
    return canonical


def canonical_challenge_id(value: object) -> str:
    if not isinstance(value, str) or chat_ws_common.CHALLENGE_ID_RE.fullmatch(value) is None:
        raise TeamRequestError("OAuth challenge is invalid")
    return value


def canonical_chat_payload(payload: object) -> dict[str, object]:
    """Validate one explicit Assistant scope without treating an empty scope as all."""
    if not isinstance(payload, dict) or set(payload) != {"message", "files", "assistant_ids"}:
        raise TeamRequestError("chat requires message, files, and assistant_ids")
    message = payload["message"]
    if not isinstance(message, str) or not (message := message.strip()):
        raise TeamRequestError("message must be non-empty")
    if len(message) > MAX_CHAT_MESSAGE_CHARS:
        raise TeamRequestError(f"message exceeds {MAX_CHAT_MESSAGE_CHARS} characters")
    files = payload["files"]
    if not isinstance(files, list) or len(files) > MAX_CHAT_FILES:
        raise TeamRequestError(f"files must contain at most {MAX_CHAT_FILES} ids")
    canonical_files = [_canonical_id(item, field="file id", pattern=_FILE_ID_RE, maximum=32) for item in files]
    if len(set(canonical_files)) != len(canonical_files):
        raise TeamRequestError("files must not contain duplicate ids")
    assistant_ids = payload["assistant_ids"]
    if not isinstance(assistant_ids, list) or len(assistant_ids) > MAX_CHAT_ASSISTANTS:
        raise TeamRequestError(f"assistant_ids must contain at most {MAX_CHAT_ASSISTANTS} ids")
    canonical_assistant_ids = [canonical_assistant_id(item) for item in assistant_ids]
    if len(set(canonical_assistant_ids)) != len(canonical_assistant_ids):
        raise TeamRequestError("assistant_ids must not contain duplicate ids")
    return {
        "message": message,
        "files": canonical_files,
        "assistant_ids": canonical_assistant_ids,
    }


def _canonical_id(value: object, *, field: str, pattern: re.Pattern[str], maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or not pattern.fullmatch(value):
        raise TeamRequestError(f"{field} must be a canonical lowercase identifier")
    return value


def canonical_integration_resume(payload: object) -> dict[str, str]:
    """Bind continuation to the one exact controller-owned integration challenge."""
    if not isinstance(payload, dict) or set(payload) != {"challenge_id"}:
        raise TeamRequestError("integration continuation requires only challenge_id")
    return {"challenge_id": canonical_challenge_id(payload["challenge_id"])}


def canonical_human_resume(payload: object) -> dict[str, object]:
    """Admit one bounded human response without interpreting the pending Team request."""
    if not isinstance(payload, dict) or payload.get("decision") not in {"submit", "deny"}:
        raise TeamRequestError("human continuation requires a submit or deny decision")
    decision = payload["decision"]
    expected = (
        {"challenge_id", "decision", "value"}
        if decision == "submit"
        else {
            "challenge_id",
            "decision",
        }
    )
    if set(payload) != expected:
        raise TeamRequestError("human continuation fields are invalid")
    result: dict[str, object] = {
        "challenge_id": canonical_challenge_id(payload["challenge_id"]),
        "decision": decision,
    }
    if decision == "submit":
        value = payload["value"]
        if not _human_value(value):
            raise TeamRequestError("human continuation value is invalid")
        result["value"] = value
    return result


def canonical_human_assurance(value: object) -> dict[str, str]:
    """Bind successful Admin authentication to one exact Team challenge."""
    if not isinstance(value, dict) or set(value) != {"kind", "challenge_id"}:
        raise TeamRequestError("human assurance is invalid")
    kind = value["kind"]
    if not isinstance(kind, str) or kind not in supervisor_contract.ASSURANCE_KINDS:
        raise TeamRequestError("human assurance kind is invalid")
    return {
        "kind": kind,
        "challenge_id": canonical_challenge_id(value["challenge_id"]),
    }


def _human_value(value: object) -> bool:
    if value is True:
        return True
    if isinstance(value, str):
        return len(value) <= MAX_HUMAN_TEXT_CHARS
    return (
        isinstance(value, list)
        and len(value) <= MAX_HUMAN_CHOICES
        and len(value) == len(set(value))
        and all(isinstance(item, str) and len(item) <= MAX_HUMAN_CHOICE_CHARS for item in value)
    )
