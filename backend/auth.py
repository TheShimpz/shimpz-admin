"""Password hashing + signed session tokens for the admin panel — stdlib only, zero deps.

No database, no framework: a password is scrypt-hashed against a per-install salt; a logged-in
session is a self-contained HMAC-signed token `v1:{exp}:{nonce}:{sig}` (all hex, so it survives
being copied through anything). `session_secret` lives in admin.json — rotating it invalidates
every outstanding session at once (the emergency "log everyone out" lever). Constant-time
comparison everywhere a secret is checked.
"""

import hashlib
import hmac
import secrets
import time

# scrypt cost. 128 * N * R ≈ 16 MiB peak — comfortably under OpenSSL's default maxmem, but we pass
# maxmem explicitly so a future N bump can't start failing silently on the default ceiling.
_N, _R, _P, _DKLEN = 2**14, 8, 1, 32
_MAXMEM = 128 * _N * _R * 4  # ~64 MiB headroom

TTL = 7 * 24 * 3600  # session lifetime; single-operator loopback tool, revocable via secret rotate
_SCHEME = "v1"


def new_secret():
    """32-byte hex — used for BOTH the password salt and the session-signing secret."""
    return secrets.token_hex(32)


def hash_password(password, salt_hex):
    """scrypt(password, salt) → hex digest. `salt_hex` comes from new_secret()."""
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=bytes.fromhex(salt_hex),
        n=_N,
        r=_R,
        p=_P,
        dklen=_DKLEN,
        maxmem=_MAXMEM,
    ).hex()


def verify_password(password, salt_hex, expected_hash_hex):
    """Constant-time check of `password` against a stored (salt, hash)."""
    return hmac.compare_digest(hash_password(password, salt_hex), expected_hash_hex)


def issue_session(secret_hex, ttl=TTL):
    """Mint a signed session token valid for `ttl` seconds."""
    exp = int(time.time()) + int(ttl)
    body = f"{_SCHEME}:{exp}:{secrets.token_hex(8)}"
    sig = hmac.new(bytes.fromhex(secret_hex), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{body}:{sig}"


def verify_session(secret_hex, token):
    """True iff `token` carries a valid signature for `secret_hex` and has not expired.

    Signature is checked in constant time BEFORE the expiry parse — a forged token never reaches
    the (cheap, non-secret) time comparison. An empty secret (no admin configured yet) always fails.
    """
    if not secret_hex or not token:
        return False
    parts = token.split(":")
    if len(parts) != 4 or parts[0] != _SCHEME:
        return False
    body = ":".join(parts[:3])
    expected = hmac.new(bytes.fromhex(secret_hex), body.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(parts[3], expected):
        return False
    try:
        return int(parts[1]) > time.time()
    except ValueError:
        return False
