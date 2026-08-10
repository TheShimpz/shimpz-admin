"""Static manifest contract for the installed Admin semantic version."""

from __future__ import annotations

import json
import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEMANTIC_VERSION_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")


class AdminVersionStaticContractTests(unittest.TestCase):
    def test_static_admin_manifests_share_one_semantic_version(self) -> None:
        pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))

        backend_version = pyproject["project"]["version"]
        frontend_version = package["version"]

        self.assertIsNotNone(SEMANTIC_VERSION_RE.fullmatch(backend_version))
        self.assertEqual(frontend_version, backend_version)


if __name__ == "__main__":
    unittest.main()
