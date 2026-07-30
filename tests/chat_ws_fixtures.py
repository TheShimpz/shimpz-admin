"""Immutable challenge documents shared by Admin WebSocket contract suites."""

from __future__ import annotations

import importlib

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
            "summary": "Lets approved Powers access the connected X integration.",
            "scopes": ["tweet.read", "tweet.write", "users.read", "offline.access"],
            "powers": [
                {"id": "profile-me", "name": "Read profile", "summary": "Read the connected X profile."},
                {"id": "create-post", "name": "Create post", "summary": "Publish a post on X."},
            ],
        }
    ]


def integration_challenge(status: int = 428) -> object:
    localchat_module = importlib.import_module("localchat")
    return localchat_module.PublicResponse(
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
