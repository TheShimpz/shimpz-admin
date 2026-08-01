"""Delivery contracts for the minimal Admin production image."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UV_IMAGE = "ghcr.io/astral-sh/uv:0.12.1@sha256:cf4eedcaa81655197f625739489effcbe71b61ceb1506f332c3facae5deceded"


class StaticDockerfileDeliveryTests(unittest.TestCase):
    def test_static_build_context_excludes_local_dependencies_caches_and_secrets(self) -> None:
        dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()

        self.assertLessEqual(
            {
                ".git",
                ".env",
                ".env.*",
                "**/.env",
                "**/.env.*",
                ".venv",
                "**/__pycache__",
                "**/*.pyc",
                "frontend/.svelte-kit",
                "frontend/build",
                "frontend/build.root-owned",
                "frontend/node_modules",
            },
            set(dockerignore),
        )

    def test_static_ui_build_uses_the_native_builder_platform(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

        self.assertIn(
            "FROM --platform=$BUILDPLATFORM node:24-bookworm@sha256:"
            "19cd848a0e073d34bd8cd5545a1b6b4d28489b3e3b607366621ced442bd5f6b4 AS ui",
            dockerfile,
        )

    def test_static_runtime_contains_only_the_resolved_virtual_environment(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        runtime = dockerfile.split(" AS runtime\n", 1)[1]

        self.assertIn(f"FROM {UV_IMAGE} AS uv", dockerfile)
        self.assertIn("COPY --from=uv /uv /usr/local/bin/uv", dockerfile)
        self.assertIn("COPY --from=dependencies /opt/venv /opt/venv", runtime)
        self.assertNotIn("uv-install.sh", dockerfile)
        self.assertNotIn("apt-get", runtime)
        self.assertNotIn("curl", runtime)
        self.assertNotIn("/usr/local/bin/uv", runtime)

    def test_static_runtime_copy_contains_every_application_backend_module(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        runtime = dockerfile.split(" AS runtime\n", 1)[1]
        copied = set(re.findall(r"\bbackend(?:/[a-z][a-z0-9_]*)+\.py\b", re.sub(r"\\\n\s*", " ", runtime)))
        expected = {path.relative_to(ROOT).as_posix() for path in (ROOT / "backend").rglob("*.py")}
        expected.remove("backend/protocol/http/v1/verify.py")
        expected.remove("backend/protocol/account/admin-session/v1/verify.py")

        self.assertEqual(copied, expected)


if __name__ == "__main__":
    unittest.main()
