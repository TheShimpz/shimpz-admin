"""The Supervisor's TypeSafe key for the Jev intent-classification fast path (ADR-0077).

The key is Space-owned and optional: without it, intent classification runs the LLM route exactly as before. Only
masked metadata leaves this module over HTTP; ``resolve`` is the internal hand-off to the Team intent route and must
never be registered as a route.
"""

import asyncio

import models
import state
from fastapi import FastAPI, HTTPException, Request
from team import http as team_http

PROVIDER = "typesafe"
# TypeSafe's authenticated model listing: 2xx for a valid key, 401 or 403 otherwise.
VALIDATION_HOST = "api.typesafe.ai"
VALIDATION_PATH = "/v1/models"


class DecisionProviderError(ValueError):
    """The Supervisor supplied an unusable or rejected TypeSafe key."""


class DecisionProviderUnavailableError(RuntimeError):
    """TypeSafe could not confirm the key right now."""


def _verified_secret() -> str | None:
    return models.verified_secret(state.decision_credential())


def status() -> dict[str, object]:
    """Project configuration state without ever returning the key."""
    secret = _verified_secret()
    return {
        "provider": PROVIDER,
        "configured": secret is not None,
        "masked": None if secret is None else f"••••{secret[-4:]}",
    }


def configure(api_key: object) -> dict[str, object]:
    try:
        secret = models.canonical_api_key(api_key)
    except models.ModelProviderError as exc:
        raise DecisionProviderError(str(exc)) from None
    status_code = models.probe_status(VALIDATION_HOST, VALIDATION_PATH, {"Authorization": f"Bearer {secret}"})
    if status_code is None or not (200 <= status_code < 300 or status_code in {401, 403}):
        raise DecisionProviderUnavailableError("TypeSafe validation is temporarily unavailable")
    if status_code in {401, 403}:
        raise DecisionProviderError("TypeSafe rejected API key")
    state.set_decision_api_key(secret)
    return status()


def remove() -> dict[str, object]:
    state.delete_decision_api_key()
    return status()


def resolve() -> str | None:
    """Return the verified key for the Team intent-route hand-off; never expose it over HTTP."""
    return _verified_secret()


async def _configure_route(request: Request) -> dict[str, object]:
    payload = await team_http.bounded_json_object(request)
    if set(payload) != {"api_key"}:
        raise HTTPException(status_code=400, detail="request body must contain only api_key")
    try:
        return await asyncio.to_thread(configure, payload["api_key"])
    except DecisionProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except DecisionProviderUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


def register(app: FastAPI) -> None:
    """Expose masked status, configuration, and removal to the authenticated Local Supervisor."""
    app.add_api_route("/api/decision-provider", status, methods=["GET"])
    app.add_api_route("/api/decision-provider", _configure_route, methods=["PUT"])
    app.add_api_route("/api/decision-provider", remove, methods=["DELETE"])
