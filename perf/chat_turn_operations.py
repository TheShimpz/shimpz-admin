"""Count Local Admin chat operations with synthetic Team and Store boundaries.

Run from the Admin checkout with
``PYTHONPATH=backend uv run --frozen --python 3.14 python -m perf.chat_turn_operations``.
This exercises authenticated sockets and temporary durable history, but does not
measure browser, Team, Brain, provider, network, or cache latency. No message,
credential, response body, or transcript is printed.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import tempfile
import threading
from collections import Counter
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

ADMIN = Path(__file__).resolve().parents[1]
TEAM_ID = "team_1"
TRACE_ID = "a" * 32
MODEL_KEY = "sk-" + "x" * 32
HISTORY_OPERATIONS = (
    "append_user",
    "append_reply",
    "append_install",
    "append_guidance",
    "append_uninstall",
    "page",
    "conversation",
    "bind_resumable_turn",
    "resumable_turn",
    "finish_resumable_turn",
)


class MeasurementError(RuntimeError):
    """The synthetic boundary or observed socket violated the declared workload."""


class Boundary:
    """Closed Team HTTP responses and lock-protected operation counts."""

    def __init__(self, team, max_context_entries: int) -> None:
        self.team = team
        self.max_context_entries = max_context_entries
        self.lock = threading.Lock()
        self.calls: Counter[str] = Counter()
        self.context_lengths: list[int] = []

    def _count(self, name: str) -> None:
        with self.lock:
            self.calls[name] += 1

    def snapshot(self) -> Counter[str]:
        with self.lock:
            return self.calls.copy()

    def context_snapshot(self) -> list[int]:
        with self.lock:
            return list(self.context_lengths)

    def catalog(self):
        self._count("Store catalog get")
        return ()

    def call(self, method: str, path: str, payload=None, **kwargs):
        self._count(f"{method} {path}")
        if method == "GET" and path == f"/v1/teams/{TEAM_ID}/inference":
            return self.team.TeamResponse(
                200,
                {"team_id": TEAM_ID, "provider": "openai", "model": "gpt-5.6-terra", "trace_id": TRACE_ID},
            )
        if method == "POST" and path == f"/v1/teams/{TEAM_ID}/chat/intent-route":
            return self._route(payload, kwargs)
        if method == "GET" and path in {
            f"/v1/teams/{TEAM_ID}/chat/integrations",
            f"/v1/teams/{TEAM_ID}/chat/human",
        }:
            return self.team.TeamResponse(200, {"team_id": TEAM_ID, "status": "none", "trace_id": TRACE_ID})
        if method == "GET" and path in {f"/v1/teams/{TEAM_ID}/assistants", "/v1/local-assistants"}:
            return self.team.TeamResponse(200, {"assistants": [], "trace_id": TRACE_ID})
        raise MeasurementError(f"unexpected Team HTTP operation: {method} {path}")

    def _route(self, payload, options):
        if (
            not isinstance(payload, dict)
            or set(payload)
            != {
                "objective",
                "expected_intent",
                "candidates",
                "lifecycle_reference",
                "conversation",
                "language_exemplar",
            }
            or payload["expected_intent"] is not None
            or payload["candidates"] != []
            or payload["lifecycle_reference"] is not None
            or payload["language_exemplar"] is not None
            or not isinstance(payload["conversation"], list)
            or len(payload["conversation"]) > self.max_context_entries
            or options.get("model_credential") != ("openai", MODEL_KEY)
        ):
            raise MeasurementError("intent route changed or widened")
        with self.lock:
            self.context_lengths.append(len(payload["conversation"]))
        if payload["objective"] == "Remove an Assistant":
            intent = "assistant-uninstall"
            reply = "Which Assistant should I uninstall?"
        elif payload["objective"] == "Hello":
            intent = "ordinary-task"
            reply = ""
        else:
            raise MeasurementError("unexpected synthetic objective")
        return self.team.TeamResponse(
            200,
            {
                "team_id": TEAM_ID,
                "intent": intent,
                "query": "",
                "assistant_ids": [],
                "reply": reply,
                "trace_id": TRACE_ID,
            },
        )

    def stream(self, method: str, path: str, payload, **kwargs):
        self._count(f"{method} {path}")
        bindings = kwargs.get("bindings")
        if (
            method != "POST"
            or path != f"/v1/teams/{TEAM_ID}/chat"
            or not isinstance(payload, dict)
            or payload.get("message") != "Hello"
            or payload.get("files") != []
            or payload.get("assistant_ids") != []
            or getattr(bindings, "model_credential", None) != ("openai", MODEL_KEY)
        ):
            raise MeasurementError("unexpected Team chat operation")
        return self.team.TeamResponse(
            200,
            {"team_id": TEAM_ID, "team_name": "Marketing", "reply": "Measured reply.", "trace_id": TRACE_ID},
        )


def _forbid_network(*_args, **_kwargs):
    raise MeasurementError("unexpected network connection")


def _delta(after: Counter[str], before: Counter[str]) -> dict[str, int]:
    return dict(sorted((after - before).items()))


async def _turn(
    application,
    token: str,
    boundary: Boundary,
    history_mocks,
    *,
    objective: str,
    stored_prior: int,
):
    from tests.chat_socket_fixtures import Socket

    websocket = Socket(application, token=token, team_id=TEAM_ID)
    accepted = await websocket.start()
    if accepted != {"type": "websocket.accept", "subprotocol": "shimpz.chat.v7", "headers": []}:
        raise MeasurementError("authenticated chat socket was denied")
    await websocket.send_json({"type": "sync"})
    if await websocket.next_json(10) != {"type": "sync-empty"}:
        raise MeasurementError("fresh socket did not complete history sync")
    before_calls = boundary.snapshot()
    before_contexts = boundary.context_snapshot()
    before_history = {name: wrapped.call_count for name, wrapped in history_mocks.items()}
    await websocket.send_json({"type": "chat", "message": objective, "files": [], "assistant_ids": []})
    frames = []
    while True:
        frame = await websocket.next_json(10)
        frames.append(frame["type"])
        if frame["type"] in {"done", "assistant-guidance", "error", "stopped"}:
            break
    await websocket.disconnect()
    expected = "done" if objective == "Hello" else "assistant-guidance"
    if frame["type"] != expected:
        raise MeasurementError("chat terminal did not match the synthetic route")
    if expected == "done" and frame != {
        "type": "done",
        "team_id": TEAM_ID,
        "team_name": "Marketing",
        "reply": "Measured reply.",
    }:
        raise MeasurementError("ordinary reply projection changed")
    if expected == "assistant-guidance" and (
        frame.get("team_id") != TEAM_ID
        or frame.get("code") != "assistant-uninstall-target-required"
        or frame.get("reply") != "Which Assistant should I uninstall?"
    ):
        raise MeasurementError("targetless uninstall guidance changed")
    contexts = boundary.context_snapshot()[len(before_contexts) :]
    projected_prior = min(stored_prior, boundary.max_context_entries)
    if contexts != [projected_prior]:
        raise MeasurementError("bounded conversation projection changed")
    history = {
        name: wrapped.call_count - before_history[name]
        for name, wrapped in history_mocks.items()
        if wrapped.call_count != before_history[name]
    }
    return {
        "case": f"ordinary_after_{stored_prior}_entries" if objective == "Hello" else "targetless_uninstall",
        "stored_prior_entries": stored_prior,
        "projected_context_entries": projected_prior,
        "team_calls": _delta(boundary.snapshot(), before_calls),
        "history_operations": dict(sorted(history.items())),
        "frames": frames,
    }


async def _measure(application, token: str, boundary: Boundary, history_mocks):
    results = []
    with (
        mock.patch.object(socket.socket, "connect", side_effect=_forbid_network) as connect,
        mock.patch.object(socket.socket, "connect_ex", side_effect=_forbid_network) as connect_ex,
        mock.patch.object(socket, "getaddrinfo", side_effect=_forbid_network) as getaddrinfo,
    ):
        ordinary_turns = boundary.max_context_entries // 2 + 2
        stored_prior = 0
        for _index in range(ordinary_turns):
            result = await _turn(
                application,
                token,
                boundary,
                history_mocks,
                objective="Hello",
                stored_prior=stored_prior,
            )
            writes = result["history_operations"]
            if writes.get("append_user") != 1 or writes.get("append_reply") != 1:
                raise MeasurementError("ordinary history writes changed")
            stored_prior += writes["append_user"] + writes["append_reply"]
            results.append(result)
        results.append(
            await _turn(
                application,
                token,
                boundary,
                history_mocks,
                objective="Remove an Assistant",
                stored_prior=stored_prior,
            )
        )
        if connect.called or connect_ex.called or getaddrinfo.called:
            raise MeasurementError("network connection was attempted")
    return results


def main() -> int:
    sys.path.insert(0, str(ADMIN))
    sys.path.insert(0, str(ADMIN / "backend"))
    try:
        with tempfile.TemporaryDirectory(prefix="shimpz-chat-operations-") as temporary:
            root = Path(temporary)
            with mock.patch.dict(
                os.environ,
                {
                    "SHIMPZ_REPO": str(root),
                    "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
                    "SHIMPZ_CHAT_HISTORY_STORE": str(root / "history.sqlite3"),
                    "SHIMPZ_ADMIN_PROFILE": "local",
                    "SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777",
                },
            ):
                from history import context as history_context
                from history import store
                from tests.mfa_helper import configure_supervisor

                import app

                secret = configure_supervisor(app.state, "violet otter lantern quartz 92")
                token = app.auth.issue_session(secret, "totp")
                app.state.set_model_api_key("openai", MODEL_KEY)
                boundary = Boundary(app.team, history_context.MAX_ENTRIES)
                with ExitStack() as stack:
                    stack.enter_context(mock.patch.object(app.team, "_call", side_effect=boundary.call))
                    stack.enter_context(mock.patch.object(app.team, "_call_stream", side_effect=boundary.stream))
                    stack.enter_context(mock.patch.object(app.team, "_call_raw", side_effect=_forbid_network))
                    stack.enter_context(mock.patch.object(app.team, "_call_asset", side_effect=_forbid_network))
                    stack.enter_context(
                        mock.patch.object(app.chat_socket.lifecycle._STORE_CATALOG, "get", side_effect=boundary.catalog)
                    )
                    history_mocks = {
                        name: stack.enter_context(mock.patch.object(store, name, wraps=getattr(store, name)))
                        for name in HISTORY_OPERATIONS
                    }
                    results = asyncio.run(_measure(app.app, token, boundary, history_mocks))
        print(
            json.dumps(
                {"status": "complete", "scope": "Admin in-process WebSocket operation counts", "results": results},
                sort_keys=True,
            )
        )
    except (AssertionError, MeasurementError, OSError, RuntimeError, ValueError, TimeoutError) as exc:
        error = {"status": "error", "error_type": type(exc).__name__}
        if isinstance(exc, MeasurementError):
            error["detail"] = str(exc)
        print(json.dumps(error))
        return 1
    else:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
