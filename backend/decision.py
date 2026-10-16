"""The Supervisor's TypeSafe key for the Jev intent-classification fast path (ADR-0077).

The key is Space-owned and optional: without it, intent classification runs the LLM route exactly as before. Only
masked metadata leaves this module through its session calls; ``resolve`` is the internal hand-off to the Team intent
route and is never a call.
"""

import models
import state

PROVIDER = "typesafe"
# TypeSafe's authenticated model listing: 2xx for a valid key, 401 or 403 otherwise.
VALIDATION_HOST = "api.typesafe.ai"
VALIDATION_PATH = "/v1/models"


def _verified_secret() -> str | None:
    return models.verified_secret(state.decision_credential(), PROVIDER)


def status() -> dict[str, object]:
    """Project configuration state without ever returning the key."""
    secret = _verified_secret()
    return {
        "provider": PROVIDER,
        "configured": secret is not None,
        "masked": None if secret is None else models.masked(secret),
    }


def configure(api_key: object) -> dict[str, object]:
    """Store a key TypeSafe confirmed; it raises the model-key errors a session save maps to 400 and 503."""
    secret = models.canonical_api_key(api_key)
    models.confirm_api_key(VALIDATION_HOST, VALIDATION_PATH, {"Authorization": f"Bearer {secret}"}, "TypeSafe")
    state.set_decision_api_key(secret)
    return status()


def remove() -> dict[str, object]:
    state.delete_decision_api_key()
    return status()


def resolve() -> str | None:
    """Return the verified key for the Team intent-route hand-off; never expose it to the browser."""
    return _verified_secret()
