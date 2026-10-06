"""Pin and execute the generated Team HTTP protocol mirror."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import runpy
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1] / "backend" / "protocol" / "http"
EXPECTED_UPSTREAM = {
    "repository": "https://github.com/TheShimpz/shimpz-teams",
    "commit": "1e1c3d8465a2a7c449a1070f69fe735f68c23c4e",
    "path": "protocol/http/v1",
    "tree": "6c000cde0601ea8cbf1d73f8e3129e09344f173e",
    "contract_files_sha256": "f8d7ec18aa2bd57b2ca23fbb89fd193bc99fc885cf1be27e60eb25be1a2abaf8",
}


class TeamHttpProtocolTests(unittest.TestCase):
    def test_mirror_matches_pin_and_vectors(self) -> None:
        self.assertEqual(json.loads((ROOT / "upstream.json").read_bytes()), EXPECTED_UPSTREAM)
        manifest = (ROOT / "v1" / "contract-files.sha256").read_bytes()
        self.assertEqual(hashlib.sha256(manifest).hexdigest(), EXPECTED_UPSTREAM["contract_files_sha256"])
        subprocess.run([sys.executable, str(ROOT / "v1" / "verify.py")], check=True)

    def test_the_verifier_imports_the_mirrored_modules_flat_from_their_directory(self) -> None:
        names = (
            "identifiers",
            "payload",
            "progress",
            "purpose",
            "routine",
            "strict_json",
            "supervisor",
            "turn",
            "websocket",
        )
        saved = {name: sys.modules.pop(name) for name in names if name in sys.modules}
        output = io.StringIO()
        try:
            with mock.patch.object(sys, "path", [str(ROOT / "v1"), *sys.path]), contextlib.redirect_stdout(output):
                runpy.run_path(str(ROOT / "v1" / "verify.py"), run_name="admin_team_protocol_verifier")
        finally:
            for name in names:
                sys.modules.pop(name, None)
            sys.modules.update(saved)
        self.assertIn("golden vectors are valid", output.getvalue())


if __name__ == "__main__":
    unittest.main()
