"""Delivery contracts for the minimal Admin production image."""

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
            "3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0 AS ui",
            dockerfile,
        )

    def test_static_runtime_contains_only_the_resolved_virtual_environment(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        runtime = dockerfile.split(" AS runtime\n", 1)[1]

        self.assertIn(f"FROM {UV_IMAGE} AS uv", dockerfile)
        self.assertIn("--mount=type=bind,from=uv,source=/uv,target=/tmp/uv", dockerfile)
        self.assertIn("\nFROM dependencies AS runtime\n", dockerfile)
        self.assertNotIn("apt-get", runtime)
        self.assertNotIn("curl", runtime)
        self.assertNotIn("/usr/local/bin/uv", runtime)

    def test_static_runtime_derives_from_an_epoch_free_dependency_layer(self) -> None:
        # Shimpz ADR-0098: no commit-time input reaches the dependency layer, so an unchanged lock reuses its bytes.
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        stages = dict(re.findall(r"(?ms)^FROM (?:--platform=\S+ )?\S+ AS (\w+)\n(.*?)(?=^FROM |\Z)", dockerfile))
        self.assertEqual(["dependencies", "runtime", "ui", "uv"], sorted(stages))
        for stage in ("uv", "dependencies"):
            with self.subTest(stage=stage):
                self.assertNotRegex(stages[stage], r"(?m)^(ARG SOURCE_DATE_EPOCH|WORKDIR|COPY|ADD)\b")
        recipe = "\n".join(line for line in stages["dependencies"].splitlines() if not line.startswith("#"))
        dependencies = re.sub(r"\\\n\s*", " ", recipe)
        for mount in (
            "--mount=type=tmpfs,target=/tmp",
            "--mount=type=bind,source=pyproject.toml,target=/tmp/project/pyproject.toml",
            "--mount=type=bind,source=uv.lock,target=/tmp/project/uv.lock",
        ):
            self.assertIn(mount, dependencies)
        self.assertIn("uv sync --frozen --no-install-project --no-dev --python 3.14", dependencies)
        self.assertTrue(dependencies.rstrip().endswith("find /opt -depth -exec touch -h -d @0 {} +"))
        # The base ships no bytecode; the standard library and environment are compiled once, content-addressed.
        self.assertIn(
            "compileall -q -f --invalidation-mode checked-hash /usr/local/lib/python3.14 /opt/venv", dependencies
        )
        self.assertIn("compileall -q -f --invalidation-mode checked-hash /app/backend", stages["runtime"])
        # The UI build keeps the commit-bound epoch that names its SvelteKit version, declared only after the package
        # install, so an unchanged lock reuses the installed packages at every commit.
        self.assertRegex(stages["ui"], r"(?m)^ARG SOURCE_DATE_EPOCH=0$")
        # BuildKit stamps a WORKDIR with the epoch, so neither precedes the install.
        install = stages["ui"].index("RUN cd /w && corepack pnpm install --frozen-lockfile --ignore-scripts ")
        self.assertNotRegex(stages["ui"][:install], r"(?m)^(ARG SOURCE_DATE_EPOCH|WORKDIR)\b")
        self.assertLess(stages["ui"].index("ARG SOURCE_DATE_EPOCH=0"), stages["ui"].index("RUN corepack pnpm build"))

    def test_runtime_image_packages_the_password_blocklist(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

        self.assertIn("COPY --link backend/signin/blocklist/passwords.txt ./signin/blocklist/", dockerfile)

    def test_runtime_keeps_one_process_for_memory_bound_mfa_ceremonies(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        command = dockerfile.split('CMD ["uvicorn"', 1)[1]

        self.assertIn('"--workers", "1"', command)

    def test_static_runtime_copy_contains_every_application_backend_module(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        runtime = dockerfile.split(" AS runtime\n", 1)[1]
        copied = set(re.findall(r"\bbackend(?:/[a-z][a-z0-9_]*)+\.py\b", re.sub(r"\\\n\s*", " ", runtime)))
        expected = {path.relative_to(ROOT).as_posix() for path in (ROOT / "backend").rglob("*.py")}
        expected.remove("backend/protocol/http/v1/verify.py")
        # The blocklist generator is a maintainer tool; the image carries only the list it writes.
        expected.remove("backend/signin/blocklist/generate.py")

        self.assertEqual(copied, expected)


if __name__ == "__main__":
    unittest.main()
