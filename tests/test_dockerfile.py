"""Delivery contracts for the minimal Admin production image."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class DockerfileDeliveryTests(unittest.TestCase):
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
