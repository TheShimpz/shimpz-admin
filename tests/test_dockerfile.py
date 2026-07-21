"""Delivery contracts for the minimal Admin production image."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UV_IMAGE = "ghcr.io/astral-sh/uv:0.11.25@sha256:1e3808aa9023d0980e7c15b1fa7c1ac16ff35925780cf5c459858b2d693f01a9"


class DockerfileDeliveryTests(unittest.TestCase):
    def test_build_context_excludes_local_dependencies_caches_and_secrets(self) -> None:
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
            "5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 AS ui",
            dockerfile,
        )

    def test_runtime_contains_only_the_resolved_virtual_environment(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        runtime = dockerfile.split(" AS runtime\n", 1)[1]

        self.assertIn(f"FROM {UV_IMAGE} AS uv", dockerfile)
        self.assertIn("COPY --from=uv /uv /usr/local/bin/uv", dockerfile)
        self.assertIn("COPY --from=dependencies /opt/venv /opt/venv", runtime)
        self.assertNotIn("uv-install.sh", dockerfile)
        self.assertNotIn("apt-get", runtime)
        self.assertNotIn("curl", runtime)
        self.assertNotIn("/usr/local/bin/uv", runtime)

    def test_runtime_copy_contains_every_backend_module(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        logical_lines = re.sub(r"\\\n\s*", " ", dockerfile).splitlines()
        runtime_copy = next(
            (line for line in logical_lines if line.startswith("COPY ") and "backend/app.py" in line),
            "",
        )
        copied = set(re.findall(r"\bbackend/[a-z][a-z0-9_]*\.py\b", runtime_copy))
        expected = {f"backend/{path.name}" for path in (ROOT / "backend").glob("*.py")}

        self.assertEqual(copied, expected)


if __name__ == "__main__":
    unittest.main()
