"""Pin and execute the Account-owned Admin-session protocol mirror."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "backend" / "protocol" / "account" / "admin-session"
EXPECTED_UPSTREAM = {
    "repository": "https://github.com/TheShimpz/shimpz-account",
    "commit": "51d7a73a59422bb0905a69bb2f19108d2d9c1887",
    "path": "protocol/admin-session/v1",
    "tree": "87450005eeef5a9966c7c8e56f8aca851847b9f0",
    "contract_files_sha256": "4a5ab98722618f6fb1f07d5bd527bd42932d99984bc4d36edaa2524cee357ba9",
}


class AccountSessionProtocolTests(unittest.TestCase):
    def test_mirror_pins_and_executes_the_exact_producer_contract(self) -> None:
        self.assertEqual(json.loads((ROOT / "upstream.json").read_bytes()), EXPECTED_UPSTREAM)
        manifest = ROOT / "v1" / "contract-files.sha256"
        self.assertEqual(
            hashlib.sha256(manifest.read_bytes()).hexdigest(),
            EXPECTED_UPSTREAM["contract_files_sha256"],
        )
        result = subprocess.run(
            [sys.executable, "verify.py"],
            cwd=ROOT / "v1",
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "Account Admin-session protocol v1 verified")


if __name__ == "__main__":
    unittest.main()
