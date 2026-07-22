"""Behavioral contracts for Admin configuration storage and validation."""

from __future__ import annotations

import errno
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import envfile
import keyset
import validate_live


class ConfigurationTests(unittest.TestCase):
    def test_internal_generation_is_idempotent(self) -> None:
        generated = keyset.generate_internal({})

        self.assertEqual(set(generated), {"POSTGRES_PASSWORD"})
        self.assertGreaterEqual(len(generated["POSTGRES_PASSWORD"]), 24)
        self.assertEqual(keyset.generate_internal(generated), {})

    def test_field_lookup_is_exact(self) -> None:
        self.assertEqual(keyset.field("POSTGRES_PASSWORD")["group"], "internal")
        for invalid in ("TOTALLY_UNKNOWN", "postgres_password"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                keyset.field(invalid)

    def test_envfile_roundtrip_preserves_unmanaged_values_and_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            envfile.write(path, {"KASM_PASSWORD": "a" * 32, "SOME_HAND_ADDED_KEY": "keep-me"})

            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            stored = envfile.read(path)
            self.assertEqual(stored["KASM_PASSWORD"], "a" * 32)
            self.assertEqual(stored["SOME_HAND_ADDED_KEY"], "keep-me")
            self.assertEqual(envfile.read(Path(directory) / "missing.env"), {})

    def test_legacy_root_credentials_fail_without_echoing_the_secret(self) -> None:
        secret = "legacy-value-that-must-never-be-logged"
        with tempfile.TemporaryDirectory() as directory:
            for key in sorted(envfile.LEGACY_ROOT_BRAIN_CREDENTIALS):
                with self.subTest(key=key):
                    path = Path(directory) / f"{key}.env"
                    path.write_text(f"{key}={secret}\n", encoding="utf-8")
                    with self.assertRaises(envfile.LegacyRootCredentialError) as raised:
                        envfile.read(path)
                    self.assertIn(key, str(raised.exception))
                    self.assertNotIn(secret, str(raised.exception))
                    with self.assertRaises(envfile.LegacyRootCredentialError):
                        envfile.render({key: secret})

    def test_merge_never_erases_and_mask_never_reveals_a_value(self) -> None:
        existing = {"KASM_PASSWORD": "a" * 32}
        with self.assertRaises(ValueError):
            envfile.merge(existing, {"EVIL_KEY": "x"})

        merged = envfile.merge(existing, {"KASM_PASSWORD": "  ", "KASM_USER": "operator"})
        self.assertEqual(merged["KASM_PASSWORD"], "a" * 32)
        self.assertEqual(merged["KASM_USER"], "operator")
        self.assertEqual(envfile.mask("supersecrettoken123"), "••••n123")
        self.assertEqual(envfile.mask("short"), "••••")
        self.assertEqual(envfile.mask("  "), "")

    def test_validators_enforce_required_and_declared_formats(self) -> None:
        self.assertTrue(validate_live.validate("DOCKER_GID", "989")[0])
        self.assertFalse(validate_live.validate("DOCKER_GID", "group")[0])
        self.assertFalse(validate_live.validate("POSTGRES_PASSWORD", "")[0])
        self.assertTrue(validate_live.validate("KASM_PASSWORD", "")[0])
        with self.assertRaises(ValueError):
            validate_live.validate("NOPE", "x")

    def test_envfile_falls_back_to_an_in_place_rewrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for method, error in (("replace", errno.EBUSY), ("write_text", errno.EROFS)):
                with self.subTest(method=method):
                    path = Path(directory) / f"env-{method}"
                    path.write_text("PLACEHOLDER=1\n", encoding="utf-8")
                    path.chmod(0o600)
                    original = getattr(Path, method)

                    def blocked(
                        instance,
                        *args,
                        target=path,
                        injected_error=error,
                        original_method=original,
                        **kwargs,
                    ):
                        if instance in (target, target.with_suffix(".tmp")):
                            raise OSError(injected_error, "injected container filesystem error")
                        return original_method(instance, *args, **kwargs)

                    with mock.patch.object(Path, method, blocked):
                        envfile.write(
                            path,
                            {"KASM_PASSWORD": "a" * 32, "SOME_HAND_ADDED_KEY": "keep-me"},
                        )

                    stored = envfile.read(path)
                    self.assertEqual(stored["KASM_PASSWORD"], "a" * 32)
                    self.assertEqual(stored["SOME_HAND_ADDED_KEY"], "keep-me")
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    self.assertFalse(path.with_suffix(".tmp").exists())


if __name__ == "__main__":
    unittest.main()
