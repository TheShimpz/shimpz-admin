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
    "commit": "13cc1a5e297747ff96237f39d32d2a381400f9cb",
    "path": "protocol/http/v1",
    "tree": "de0209e68d55e8f0a85d8d10d49e14a4e3acae64",
    "contract_files_sha256": "43d589ca86c0a99c3030c9042a9de07ec8fcf1a5bde8b6e9e4e24308c140caa2",
}


class TeamHttpProtocolTests(unittest.TestCase):
    def test_mirror_matches_pin_and_vectors(self) -> None:
        self.assertEqual(json.loads((ROOT / "upstream.json").read_bytes()), EXPECTED_UPSTREAM)
        manifest = (ROOT / "v1" / "contract-files.sha256").read_bytes()
        self.assertEqual(hashlib.sha256(manifest).hexdigest(), EXPECTED_UPSTREAM["contract_files_sha256"])
        subprocess.run([sys.executable, str(ROOT / "v1" / "verify.py")], check=True)


if __name__ == "__main__":
    unittest.main()
