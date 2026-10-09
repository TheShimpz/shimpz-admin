"""Local Supervisor identity, request assertions, and public-key materialization."""

import base64
import grp
import hashlib
import os
import re
import secrets
import stat
import time
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

from protocol.http.v1 import supervisor as contract

PUBLIC_KEY_FILE = Path(
    os.environ.get(
        "SHIMPZ_LOCAL_SUPERVISOR_PUBLIC_KEY_FILE",
        "/run/shimpz-local-supervisor/public.pem",
    )
)
# Admin's separate Routine identity publishes its key beside the Supervisor's, where Team reads it (ADR-0086).
ROUTINE_PUBLIC_KEY_FILE = PUBLIC_KEY_FILE.with_name("routine.pem")
PUBLIC_KEY_GROUP = os.environ.get(
    "SHIMPZ_LOCAL_SUPERVISOR_KEY_GROUP",
    "shimpzsupervisor-key",
)
_HEX_32 = re.compile(r"^[0-9a-f]{32}$")
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")


class SupervisorAuthorityError(OSError):
    """The Local Supervisor signing boundary is unavailable or invalid."""


@dataclass(frozen=True, slots=True)
class LocalIdentity:
    supervisor_id: str
    private_key_hex: str


@dataclass(frozen=True, slots=True)
class RequestBinding:
    """Exact Local Team request authorized by one short-lived assertion."""

    method: str
    path: str
    body: dict[str, object]
    model: dict[str, str] | None
    assurance: dict[str, str] | None = None
    decision: dict[str, str] | None = None


def new_identity() -> LocalIdentity:
    """Generate one installation-scoped Supervisor identity and signing key."""
    private_key = Ed25519PrivateKey.generate()
    private_raw = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    return LocalIdentity(secrets.token_hex(16), private_raw.hex())


def identity_from_record(
    record: object, *, id_field: str = "supervisor_id", key_field: str = "supervisor_signing_key"
) -> LocalIdentity:
    """Load the exact current Local identity from the private Admin record."""
    if not isinstance(record, dict):
        raise SupervisorAuthorityError("Local Supervisor identity is unavailable")
    supervisor_id = record.get(id_field)
    private_key_hex = record.get(key_field)
    if (
        not isinstance(supervisor_id, str)
        or _HEX_32.fullmatch(supervisor_id) is None
        or not isinstance(private_key_hex, str)
        or _HEX_64.fullmatch(private_key_hex) is None
    ):
        raise SupervisorAuthorityError("Local Supervisor identity is unavailable")
    # The exact 64-character lowercase-hex contract above always decodes to the 32 raw bytes
    # required by Ed25519PrivateKey.from_private_bytes.
    Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_key_hex))
    return LocalIdentity(supervisor_id, private_key_hex)


def local_session_evidence(record: object, *, session_valid: bool) -> dict[str, object] | None:
    """Project only authenticated Local Supervisor identity into Admin session evidence."""
    if not session_valid:
        return None
    identity = identity_from_record(record)
    return {"profile": "local", "supervisor_id": identity.supervisor_id}


def _private_key(identity: LocalIdentity) -> Ed25519PrivateKey:
    validated = identity_from_record(
        {
            "supervisor_id": identity.supervisor_id,
            "supervisor_signing_key": identity.private_key_hex,
        }
    )
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(validated.private_key_hex))


def _public_bytes(identity: LocalIdentity) -> bytes:
    return (
        _private_key(identity)
        .public_key()
        .public_bytes(
            Encoding.PEM,
            PublicFormat.SubjectPublicKeyInfo,
        )
    )


def _safe_public_file(path: Path, expected_gid: int) -> bytes | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_gid != expected_gid
        or stat.S_IMODE(metadata.st_mode) != 0o440
        or not 1 <= metadata.st_size <= 512
    ):
        raise SupervisorAuthorityError("Local Supervisor public key has unsafe metadata")
    raw = path.read_bytes()
    if len(raw) != metadata.st_size:
        raise SupervisorAuthorityError("Local Supervisor public key changed while reading")
    return raw


def _write_all(descriptor: int, raw: bytes) -> None:
    offset = 0
    while offset < len(raw):
        written = os.write(descriptor, raw[offset:])
        if written < 1:
            raise SupervisorAuthorityError("Local Supervisor public key write was incomplete")
        offset += written


def materialize_public_key(identity: LocalIdentity) -> None:
    """Atomically publish only the Supervisor's verification key into the shared runtime volume."""
    _materialize(PUBLIC_KEY_FILE, identity)


def materialize_routine_key(identity: LocalIdentity) -> None:
    """Atomically publish only the Routine identity's verification key beside the Supervisor's."""
    _materialize(ROUTINE_PUBLIC_KEY_FILE, identity)


