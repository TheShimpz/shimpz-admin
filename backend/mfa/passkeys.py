"""Exact-origin UV WebAuthn ceremonies for the Local Supervisor."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url, parse_authentication_credential_json
from webauthn.helpers.exceptions import (
    InvalidAuthenticationResponse,
    InvalidBackupFlags,
    InvalidJSONStructure,
    InvalidRegistrationResponse,
    WebAuthnException,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    CredentialDeviceType,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from protocol.http.v1.websocket import canonical_origin

CHALLENGE_TTL_SECONDS = 180
CHALLENGE_CAPACITY = 64
CEREMONY_TIMEOUT_MS = CHALLENGE_TTL_SECONDS * 1000
MAX_PASSKEYS = 8
RP_NAME = "Shimpz"
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_-]{1,1024}$")


class PasskeyError(RuntimeError):
    """A WebAuthn ceremony or stored credential failed closed."""


class PasskeyUnavailableError(PasskeyError):
    """The exact origin cannot start the requested passkey ceremony."""


class PasskeyConflictError(PasskeyError):
    """Credential or factor state changed during a ceremony."""


@dataclass(frozen=True, slots=True)
class Challenge:
    """One private, exact-ceremony WebAuthn challenge."""

    challenge: bytes
    origin: str
    rp_id: str
    generation: int
    expires_at: float


@dataclass(frozen=True, slots=True)
class Authentication:
    """Verified credential state to commit atomically."""

    credential_id: str
    new_sign_count: int
    backup_eligible: bool
    backup_state: bool


class ChallengeStore:
    """Bounded one-process challenge authority keyed by private session evidence."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        capacity: int = CHALLENGE_CAPACITY,
        ttl_seconds: int = CHALLENGE_TTL_SECONDS,
    ) -> None:
        if not 1 <= capacity <= 1024 or not 30 <= ttl_seconds <= 300:
            raise ValueError("invalid passkey challenge limits")
        self._clock = clock
        self._capacity = capacity
        self._ttl = ttl_seconds
        self._records: dict[tuple[bytes, str], Challenge] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _binding(value: object) -> bytes:
        if not isinstance(value, str) or not 32 <= len(value) <= 512 or not value.isascii():
            raise PasskeyUnavailableError("passkey ceremony is unavailable")
        return hashlib.sha256(value.encode("ascii")).digest()

    def _expire(self, now: float) -> None:
        for key in tuple(key for key, value in self._records.items() if value.expires_at <= now):
            self._records.pop(key, None)

    def issue(self, binding: object, ceremony: str, origin: str, generation: int) -> Challenge:
        if ceremony not in {"authentication", "registration"} or type(generation) is not int or generation < 1:
            raise ValueError("invalid passkey challenge binding")
        rp_id = rp_id_for_origin(origin)
        now = self._clock()
        key = (self._binding(binding), ceremony)
        with self._lock:
            self._expire(now)
            if key not in self._records and len(self._records) >= self._capacity:
                raise PasskeyUnavailableError("passkey challenge capacity reached")
            challenge = Challenge(secrets.token_bytes(32), origin, rp_id, generation, now + self._ttl)
            self._records[key] = challenge
            return challenge

    def consume(self, binding: object, ceremony: str) -> Challenge:
        now = self._clock()
        key = (self._binding(binding), ceremony)
        with self._lock:
            self._expire(now)
            challenge = self._records.pop(key, None)
        if challenge is None or challenge.expires_at <= now:
            raise PasskeyUnavailableError("passkey challenge is unavailable")
        return challenge

    def clear(self) -> None:
        with self._lock:
            self._records.clear()


def rp_id_for_origin(origin: object) -> str:
    """Return the exact-host RP ID for one canonical WebAuthn-capable origin."""
    if not isinstance(origin, str) or canonical_origin(origin) != origin:
        raise PasskeyUnavailableError("passkeys are unavailable at this Admin address")
    parsed = urlsplit(origin)
    hostname = parsed.hostname
    if hostname is None or parsed.username is not None or parsed.password is not None:
        raise PasskeyUnavailableError("passkeys are unavailable at this Admin address")
    if parsed.scheme == "http" and hostname == "localhost":
        return hostname
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        is_domain = "." in hostname or hostname == "localhost"
    else:
        is_domain = False
    if parsed.scheme != "https" or not is_domain:
        raise PasskeyUnavailableError("passkeys are unavailable at this Admin address")
    return hostname


