"""Immutable challenge documents shared by Admin WebSocket contract suites."""

from __future__ import annotations

import hashlib
import importlib
import json

TURN_ID = "a" * 32
CHALLENGE_ID = "b" * 32


def integration_requirements() -> list[dict[str, object]]:
    return [
        {
            "assistant_id": "social-publisher",
            "assistant_name": "Social Publisher",
            "integration_id": "x-integration",
            "provider": "x",
            "name": "X integration",
            "summary": "Lets approved Actions access the connected X integration.",
            "scopes": ["tweet.read", "tweet.write", "users.read", "offline.access"],
            "actions": [
                {"id": "profile-me", "name": "Read profile", "summary": "Read the connected X profile."},
                {"id": "create-post", "name": "Create post", "summary": "Publish a post on X."},
            ],
        }
    ]


def integration_challenge(status: int = 428) -> object:
    local_module = importlib.import_module("chat.local")
    return local_module.PublicResponse(
        status,
        {
            "team_id": "team_1",
            "status": "integrations-required",
            "turn_id": TURN_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "requirements": integration_requirements(),
        },
    )


def human_challenge(kind: str, status: int = 428) -> object:
    local_module = importlib.import_module("chat.local")
    request: dict[str, object] = {
        "kind": kind,
        "ordinal": 0,
        "title": "Confirm this Action",
        "description": "The Action is waiting for your response.",
    }
    if kind == "input:password":
        request.update(
            label="API secret",
            required=True,
            placeholder="Enter the secret",
            min_length=1,
            max_length=1024,
        )
    canonical = json.dumps(
        request,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    request["fingerprint"] = hashlib.sha256(canonical).hexdigest()
    return local_module.PublicResponse(
        status,
        {
            "team_id": "team_1",
            "status": "human-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "assistant": {"id": "shimpz-cloudflare", "name": "Shimpz Cloudflare", "version": "0.4.1"},
            "action": {"id": "list-zones", "summary": "List reviewed Cloudflare zones."},
            "request": request,
        },
    )
