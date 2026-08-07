"""Local Supervisor identity, signing, and public-key custody contracts."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
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
        expected_public = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(identity.private_key_hex)).public_key()
        self.assertEqual(
            public.public_bytes(Encoding.Raw, PublicFormat.Raw),
            expected_public.public_bytes(Encoding.Raw, PublicFormat.Raw),
        )
        supervisor.materialize_public_key(identity)

    def test_request_assertion_is_canonical_short_lived_and_exactly_bound(self) -> None:
        identity = supervisor.new_identity()
        session = "v1:9999999999:0123456789abcdef:" + "a" * 64
        body = supervisor.json_body(b'{"team_name":"Marketing"}')
        model = supervisor.model_binding(("openai", "sk-test-0123456789"))

        encoded = supervisor.sign_request(
            identity,
            session,
            request=supervisor.RequestBinding(
                method="POST",
                path="/v1/teams/marketing/create",
                body=body,
                model=model,
                assurance={
                    "kind": "auth:reauth",
                    "challenge_id": "b" * 32,
                },
            ),
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
        self.assertEqual(
            claims["assurance"],
            {"kind": "auth:reauth", "challenge_id": "b" * 32},
        )
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

    def test_identity_evidence_and_record_shape_are_closed(self) -> None:
        identity = supervisor.new_identity()
        record = {
            "supervisor_id": identity.supervisor_id,
            "supervisor_signing_key": identity.private_key_hex,
        }
        self.assertEqual(
            supervisor.local_session_evidence(record, session_valid=True),
            {"profile": "local", "supervisor_id": identity.supervisor_id},
        )
        with self.assertRaises(supervisor.SupervisorAuthorityError):
            supervisor.identity_from_record(None)

    def test_public_key_helpers_reject_races_and_incomplete_writes(self) -> None:
        metadata = types.SimpleNamespace(
            st_mode=stat.S_IFREG | 0o440,
            st_nlink=1,
            st_gid=os.getgid(),
            st_size=1,
        )
        path = mock.Mock()
        path.lstat.return_value = metadata
        path.read_bytes.return_value = b"too-long"
        with self.assertRaisesRegex(supervisor.SupervisorAuthorityError, "changed while reading"):
            supervisor._safe_public_file(path, os.getgid())

        with (
            mock.patch.object(supervisor.os, "write", return_value=0),
            self.assertRaisesRegex(supervisor.SupervisorAuthorityError, "write was incomplete"),
        ):
            supervisor._write_all(1, b"key")

    def test_public_key_materialization_rejects_each_custody_failure(self) -> None:
        identity = supervisor.new_identity()
        with (
            mock.patch.object(supervisor.grp, "getgrnam", side_effect=KeyError("missing")),
            self.assertRaisesRegex(supervisor.SupervisorAuthorityError, "volume is unavailable"),
        ):
            supervisor.materialize_public_key(identity)

        unsafe_parent = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o770, st_gid=os.getgid())
        with (
            mock.patch.object(Path, "lstat", return_value=unsafe_parent),
            self.assertRaisesRegex(supervisor.SupervisorAuthorityError, "unsafe metadata"),
        ):
            supervisor.materialize_public_key(identity)

        unsafe_target = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o440, st_gid=os.getgid() + 1)
        with (
            mock.patch.object(supervisor.os, "fstat", return_value=unsafe_target),
            self.assertRaisesRegex(supervisor.SupervisorAuthorityError, "could not be materialized"),
        ):
            supervisor.materialize_public_key(identity)

        with (
            mock.patch.object(supervisor, "_safe_public_file", side_effect=[None, b"different"]),
            self.assertRaisesRegex(supervisor.SupervisorAuthorityError, "could not be materialized"),
        ):
            supervisor.materialize_public_key(identity)

        with (
            mock.patch.object(supervisor.os, "open", side_effect=OSError("denied")),
            self.assertRaisesRegex(supervisor.SupervisorAuthorityError, "could not be materialized"),
        ):
            supervisor.materialize_public_key(supervisor.new_identity())

        with (
            mock.patch.object(
                supervisor,
                "_write_all",
                side_effect=supervisor.SupervisorAuthorityError("incomplete"),
            ),
            self.assertRaisesRegex(supervisor.SupervisorAuthorityError, "could not be materialized"),
        ):
            supervisor.materialize_public_key(supervisor.new_identity())


if __name__ == "__main__":
    unittest.main()
