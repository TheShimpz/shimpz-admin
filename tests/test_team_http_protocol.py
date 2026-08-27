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
    "commit": "7a9ce9509c3c887d060a9eb51114ba8ef250e0ac",
    "path": "protocol/http/v1",
    "tree": "cf68ec891cc4bc5cca6334706f8b4809d38c6851",
    "contract_files_sha256": "ab1bd405b054e08a71c198bd7b6df6b07f12191b089b574f590c98d088e8ce1c",
}


class TeamHttpProtocolTests(unittest.TestCase):
    def test_mirror_matches_pin_and_vectors(self) -> None:
        self.assertEqual(json.loads((ROOT / "upstream.json").read_bytes()), EXPECTED_UPSTREAM)
        manifest = (ROOT / "v1" / "contract-files.sha256").read_bytes()
        self.assertEqual(hashlib.sha256(manifest).hexdigest(), EXPECTED_UPSTREAM["contract_files_sha256"])
        subprocess.run([sys.executable, str(ROOT / "v1" / "verify.py")], check=True)


if __name__ == "__main__":
    unittest.main()
