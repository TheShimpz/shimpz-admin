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
    "commit": "e1dc2bab8b7d6cbf7154d3f5c958f0ade7ca0d38",
    "path": "protocol/http/v1",
    "tree": "815c36ea27c8ca5dac97cf199d48cc1d745168cb",
    "contract_files_sha256": "4946d9b42ed2d4d45a25464f81c64b634ea982080dcf89706f49e4508902816c",
}


class TeamHttpProtocolTests(unittest.TestCase):
    def test_mirror_matches_pin_and_vectors(self) -> None:
        self.assertEqual(json.loads((ROOT / "upstream.json").read_bytes()), EXPECTED_UPSTREAM)
        manifest = (ROOT / "v1" / "contract-files.sha256").read_bytes()
        self.assertEqual(hashlib.sha256(manifest).hexdigest(), EXPECTED_UPSTREAM["contract_files_sha256"])
        subprocess.run([sys.executable, str(ROOT / "v1" / "verify.py")], check=True)


if __name__ == "__main__":
    unittest.main()
