#!/usr/bin/env python3
"""Verify the producer-owned Account Admin-session contract."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTRACT_FILES = (
    "README.md",
    "introspection-request.schema.json",
    "introspection-response.schema.json",
    "vectors.json",
)
ACCOUNT_ID = re.compile(r"[0-9a-f]{32}\Z")


def fail(message: str) -> None:
    raise SystemExit(message)


hash_rows = {}
for line in (HERE / "contract-files.sha256").read_text(encoding="ascii").splitlines():
    expected, filename = line.split("  ", 1)
    hash_rows[filename] = expected
if set(hash_rows) != set(CONTRACT_FILES):
    fail("Admin-session contract hash inventory is incomplete")
for filename, expected in hash_rows.items():
    actual = hashlib.sha256((HERE / filename).read_bytes()).hexdigest()
    if actual != expected:
        fail(f"{filename} SHA-256 is {actual}, expected {expected}")

for filename in ("introspection-request.schema.json", "introspection-response.schema.json"):
    schema = json.loads((HERE / filename).read_bytes())
    if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        fail(f"{filename} does not declare JSON Schema 2020-12")
    expected_id = f"https://schemas.shimpz.com/account/admin-session/v1/{filename}"
    if schema.get("$id") != expected_id:
        fail(f"{filename} has an invalid canonical ID")

vectors = json.loads((HERE / "vectors.json").read_bytes())
if vectors.get("version") != 1 or not isinstance(vectors.get("vectors"), list):
    fail("Admin-session vectors have an invalid envelope")
for vector in vectors["vectors"]:
    request = vector.get("request")
    response = vector.get("response")
    if not isinstance(request, dict) or set(request) != {"version", "token"}:
        fail("Admin-session request vector is not closed")
    if request["version"] != 1 or isinstance(request["version"], bool) or not isinstance(request["token"], str):
        fail("Admin-session request vector is invalid")
    if not isinstance(response, dict) or response.get("version") != 1 or not isinstance(response.get("active"), bool):
        fail("Admin-session response vector is invalid")
    expected_keys = {"version", "active", "account_id", "supervisor"} if response["active"] else {"version", "active"}
    if set(response) != expected_keys:
        fail("Admin-session response vector is not closed")
    if response["active"] and (
        not isinstance(response["account_id"], str)
        or ACCOUNT_ID.fullmatch(response["account_id"]) is None
        or not isinstance(response["supervisor"], bool)
    ):
        fail("active Admin-session response vector is invalid")

print("Account Admin-session protocol v1 verified")
