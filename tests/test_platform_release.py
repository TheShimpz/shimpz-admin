import json
import os
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
