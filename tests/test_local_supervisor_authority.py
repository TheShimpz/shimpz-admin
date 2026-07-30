"""Local Supervisor identity, signing, and public-key custody contracts."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_pem_public_key

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import supervisor

from protocol.http.v1 import supervisor as contract


def _decode(encoded: str) -> bytes:
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))


class LocalSupervisorAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name) / "keys"
        parent.mkdir(mode=0o2770)
        parent.chmod(0o2770)
        self.public_key = parent / "public.pem"
        self.patches = (
            mock.patch.object(supervisor, "PUBLIC_KEY_FILE", self.public_key),
            mock.patch.object(
                supervisor.grp,
                "getgrnam",
                return_value=types.SimpleNamespace(gr_gid=os.getgid()),
            ),
        )
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_identity_is_exact_and_public_material_contains_no_private_key(self) -> None:
        identity = supervisor.new_identity()

        self.assertRegex(identity.supervisor_id, r"^[0-9a-f]{32}$")
        self.assertRegex(identity.private_key_hex, r"^[0-9a-f]{64}$")
        supervisor.materialize_public_key(identity)

        metadata = self.public_key.stat()
        self.assertEqual(metadata.st_mode & 0o777, 0o440)
        self.assertEqual(metadata.st_gid, os.getgid())
        raw = self.public_key.read_bytes()
        public = load_pem_public_key(raw)
        self.assertNotIn(identity.private_key_hex.encode(), raw)
        expected_public = Ed25519PrivateKey.from_private_bytes(
            bytes.fromhex(identity.private_key_hex)
        ).public_key()
        self.assertEqual(
            public.public_bytes(Encoding.Raw, PublicFormat.Raw),
            expected_public.public_bytes(Encoding.Raw, PublicFormat.Raw),
        )

    def test_request_assertion_is_canonical_short_lived_and_exactly_bound(self) -> None:
        identity = supervisor.new_identity()
        session = "v1:9999999999:0123456789abcdef:" + "a" * 64
        body = supervisor.json_body(b'{"team_name":"Marketing"}')
        model = supervisor.model_binding(("openai", "sk-test-0123456789"))

        encoded = supervisor.sign_request(
            identity,
            session,
            method="POST",
            path="/v1/teams/marketing/create",
            body=body,
            model=model,
            now=2_200_000_000,
        )

        header_segment, claims_segment, signature_segment = encoded.split(".")
        self.assertEqual(json.loads(_decode(header_segment)), contract.JWT_HEADER)
        claims = contract.canonical_claims(json.loads(_decode(claims_segment)))
        self.assertEqual(claims["sub"], identity.supervisor_id)
        self.assertEqual(claims["session_sha256"], hashlib.sha256(session.encode()).hexdigest())
        self.assertEqual(claims["exp"] - claims["iat"], contract.ASSERTION_MAX_TTL_SECONDS)
        self.assertEqual(claims["method"], "POST")
        self.assertEqual(claims["path"], "/v1/teams/marketing/create")
        self.assertEqual(claims["body"], body)
        self.assertEqual(claims["model"], model)
        public = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(identity.private_key_hex)).public_key()
        public.verify(
            _decode(signature_segment),
            f"{header_segment}.{claims_segment}".encode("ascii"),
        )

    def test_unsafe_public_key_and_incomplete_private_record_fail_closed(self) -> None:
        identity = supervisor.new_identity()
        self.public_key.symlink_to(Path(self.temporary.name) / "elsewhere")
        with self.assertRaises(supervisor.SupervisorAuthorityError):
            supervisor.materialize_public_key(identity)
        with self.assertRaises(supervisor.SupervisorAuthorityError):
            supervisor.identity_from_record({"supervisor_id": identity.supervisor_id})


if __name__ == "__main__":
    unittest.main()
