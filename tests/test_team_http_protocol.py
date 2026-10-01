"""Pin and execute the generated Team HTTP protocol mirror."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "backend" / "protocol" / "http"
EXPECTED_UPSTREAM = {
    "repository": "https://github.com/TheShimpz/shimpz-teams",
    "commit": "568263a02e15b50a9f23d87e4a846b99d4ac88d9",
    "path": "protocol/http/v1",
    "tree": "a19900b8427f192cf4bcf801036879c5be511ab5",
    "contract_files_sha256": "98c04e3f97abac46c13e962b15e753d37f2aa4c7691d3f697c87f8bf8c9c59cf",
}


class TeamHttpProtocolTests(unittest.TestCase):
    def test_mirror_matches_pin_and_vectors(self) -> None:
        self.assertEqual(json.loads((ROOT / "upstream.json").read_bytes()), EXPECTED_UPSTREAM)
        manifest = (ROOT / "v1" / "contract-files.sha256").read_bytes()
        self.assertEqual(hashlib.sha256(manifest).hexdigest(), EXPECTED_UPSTREAM["contract_files_sha256"])
        subprocess.run([sys.executable, str(ROOT / "v1" / "verify.py")], check=True)


if __name__ == "__main__":
    unittest.main()
