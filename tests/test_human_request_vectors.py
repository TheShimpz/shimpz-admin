"""Run the Developers human-request vectors through Admin's browser challenge projection.

Admin never holds the reviewed message catalog, so a request whose only fault is relative to that catalog (an
undeclared message, a message wider than its field, or parameters that differ from the declaration) is Team's to
refuse; every other published refusal is Admin's too (ADR-0091).
"""

from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from tests.localized_request import localization, rendered_for

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
        **localization(rendered_for(request)),
        "trace_id": "a" * 32,
    }


# The published refusals that only the reviewed catalog can decide; each keeps a reference shape Admin admits.
CATALOG_BOUND_REFUSALS = frozenset(
    {
        "reject_undeclared_message",
        "reject_description_bound_in_title",
        "reject_missing_param",
        "reject_extra_param",
        "reject_param_on_static_message",
        "reject_uppercase_domain",
        "reject_single_label_domain",
        "reject_overlong_domain",
        "reject_integer_over_length",
        "reject_string_integer",
        "reject_option_label_bound",
    }
)


class HumanRequestVectorTests(unittest.TestCase):
    def test_projection_admits_exactly_the_published_request_cases(self) -> None:
        for case in VECTORS["request_cases"]:
            with self.subTest(case=case["name"]):
                if case["valid"] or case["name"] in CATALOG_BOUND_REFUSALS:
                    projected = human.project(_challenge(case["request"]), "team_1")
                    self.assertEqual(projected["request"]["kind"], case["request"]["kind"])
                    self.assertEqual(projected["request"].get("stored_input"), case["request"].get("stored_input"))
                else:
                    with self.assertRaises(human.HumanChallengeError):
                        human.project(_challenge(case["request"]), "team_1")

    def test_only_catalog_relative_refusals_are_left_to_team(self) -> None:
        cases = {case["name"]: case for case in VECTORS["request_cases"]}
        self.assertLessEqual(CATALOG_BOUND_REFUSALS, set(cases))
        for name in CATALOG_BOUND_REFUSALS:
            with self.subTest(case=name):
                self.assertFalse(cases[name]["valid"])
                self.assertIn(cases[name]["error"], {"copy_reference", "copy_bound", "copy_params"})

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
