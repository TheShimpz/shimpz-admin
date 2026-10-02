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
    "commit": "0a8c135abd4b77475fb317ad883f6fc268e07457",
    "path": "protocol/http/v1",
    "tree": "55e81431a630257628fa6df8a330db2afb6b4d9c",
    "contract_files_sha256": "f0400b5b108a9d04bfb4fa7f261bde2de906bd565a1b3640bd40267ba534fd7b",
}


class TeamHttpProtocolTests(unittest.TestCase):
    def test_mirror_matches_pin_and_vectors(self) -> None:
        self.assertEqual(json.loads((ROOT / "upstream.json").read_bytes()), EXPECTED_UPSTREAM)
        manifest = (ROOT / "v1" / "contract-files.sha256").read_bytes()
        self.assertEqual(hashlib.sha256(manifest).hexdigest(), EXPECTED_UPSTREAM["contract_files_sha256"])
        subprocess.run([sys.executable, str(ROOT / "v1" / "verify.py")], check=True)


if __name__ == "__main__":
    unittest.main()
