"""Local model-provider credentials owned exclusively by the Admin backend.

Only masked metadata is safe for HTTP responses. The cleartext resolver at the bottom is an
internal hand-off point for the local chat control plane; it must never be registered as a route,
placed in Team inference metadata, or sent through the Assistant Store iframe.
"""

from __future__ import annotations

import http.client
import ssl
from dataclasses import dataclass

import adminstore


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


# Base rates verified 2026-07-17: https://developers.openai.com/api/docs/models and https://platform.claude.com/docs/en/about-claude/pricing
PROVIDERS = {
    "openai": ProviderDefinition(
        title="OpenAI",
        default_model="gpt-5.6-terra",
        models=(
            ModelDefinition("gpt-5.6-sol", "GPT-5.6 Sol", 500, 3_000),
            ModelDefinition("gpt-5.6-terra", "GPT-5.6 Terra", 250, 1_500),
            ModelDefinition("gpt-5.6-luna", "GPT-5.6 Luna", 100, 600),
            ModelDefinition("gpt-5.5", "GPT-5.5", 500, 3_000),
        ),
    ),
    "anthropic": ProviderDefinition(
        title="Anthropic",
        default_model="claude-sonnet-5",
        models=(
            ModelDefinition("claude-fable-5", "Claude Fable 5", 1_000, 5_000),
            ModelDefinition("claude-opus-4-8", "Claude Opus 4.8", 500, 2_500),
            ModelDefinition("claude-sonnet-5", "Claude Sonnet 5", 300, 1_500),
            ModelDefinition("claude-haiku-4-5-20251001", "Claude Haiku 4.5", 100, 500),
        ),
    ),
}
MAX_API_KEY_BYTES = 8 * 1024
MIN_API_KEY_BYTES = 16
VALIDATION_TIMEOUT_SECONDS = 5.0

_VALIDATION_ENDPOINTS = {
    "openai": ("api.openai.com", "/v1/models"),
    "anthropic": ("api.anthropic.com", "/v1/models"),
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
    records = adminstore.model_credentials()
    unknown = set(records) - set(PROVIDERS)
    if unknown:
        raise RuntimeError("admin store has unsupported model credentials")
    return records


def _masked(secret: str) -> str:
    return f"••••{secret[-4:]}"


def _verified_secret(record: object) -> str | None:
    if not isinstance(record, dict):
        return None
    verified_at = record.get("verified_at")
    secret = record.get("api_key")
    if type(verified_at) is not int or verified_at <= 0 or not isinstance(secret, str):
        return None
    try:
        return canonical_api_key(secret)
    except ModelProviderError:
        return None


def _validation_headers(provider: str, secret: str) -> dict[str, str]:
    if provider == "openai":
        return {"Authorization": f"Bearer {secret}"}
    return {
        "x-api-key": secret,
        "anthropic-version": "2023-06-01",
    }


def _validate_api_key(provider: str, secret: str) -> None:
    """Confirm one key against its fixed TLS endpoint without consuming response data."""
    host, path = _VALIDATION_ENDPOINTS[provider]
    connection = None
    response = None
    try:
        connection = http.client.HTTPSConnection(
            host,
            port=443,
            timeout=VALIDATION_TIMEOUT_SECONDS,
            context=ssl.create_default_context(),
        )
        connection.request("GET", path, headers=_validation_headers(provider, secret))
        response = connection.getresponse()
        status_code = response.status
    except OSError, TimeoutError, http.client.HTTPException:
        raise ModelProviderUnavailableError("model provider validation is temporarily unavailable") from None
    finally:
        if response is not None:
            response.close()
        if connection is not None:
            connection.close()

    if 200 <= status_code < 300:
        return
    if status_code in {401, 403}:
        raise ModelProviderError("model provider rejected API key")
    raise ModelProviderUnavailableError("model provider validation is temporarily unavailable")


def status() -> dict[str, list[dict[str, object]]]:
    """Project configuration state without ever returning a provider key."""
    records = _records()
    providers = []
    for provider, metadata in PROVIDERS.items():
        record = records.get(provider)
        secret = _verified_secret(record)
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
                "masked": _masked(secret) if configured else None,
            }
        )
    return {"providers": providers}


def configure(provider: object, api_key: object) -> dict[str, object]:
    selected = canonical_provider(provider)
    secret = canonical_api_key(api_key)
    _validate_api_key(selected, secret)
    adminstore.set_model_api_key(selected, secret)
    return next(item for item in status()["providers"] if item["id"] == selected)


def remove(provider: object) -> dict[str, object]:
    selected = canonical_provider(provider)
    adminstore.delete_model_api_key(selected)
    return next(item for item in status()["providers"] if item["id"] == selected)


def resolve_api_key(provider: object) -> str | None:
    """Resolve cleartext for a future backend-to-controller chat hand-off; never expose as HTTP."""
    selected = canonical_provider(provider)
    record = _records().get(selected)
    return _verified_secret(record)