def _materialize(path: Path, identity: LocalIdentity) -> None:
    try:
        expected_gid = grp.getgrnam(PUBLIC_KEY_GROUP).gr_gid
        parent = path.parent
        parent_metadata = parent.lstat()
    except (FileNotFoundError, KeyError, OSError) as exc:
        raise SupervisorAuthorityError("Local Supervisor key volume is unavailable") from exc
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or parent_metadata.st_gid != expected_gid
        or stat.S_IMODE(parent_metadata.st_mode) != 0o2770
    ):
        raise SupervisorAuthorityError("Local Supervisor key volume has unsafe metadata")
    expected = _public_bytes(identity)
    if _safe_public_file(path, expected_gid) == expected:
        return

    temporary = parent / f".public.{os.getpid()}.{secrets.token_hex(8)}.tmp"
    descriptor: int | None = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o440,
        )
        os.fchmod(descriptor, 0o440)
        metadata = os.fstat(descriptor)
        if metadata.st_gid != expected_gid or not stat.S_ISREG(metadata.st_mode):
            raise SupervisorAuthorityError("Local Supervisor public key target is unsafe")
        _write_all(descriptor, expected)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        temporary.replace(path)
        if _safe_public_file(path, expected_gid) != expected:
            raise SupervisorAuthorityError("Local Supervisor public key could not be verified")
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as exc:
        raise SupervisorAuthorityError("Local Supervisor public key could not be materialized") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def empty_body() -> dict[str, object]:
    return {"kind": "none", "length": 0, "sha256": contract.EMPTY_SHA256}


def json_body(raw: bytes) -> dict[str, object]:
    return {
        "kind": "json",
        "length": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def file_body(raw: bytes, filename: str, media_type: str) -> dict[str, object]:
    return {
        "kind": "file",
        "length": len(raw),
        "filename": filename,
        "media_type": media_type,
    }


def model_binding(model_credential: tuple[str, str] | None) -> dict[str, str] | None:
    if model_credential is None:
        return None
    provider, api_key = model_credential
    return {
        "provider": provider,
        "key_sha256": hashlib.sha256(api_key.encode("ascii")).hexdigest(),
    }


def decision_binding(decision_key: str | None) -> dict[str, str] | None:
    """Bind the TypeSafe key's digest into the assertion exactly as the model credential is bound (ADR-0077)."""
    if decision_key is None:
        return None
    return {"provider": "typesafe", "key_sha256": hashlib.sha256(decision_key.encode("ascii")).hexdigest()}


def _segment(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign_request(
    identity: LocalIdentity,
    authority_secret: str,
    *,
    request: RequestBinding,
    authority_kind: str = "session",
    now: int | None = None,
) -> str:
    """Sign one canonical, short-lived assertion for one exact Team request."""
    return _sign(
        identity,
        authority_secret,
        request=request,
        authority_kind=authority_kind,
        audience=contract.ASSERTION_AUDIENCE,
        jwt_header=contract.JWT_HEADER,
        now=now,
    )


def sign_routine_request(
    identity: LocalIdentity,
    lease_token: str,
    *,
    request: RequestBinding,
    now: int | None = None,
) -> str:
    """Sign one Routine assertion: Admin's routine identity drives the run whose lease token it holds (ADR-0086)."""
    if request.decision is not None or request.assurance is not None:
        raise SupervisorAuthorityError("a Routine assertion binds no human decision or assurance")
    return _sign(
        identity,
        lease_token,
        request=request,
        authority_kind=contract.ROUTINE_AUTHORITY,
        audience=contract.ROUTINE_AUDIENCE,
        jwt_header=contract.ROUTINE_JWT_HEADER,
        now=now,
    )


def _sign(
    identity: LocalIdentity,
    authority_secret: str,
    *,
    request: RequestBinding,
    authority_kind: str,
    audience: str,
    jwt_header: dict[str, str],
    now: int | None,
) -> str:
    issued_at = int(time.time()) if now is None else now
    claims: dict[str, object] = {
        "v": 1,
        "aud": audience,
        "sub": identity.supervisor_id,
        "authority": authority_kind,
        "authority_sha256": hashlib.sha256(authority_secret.encode("ascii")).hexdigest(),
        "jti": secrets.token_hex(16),
        "iat": issued_at,
        "exp": issued_at + contract.ASSERTION_MAX_TTL_SECONDS,
        "method": request.method,
        "path": request.path,
        "body": request.body,
    }
    if request.model is not None:
        claims["model"] = request.model
    if request.decision is not None:
        claims["decision"] = request.decision
    if request.assurance is not None:
        claims["assurance"] = request.assurance
    header = _segment(contract.canonical_json(jwt_header))
    payload = _segment(contract.claims_json(claims, audience=audience))
    signing_input = f"{header}.{payload}".encode("ascii")
    signature = _segment(_private_key(identity).sign(signing_input))
    return f"{header}.{payload}.{signature}"
