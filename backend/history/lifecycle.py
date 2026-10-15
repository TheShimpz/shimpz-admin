"""What a stored Assistant lifecycle event carries: an install plan's or an uninstall's terminal outcome.

Pure shape checks, the same when an event is written and when its row is read back.
"""

from collections.abc import Mapping

from chat import assistant_install, store_catalog
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as chat_ws_common


def _creator(value: object) -> bool:
    """One Creator handle in the public grammar the Store catalog and Team's stage labels both admit."""
    return isinstance(value, str) and store_catalog.CREATOR_RE.fullmatch(value) is not None


def _version(value: object) -> bool:
    return isinstance(value, str) and store_catalog.VERSION_RE.fullmatch(value) is not None


def _install_assistant(value: object) -> dict[str, object]:
    expected = {"id", "name", "summary", "creator", "version", "providers", "provenance", "status"}
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
        or not _creator(value["creator"])
        or not _version(value["version"])
    ):
        raise ValueError("chat history Assistant install item is invalid")
    canonical_providers = [team_contract.canonical_identifier(provider) for provider in providers]
    if any(provider is None for provider in canonical_providers) or canonical_providers != sorted(
        set(canonical_providers)
    ):
        raise ValueError("chat history Assistant install providers are invalid")
    return {
        "id": assistant_id,
        "name": chat_ws_common.public_text(value["name"], 80, field="Assistant name"),
        "summary": chat_ws_common.public_text(value["summary"], 80, field="Assistant summary"),
        "creator": value["creator"],
        "version": value["version"],
        "providers": canonical_providers,
        "provenance": value["provenance"],
        "status": value["status"],
    }


def install_payload(event: object, team_id: str) -> dict[str, object]:
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
        if "code" in event:
            expected.add("code")
    elif state != "stopped":
        raise ValueError("chat history Assistant install event is not terminal")
    if (
        set(event) != expected
        or event.get("team_id") != team_id
        or chat_ws_common.HEX_ID_RE.fullmatch(str(event.get("plan_id"))) is None
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
        or ("code" in event and (event["status"], event["code"]) != (409, assistant_install.ASSISTANT_LIMIT_REACHED))
    ):
        raise ValueError("chat history failed result is invalid")
    return {
        "kind": "assistant-install",
        "state": state,
        "assistants": canonical,
        **({"status": event["status"]} if state == "failed" else {}),
        **({"code": event["code"]} if "code" in event else {}),
        **({"outcome": event["outcome"]} if "outcome" in event else {}),
    }


def _uninstall_assistant(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping) or set(value) != {"id", "name", "version", "creator", "provenance"}:
        raise ValueError("chat history uninstall Assistant is invalid")
    assistant_id = team_contract.canonical_assistant_id(value["id"])
    if (
        assistant_id is None
        or assistant_id != value["id"]
        or not _version(value["version"])
        or not _creator(value["creator"])
        or value["provenance"] not in {"local", "published"}
    ):
        raise ValueError("chat history uninstall Assistant is invalid")
    return {
        "id": assistant_id,
        "name": chat_ws_common.public_text(value["name"], 80, field="Assistant name"),
        "version": value["version"],
        "creator": value["creator"],
        "provenance": value["provenance"],
    }


def uninstall_payload(event: object, team_id: str, assistant: object) -> dict[str, object]:
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
        or chat_ws_common.HEX_ID_RE.fullmatch(str(event.get("proposal_id"))) is None
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


def validate_stored_install(payload: dict[str, object]) -> None:
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


def validate_stored_uninstall(payload: dict[str, object]) -> None:
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