def _descriptors(records: list[dict[str, object]]) -> list[PublicKeyCredentialDescriptor]:
    try:
        return [
            PublicKeyCredentialDescriptor(id=base64url_to_bytes(str(record["credential_id"])))
            for record in records
        ]
    except (KeyError, TypeError, ValueError) as exc:
        raise PasskeyError("stored passkey is invalid") from exc


def registration_options(
    challenge: Challenge,
    user_id_hex: str,
    records: list[dict[str, object]],
) -> dict[str, object]:
    """Generate UV-required registration options for the singleton Supervisor."""
    try:
        options = generate_registration_options(
            rp_id=challenge.rp_id,
            rp_name=RP_NAME,
            user_name="Supervisor",
            user_id=bytes.fromhex(user_id_hex),
            challenge=challenge.challenge,
            timeout=CEREMONY_TIMEOUT_MS,
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.PREFERRED,
                user_verification=UserVerificationRequirement.REQUIRED,
            ),
            exclude_credentials=_descriptors(records),
        )
        return json.loads(options_to_json(options))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise PasskeyError("stored passkey enrollment state is invalid") from exc


def authentication_options(challenge: Challenge, records: list[dict[str, object]]) -> dict[str, object]:
    """Generate UV-required assertion options for active exact-origin credentials."""
    if not records:
        raise PasskeyUnavailableError("no passkey is registered for this Admin address")
    options = generate_authentication_options(
        rp_id=challenge.rp_id,
        challenge=challenge.challenge,
        timeout=CEREMONY_TIMEOUT_MS,
        allow_credentials=_descriptors(records),
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    try:
        return json.loads(options_to_json(options))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise PasskeyError("stored passkey authentication state is invalid") from exc


def verify_registration(challenge: Challenge, credential: object, now: int) -> dict[str, object]:
    """Verify one registration and return the strict persisted public record."""
    try:
        verified = verify_registration_response(
            credential=credential,
            expected_challenge=challenge.challenge,
            expected_rp_id=challenge.rp_id,
            expected_origin=challenge.origin,
            require_user_verification=True,
        )
    except (InvalidRegistrationResponse, TypeError, ValueError) as exc:
        raise PasskeyUnavailableError("invalid passkey registration") from exc
    return {
        "credential_id": bytes_to_base64url(verified.credential_id),
        "public_key": bytes_to_base64url(verified.credential_public_key),
        "sign_count": verified.sign_count,
        "backup_eligible": verified.credential_device_type is CredentialDeviceType.MULTI_DEVICE,
        "backup_state": verified.credential_backed_up,
        "rp_id": challenge.rp_id,
        "origin": challenge.origin,
        "status": "active",
        "created_at": now,
        "updated_at": now,
        "last_used_at": now,
    }


def credential_id(credential: object) -> str:
    """Extract one bounded credential identifier before selecting persisted public state."""
    try:
        parsed = parse_authentication_credential_json(credential)
        value = bytes_to_base64url(parsed.raw_id)
    except (InvalidAuthenticationResponse, InvalidJSONStructure, TypeError, ValueError) as exc:
        raise PasskeyUnavailableError("invalid passkey authentication") from exc
    if IDENTIFIER_RE.fullmatch(value) is None:
        raise PasskeyUnavailableError("invalid passkey authentication")
    return value


def verify_authentication(
    challenge: Challenge,
    credential: object,
    record: dict[str, object],
) -> Authentication:
    """Verify one assertion against an already validated exact credential record."""
    try:
        parsed = parse_authentication_credential_json(credential)
        verified = verify_authentication_response(
            credential=parsed,
            expected_challenge=challenge.challenge,
            expected_rp_id=challenge.rp_id,
            expected_origin=challenge.origin,
            credential_public_key=base64url_to_bytes(str(record["public_key"])),
            credential_current_sign_count=0,
            require_user_verification=True,
        )
    except (
        InvalidAuthenticationResponse,
        InvalidBackupFlags,
        InvalidJSONStructure,
        KeyError,
        TypeError,
        ValueError,
    ) as exc:
        raise PasskeyUnavailableError("invalid passkey authentication") from exc
    except WebAuthnException as exc:
        raise PasskeyError("stored passkey is invalid") from exc
    return Authentication(
        bytes_to_base64url(verified.credential_id),
        verified.new_sign_count,
        verified.credential_device_type is CredentialDeviceType.MULTI_DEVICE,
        verified.credential_backed_up,
    )
