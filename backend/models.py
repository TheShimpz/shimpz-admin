"""Local model-provider credentials owned exclusively by the Admin backend.

Only masked metadata is safe for the browser. The cleartext resolver at the bottom is an
internal hand-off point for the local chat control plane; it must never be registered as a route
or placed in Team inference metadata.
"""

import http.client
import json
import ssl
from dataclasses import dataclass
from pathlib import Path

import state


@dataclass(frozen=True, slots=True)
class ModelDefinition:
    id: str
    title: str
    input_usd_per_million_cents: int
    output_usd_per_million_cents: int


@dataclass(frozen=True, slots=True)
class ProviderDefinition:
    title: str
    default_model: str
    models: tuple[ModelDefinition, ...]


_CATALOG = json.loads(Path(__file__).with_name("model_catalog.json").read_text(encoding="utf-8"))
PROVIDERS = {
    provider["id"]: ProviderDefinition(
        title=provider["title"],
        default_model=provider["default_model"],
        models=tuple(
            ModelDefinition(
                model["id"],
                model["title"],
                model["input_usd_per_million_cents"],
                model["output_usd_per_million_cents"],
            )
            for model in provider["models"]
            # A person chooses only a chat model; a non-chat one is a model Brain runs itself (the Browser's).
            if model["chat"] is True
        ),
    )
    for provider in _CATALOG["providers"]
}
MAX_API_KEY_BYTES = 8 * 1024
MIN_API_KEY_BYTES = 16
VALIDATION_TIMEOUT_SECONDS = 5.0

_VALIDATION_ENDPOINTS = {
    provider["id"]: (
        provider["credential_validation"]["host"],
        provider["credential_validation"]["path"],
    )
    for provider in _CATALOG["providers"]
}


class ModelProviderError(ValueError):
    """A browser-supplied provider credential failed the closed contract."""


class ModelProviderUnavailableError(RuntimeError):
    """The provider could not safely confirm a credential right now."""


def canonical_provider(value: object) -> str:
    provider = str(value or "").strip().lower()
    if provider not in PROVIDERS:
        raise ModelProviderError("unsupported model provider")
    return provider


def canonical_model(provider: object, value: object) -> str:
    selected = canonical_provider(provider)
    if not isinstance(value, str) or value not in {model.id for model in PROVIDERS[selected].models}:
        raise ModelProviderError("unsupported model for provider")
    return value


def canonical_api_key(value: object) -> str:
    if not isinstance(value, str) or value.strip() != value or not value.isascii():
        raise ModelProviderError("API key must be a trimmed ASCII string")
    encoded = value.encode("ascii")
    if not MIN_API_KEY_BYTES <= len(encoded) <= MAX_API_KEY_BYTES or any(not 33 <= byte <= 126 for byte in encoded):
        raise ModelProviderError("API key must contain 16 to 8192 printable characters")
    return value


def _records() -> dict:
    records = state.model_credentials()
    unknown = set(records) - set(PROVIDERS)
    if unknown:
        raise state.CredentialRecordError(f"admin store {state.STORE_PATH} has unsupported model credentials")
    return records


def masked(secret: str) -> str:
    """The only projection of a key the browser sees: its last four characters."""
    return f"••••{secret[-4:]}"


def verified_secret(record: object, name: str) -> str | None:
    """Return a stored record's verified key, or None when no key is stored.

    The writers store exactly a canonical key and the positive time its provider verified it, atomically, so any other
    record is a broken store and fails closed with ``state.CredentialRecordError``.
    """
    if record is None:
        return None
    if (
        not isinstance(record, dict)
        or set(record) != {"api_key", "verified_at"}
        or type(record["verified_at"]) is not int
        or record["verified_at"] <= 0
        or not _canonical(record["api_key"])
    ):
        raise state.CredentialRecordError(f"admin store {state.STORE_PATH} has an invalid {name} credential")
    return record["api_key"]


def _canonical(secret: object) -> bool:
    try:
        canonical_api_key(secret)
    except ModelProviderError:
        return False
    return True


def _validation_headers(provider: str, secret: str) -> dict[str, str]:
    if provider == "openai":
        return {"Authorization": f"Bearer {secret}"}
    return {
        "x-api-key": secret,
        "anthropic-version": "2023-06-01",
    }


def probe_status(host: str, path: str, headers: dict[str, str]) -> int | None:
    """GET one fixed TLS endpoint with a credential and return its status, or None when it cannot be reached.

    No response data is consumed, so a key can be confirmed without reading provider content.
    """
    try:
        connection = http.client.HTTPSConnection(
            host,
            port=443,
            timeout=VALIDATION_TIMEOUT_SECONDS,
            context=ssl.create_default_context(),
        )
    except OSError, TimeoutError, http.client.HTTPException:
        return None
    response = None
    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
    except OSError, TimeoutError, http.client.HTTPException:
        return None
    else:
        return response.status
    finally:
        if response is not None:
            response.close()
        connection.close()


def confirm_api_key(host: str, path: str, headers: dict[str, str], provider_name: str) -> None:
    """Confirm one key against its fixed TLS endpoint: 401 or 403 rejects it, and anything but 2xx is unavailable."""
    status_code = probe_status(host, path, headers)
    if status_code is not None and 200 <= status_code < 300:
        return
    if status_code in {401, 403}:
        raise ModelProviderError(f"{provider_name} rejected API key")
    raise ModelProviderUnavailableError(f"{provider_name} validation is temporarily unavailable")


def _validate_api_key(provider: str, secret: str) -> None:
    host, path = _VALIDATION_ENDPOINTS[provider]
    confirm_api_key(host, path, _validation_headers(provider, secret), "model provider")


def status() -> dict[str, list[dict[str, object]]]:
    """Project configuration state without ever returning a provider key."""
    records = _records()
    providers = []
    for provider, metadata in PROVIDERS.items():
        secret = verified_secret(records.get(provider), provider)
        configured = secret is not None
        providers.append(
            {
                "id": provider,
                "title": metadata.title,
                "default_model": metadata.default_model,
                "models": [
                    {
                        "id": model.id,
                        "title": model.title,
                        "input_usd_per_million_cents": model.input_usd_per_million_cents,
                        "output_usd_per_million_cents": model.output_usd_per_million_cents,
                    }
                    for model in metadata.models
                ],
                "configured": configured,
                "masked": masked(secret) if configured else None,
            }
        )
    return {"providers": providers}


def configure(provider: object, api_key: object) -> dict[str, object]:
    selected = canonical_provider(provider)
    secret = canonical_api_key(api_key)
    _validate_api_key(selected, secret)
    state.set_model_api_key(selected, secret)
    return next(item for item in status()["providers"] if item["id"] == selected)


def resolve_api_key(provider: object) -> str | None:
    """A verified provider key in cleartext, only for the Team turn chat.local delivers it to; never to a browser."""
    selected = canonical_provider(provider)
    return verified_secret(_records().get(selected), selected)
