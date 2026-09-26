"""Run the Developers human-request vectors through Admin's browser challenge projection."""

from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import human

VECTORS = json.loads((ROOT / "backend" / "protocol" / "assistant" / "human-request-vectors.json").read_bytes())


def _fingerprint(request: dict[str, object]) -> str:
    canonical = json.dumps(request, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _challenge(request: dict[str, object]) -> dict[str, object]:
    return {
        "team_id": "team_1",
        "status": "human-required",
        "turn_id": "b" * 32,
        "challenge_id": "b" * 32,
        "expires_in": 300,
        "assistant": {"id": "shimpz-cloudflare", "name": "Shimpz Cloudflare", "version": "0.4.1"},
        "action": {"id": "list-zones", "summary": "List reviewed Cloudflare zones."},
        "request": {**request, "fingerprint": _fingerprint(request)},
        "trace_id": "a" * 32,
    }


class HumanRequestVectorTests(unittest.TestCase):
    def test_projection_admits_exactly_the_published_request_cases(self) -> None:
        for case in VECTORS["request_cases"]:
            with self.subTest(case=case["name"]):
                if case["valid"]:
                    projected = human.project(_challenge(case["request"]), "team_1")
                    self.assertEqual(projected["request"]["kind"], case["request"]["kind"])
                    self.assertEqual(projected["request"].get("stored_input"), case["request"].get("stored_input"))
                else:
                    with self.assertRaises(human.HumanChallengeError):
                        human.project(_challenge(case["request"]), "team_1")

    def test_projection_fingerprint_matches_the_published_serialization(self) -> None:
        for case in VECTORS["fingerprint"]["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(_fingerprint(case["request"]), case["sha256"])
                self.assertTrue(human._fingerprint(case["request"], case["sha256"]))

    def test_projection_knows_every_published_capability(self) -> None:
        known = {"approval", *human.LENGTH_KINDS, *human.CHOICE_KINDS, "input:choices", *human.AUTH_KINDS}
        self.assertEqual(set(VECTORS["capabilities"]), known)


if __name__ == "__main__":
    unittest.main()
