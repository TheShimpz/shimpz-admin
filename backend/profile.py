"""Resolve the one admitted Admin runtime profile."""

import os


def require() -> str:
    value = os.environ.get("SHIMPZ_ADMIN_PROFILE", "").strip()
    if value not in {"local", "hosted"}:
        raise RuntimeError("SHIMPZ_ADMIN_PROFILE must be exactly local or hosted")
    return value
