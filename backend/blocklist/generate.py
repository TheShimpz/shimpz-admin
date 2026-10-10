"""Regenerate `passwords.txt`, the Supervisor common-password blocklist, from a pinned public corpus.

Run from `admin/`: `uv run --frozen --python 3.14 python backend/blocklist/generate.py`. The source is the SecLists
Pwdb top one million list at commit 913b327 (URL in `main`); its digest is verified before use. Each entry is kept
in the policy's comparison form when that form is at least the minimum password length, so the list holds only
passwords the length rule alone would admit.
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import auth

SOURCE_SHA256 = "e9a88f67aafe65496682dc374559ee714e978bee50314767494c3e37a18c9fc8"
HEX_PREFIX, HEX_SUFFIX = "$hex[", "]"


def _password(line: str) -> str | None:
    """Return the typed password, decoding the corpus's `$hex[...]` form; skip one that is not UTF-8 text."""
    if not (line[: len(HEX_PREFIX)].lower() == HEX_PREFIX and line.endswith(HEX_SUFFIX)):
        return line
    try:
        return bytes.fromhex(line[len(HEX_PREFIX) : -len(HEX_SUFFIX)]).decode("utf-8")
    except ValueError:
        return None


def entries(source: bytes) -> list[str]:
    """Return the sorted, unique policy-form entries that meet the minimum length."""
    passwords = (_password(line) for line in source.decode("utf-8").splitlines())
    normalized = (auth.normalized_password(password) for password in passwords if password is not None)
    return sorted({entry for entry in normalized if len(entry) >= auth.MIN_PASSWORD_CHARS})


def main() -> None:
    with urllib.request.urlopen(
        "https://raw.githubusercontent.com/danielmiessler/SecLists/913b327317496d062bcc7cace524aaad8a693be2/"
        "Passwords/Common-Credentials/Pwdb_top-1000000.txt",
        timeout=60,
    ) as response:
        source = response.read()
    digest = hashlib.sha256(source).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(f"source digest mismatch: {digest}")
    auth.BLOCKLIST_PATH.write_text("".join(f"{entry}\n" for entry in entries(source)), encoding="utf-8")


if __name__ == "__main__":
    main()
