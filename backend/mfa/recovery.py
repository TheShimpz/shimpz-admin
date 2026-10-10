"""Single-use Supervisor recovery codes (ADR-0051): generated with each TOTP enrollment, stored only as scrypt digests.

A set is ten random codes of twelve characters from a 32-letter alphabet (60 bits each), shown to the Supervisor once.
The set shares one random salt, so verifying a candidate costs one derivation compared in constant time against every
unused digest. A code admits only the re-enrollment of TOTP; it never issues a session by itself.
"""

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass

CODE_COUNT = 10
CODE_CHARS = 12
GROUP_CHARS = 4
# Crockford's base32 in lower case: no i, l, o, or u, so a code read aloud or written down stays unambiguous.
ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
_CODE_RE = re.compile(rf"[{ALPHABET}]{{{CODE_CHARS}}}")
_HEX_RE = re.compile(r"[0-9a-f]{64}")
_N, _R, _P, _DKLEN = 2**14, 8, 1, 32
_MAXMEM = 128 * _N * _R * 2
MAX_INPUT_CHARS = 64


class RecoveryStateError(RuntimeError):
    """Persisted recovery codes do not match the exact current contract."""


@dataclass(frozen=True, slots=True)
class CodeSet:
    """A fresh set: the codes to show once, and the record that keeps only their digests."""

    codes: tuple[str, ...]
    record: dict[str, object]


def _digest(normalized: str, salt: bytes) -> str:
    return hashlib.scrypt(normalized.encode("ascii"), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN, maxmem=_MAXMEM).hex()


def _display(code: str) -> str:
    return "-".join(code[index : index + GROUP_CHARS] for index in range(0, CODE_CHARS, GROUP_CHARS))


def new_set() -> CodeSet:
    """Generate ten fresh codes and their digests; this derives ten scrypt keys, so call it off the event loop."""
    salt = secrets.token_bytes(32)
    codes = tuple("".join(secrets.choice(ALPHABET) for _ in range(CODE_CHARS)) for _ in range(CODE_COUNT))
    record = {
        "salt": salt.hex(),
        "codes": [{"digest": _digest(code, salt), "used_at": None} for code in codes],
    }
    return CodeSet(tuple(_display(code) for code in codes), record)


def normalized(candidate: object) -> str | None:
    """The comparison form of a typed code: case, spaces, and hyphens ignored; anything else is no code."""
    if not isinstance(candidate, str) or len(candidate) > MAX_INPUT_CHARS:
        return None
    value = "".join(character for character in candidate.lower() if character not in " -")
    return value if _CODE_RE.fullmatch(value) else None


def validated(record: object) -> dict[str, object]:
    """Return one strict persisted set, or raise `RecoveryStateError`."""
    if not isinstance(record, dict) or set(record) != {"salt", "codes"}:
        raise RecoveryStateError("stored recovery codes are invalid")
    salt, codes = record["salt"], record["codes"]
    if not isinstance(salt, str) or _HEX_RE.fullmatch(salt) is None or not isinstance(codes, list):
        raise RecoveryStateError("stored recovery codes are invalid")
    if len(codes) != CODE_COUNT:
        raise RecoveryStateError("stored recovery codes are invalid")
    for entry in codes:
        used_at = entry.get("used_at") if isinstance(entry, dict) else None
        if (
            not isinstance(entry, dict)
            or set(entry) != {"digest", "used_at"}
            or not isinstance(entry["digest"], str)
            or _HEX_RE.fullmatch(entry["digest"]) is None
            or (used_at is not None and (isinstance(used_at, bool) or not isinstance(used_at, int) or used_at < 1))
        ):
            raise RecoveryStateError("stored recovery codes are invalid")
    if len({entry["digest"] for entry in codes}) != CODE_COUNT:
        raise RecoveryStateError("stored recovery codes are invalid")
    return record


def remaining(record: object) -> int:
    """How many codes of a strict set are still unused."""
    return sum(entry["used_at"] is None for entry in validated(record)["codes"])


@dataclass(frozen=True, slots=True)
class Candidate:
    """A typed code derived under one set's salt, computed before the transaction that compares it."""

    salt: str
    digest: str | None


def candidate(record: object, typed: object) -> Candidate:
    """Derive a typed code under the set's salt; a malformed code derives nothing and is simply refused."""
    salt = str(validated(record)["salt"])
    value = normalized(typed)
    return Candidate(salt, None if value is None else _digest(value, bytes.fromhex(salt)))


def spend(record: dict[str, object], derived: Candidate, now: int) -> bool:
    """Mark the unused code matching `derived`, derived under this set's salt, as used; every digest is compared."""
    entries = validated(record)["codes"]
    matched = None
    for entry in entries:
        equal = hmac.compare_digest(entry["digest"], derived.digest or "")
        if equal and entry["used_at"] is None:
            matched = entry
    if matched is None:
        return False
    matched["used_at"] = now
    return True
