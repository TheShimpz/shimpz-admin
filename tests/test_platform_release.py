import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import platform_release


class PlatformReleaseStatusTests(unittest.TestCase):
    def _status(self, mutate=None, *, mode: int = 0o600) -> Path:
        document = {
            "release": f"ghcr.io/theshimpz/shimpz-local-release@sha256:{'a' * 64}",
            "ordinal": 42,
            "checked_at": "2026-08-08T22:52:21Z",
            "outcome": "updated",
        }
        if mutate is not None:
            mutate(document)
        path = Path(self.directory.name) / "status.json"
        path.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
        path.chmod(mode)
        return path

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_reads_only_the_closed_non_secret_status(self) -> None:
        path = self._status()
        self.assertEqual(platform_release.read_status(path)["ordinal"], 42)

    def test_rejects_malformed_or_widened_status(self) -> None:
        mutations = (
            lambda value: value.update({"token": "secret"}),
            lambda value: value.update({"release": "ghcr.io/example/release@sha256:" + "a" * 64}),
            lambda value: value.update({"ordinal": True}),
            lambda value: value.update({"ordinal": 0}),
            lambda value: value.update({"checked_at": "tomorrow"}),
            lambda value: value.update({"checked_at": "2026-13-08T22:52:21Z"}),
            lambda value: value.update({"outcome": "installing"}),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(platform_release.PlatformReleaseUnavailableError):
                platform_release.read_status(self._status(mutate))

    def test_rejects_loose_permissions_symlinks_and_oversized_files(self) -> None:
        with self.assertRaises(platform_release.PlatformReleaseUnavailableError):
            platform_release.read_status(self._status(mode=0o644))
        target = self._status()
        link = target.with_name("status-link.json")
        link.symlink_to(target)
        with self.assertRaises(platform_release.PlatformReleaseUnavailableError):
            platform_release.read_status(link)
        oversized = target.with_name("oversized.json")
        oversized.write_bytes(b"{" + os.urandom(platform_release.MAX_STATUS_BYTES) + b"}")
        oversized.chmod(0o600)
        with self.assertRaises(platform_release.PlatformReleaseUnavailableError):
            platform_release.read_status(oversized)

    def test_rejects_open_read_and_file_identity_failures(self) -> None:
        missing = Path(self.directory.name) / "missing.json"
        with self.assertRaises(platform_release.PlatformReleaseUnavailableError):
            platform_release.read_status(missing)

        directory = Path(self.directory.name) / "directory"
        directory.mkdir()
        with self.assertRaises(platform_release.PlatformReleaseUnavailableError):
            platform_release.read_status(directory)

        empty = Path(self.directory.name) / "empty.json"
        empty.touch(mode=0o600)
        with self.assertRaises(platform_release.PlatformReleaseUnavailableError):
            platform_release.read_status(empty)

        status = self._status()
        with (
            mock.patch.object(platform_release.os, "geteuid", return_value=os.geteuid() + 1),
            self.assertRaises(platform_release.PlatformReleaseUnavailableError),
        ):
            platform_release.read_status(status)
        with (
            mock.patch.object(platform_release.os, "read", return_value=b"{}"),
            self.assertRaises(platform_release.PlatformReleaseUnavailableError),
        ):
            platform_release.read_status(status)

    def test_rejects_invalid_json_and_utf8(self) -> None:
        for index, payload in enumerate((b"{", b'"\xff"')):
            path = Path(self.directory.name) / f"invalid-{index}.json"
            path.write_bytes(payload)
            path.chmod(0o600)
            with self.subTest(payload=payload), self.assertRaises(platform_release.PlatformReleaseUnavailableError):
                platform_release.read_status(path)


if __name__ == "__main__":
    unittest.main()
