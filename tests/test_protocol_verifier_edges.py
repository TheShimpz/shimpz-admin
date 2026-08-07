"""Executable conformance coverage for Admin's vendored protocol verifiers."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import pathlib
import runpy
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1] / "backend/protocol"
ACCOUNT = ROOT / "account/admin-session/v1"
HTTP = ROOT / "http/v1"


@contextlib.contextmanager
def _fresh_modules(*names: str):
    saved = {name: sys.modules.pop(name) for name in names if name in sys.modules}
    try:
        yield
    finally:
        for name in names:
            sys.modules.pop(name, None)
        sys.modules.update(saved)


def _execute(source: Path, mutate=None, *, modules: dict[str, object] | None = None) -> str:
    with tempfile.TemporaryDirectory() as temporary:
        mirror = Path(temporary) / source.parent.name
        shutil.copytree(source.parent, mirror)
        if mutate is not None:
            mutate(mirror)
        output = io.StringIO()

        def redirected_path(value) -> Path:
            path = Path(value)
            return mirror / source.name if path.resolve() == source.resolve() else path

        module_names = ("payload", "progress", "supervisor", "websocket")
        with (
            _fresh_modules(*module_names),
            mock.patch.object(sys, "path", [str(mirror), *sys.path]),
            mock.patch.dict(sys.modules, modules or {}),
            mock.patch.object(pathlib, "Path", redirected_path),
            contextlib.redirect_stdout(output),
        ):
            runpy.run_path(str(source), run_name="protocol_verifier")
        return output.getvalue()


def _rewrite_json(root: Path, filename: str, mutate) -> None:
    path = root / filename
    value = json.loads(path.read_bytes())
    mutate(value)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    manifest = root / "contract-files.sha256"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    rows = manifest.read_text(encoding="ascii").splitlines()
    manifest.write_text(
        "\n".join(f"{digest}  {filename}" if row.endswith(f"  {filename}") else row for row in rows) + "\n",
        encoding="ascii",
    )


class AccountAdminSessionVerifierEdgeTests(unittest.TestCase):
    def test_accepts_the_current_pinned_authority(self) -> None:
        self.assertIn("verified", _execute(ACCOUNT / "verify.py"))

    def test_rejects_inventory_digest_schema_and_envelope_drift(self) -> None:
        mutations = (
            lambda root: (root / "contract-files.sha256").write_text("", encoding="ascii"),
            lambda root: (root / "README.md").write_text("drift", encoding="utf-8"),
            lambda root: _rewrite_json(
                root,
                "introspection-request.schema.json",
                lambda value: value.update({"$schema": "draft"}),
            ),
            lambda root: _rewrite_json(
                root,
                "introspection-response.schema.json",
                lambda value: value.update({"$id": "invalid"}),
            ),
            lambda root: _rewrite_json(root, "vectors.json", lambda value: value.update({"version": 2})),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(SystemExit):
                _execute(ACCOUNT / "verify.py", mutate)

    def test_rejects_each_closed_request_and_response_vector_violation(self) -> None:
        def request_shape(value: dict[str, object]) -> None:
            value["vectors"][0]["request"]["extra"] = True

        def request_value(value: dict[str, object]) -> None:
            value["vectors"][0]["request"]["version"] = True

        def response_value(value: dict[str, object]) -> None:
            value["vectors"][0]["response"]["active"] = "yes"

        def response_shape(value: dict[str, object]) -> None:
            value["vectors"][0]["response"]["extra"] = True

        def active_identity(value: dict[str, object]) -> None:
            active = next(vector for vector in value["vectors"] if vector["response"]["active"])
            active["response"]["account_id"] = "bad"

        for mutate in (request_shape, request_value, response_value, response_shape, active_identity):
            with self.subTest(mutate=mutate), self.assertRaises(SystemExit):
                _execute(
                    ACCOUNT / "verify.py",
                    lambda root, mutation=mutate: _rewrite_json(root, "vectors.json", mutation),
                )


class TeamHttpVerifierEdgeTests(unittest.TestCase):
    def test_accepts_the_current_pinned_protocol(self) -> None:
        self.assertIn("golden vectors are valid", _execute(HTTP / "verify.py"))

    def test_rejects_manifest_inventory_digest_root_and_header_drift(self) -> None:
        def malformed_row(root: Path) -> None:
            (root / "contract-files.sha256").write_text("invalid\n", encoding="ascii")

        def remove_row(root: Path) -> None:
            manifest = root / "contract-files.sha256"
            rows = manifest.read_text(encoding="ascii").splitlines()
            manifest.write_text("\n".join(rows[1:]) + "\n", encoding="ascii")

        mutations = (
            malformed_row,
            remove_row,
            lambda root: (root / "README.md").write_text("drift", encoding="utf-8"),
            lambda root: _rewrite_json(root, "vectors.json", lambda value: value.update({"version": 2})),
            lambda root: _rewrite_json(root, "vectors.json", lambda value: value.update({"headers": {}})),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(SystemExit):
                _execute(HTTP / "verify.py", mutate)

    def test_rejects_each_golden_vector_family_when_its_expected_outcome_drifts(self) -> None:
        def flip_case(section: str, *, valid: bool):
            def mutate(value: dict[str, object]) -> None:
                case = next(item for item in value[section] if item["valid"] is valid)
                case["valid"] = not valid

            return mutate

        mutations = (
            flip_case("frames", valid=True),
            flip_case("frames", valid=False),
            flip_case("human_response_frames", valid=True),
            flip_case("human_response_frames", valid=False),
            flip_case("chat_stream", valid=True),
            flip_case("chat_stream", valid=False),
            flip_case("chat_stream_lines", valid=True),
            flip_case("chat_stream_lines", valid=False),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(SystemExit):
                _execute(
                    HTTP / "verify.py",
                    lambda root, mutation=mutate: _rewrite_json(root, "vectors.json", mutation),
                )

    def test_rejects_supervisor_and_identifier_vector_drift(self) -> None:
        def accepted_supervisor(value: dict[str, object]) -> None:
            value["local_supervisor"]["invalid"] = [value["local_supervisor"]["valid"][0]]

        def invalid_positive_identifier(value: dict[str, object]) -> None:
            value["identifiers"]["team"]["valid"] = ["Bad"]

        def valid_negative_identifier(value: dict[str, object]) -> None:
            value["identifiers"]["assistant"]["invalid"] = ["assistant"]

        for mutate in (accepted_supervisor, invalid_positive_identifier, valid_negative_identifier):
            with self.subTest(mutate=mutate), self.assertRaises(SystemExit):
                _execute(
                    HTTP / "verify.py",
                    lambda root, mutation=mutate: _rewrite_json(root, "vectors.json", mutation),
                )

    def test_rejects_positive_supervisor_vectors_that_are_not_canonical(self) -> None:
        from backend.protocol.http.v1 import supervisor

        fake = types.ModuleType("supervisor")
        fake.ASSERTION_HEADER = supervisor.ASSERTION_HEADER
        fake.SupervisorAssertionError = supervisor.SupervisorAssertionError
        fake.canonical_claims = lambda _value: {}
        with self.assertRaises(SystemExit):
            _execute(HTTP / "verify.py", modules={"supervisor": fake})


if __name__ == "__main__":
    unittest.main()
