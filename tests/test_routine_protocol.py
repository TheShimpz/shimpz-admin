"""Admin's mirror of Team's Routine protocol admits exactly Team's golden vectors (ADR-0086)."""

from __future__ import annotations

import json
import sys
import unittest
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from protocol.http.v1 import routine as routine_contract
from protocol.http.v1 import supervisor

VECTORS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())


class RoutineProtocolMirrorTests(unittest.TestCase):
    def test_every_routine_vector_family_is_admitted_exactly(self) -> None:
        families = {
            "routine_schedule": routine_contract.canonical_schedule,
            "routine_timezone": routine_contract.canonical_timezone,
            "routine_change": routine_contract.canonical_routine_change,
        }
        for family, admit in families.items():
            for value in VECTORS[family]["valid"]:
                with self.subTest(family=family, value=value):
                    self.assertEqual(admit(value), value)
            for value in VECTORS[family]["invalid"]:
                with self.subTest(family=family, value=value):
                    self.assertIsNone(admit(value))
        for case in VECTORS["routine_schedule"]["daily_rate"]:
            self.assertEqual(str(routine_contract.daily_rate(case["schedule"])), case["rate"])
        self.assertEqual(routine_contract.daily_rate({"kind": "hourly", "every": 5}), Fraction(24, 5))
        views = {
            "proposal": routine_contract.canonical_proposal,
            "preview": routine_contract.canonical_preview,
            "routine": routine_contract.canonical_routine_view,
            "run": routine_contract.canonical_run_view,
            "notice_batch": routine_contract.canonical_notice_batch,
            "claim": routine_contract.canonical_claim,
            "claim_request": routine_contract.canonical_claim_request,
        }
        for kind, admit in views.items():
            for value in VECTORS["routine_views"][kind]["valid"]:
                with self.subTest(kind=kind, value=value):
                    self.assertEqual(admit(value), value)
            for value in VECTORS["routine_views"][kind]["invalid"]:
                with self.subTest(kind=kind, value=value):
                    self.assertIsNone(admit(value))
            self.assertIsNone(admit(["not", "a", "view"]))

    def test_notice_details_are_closed_and_never_carry_action_data(self) -> None:
        valid = {
            "done": {"reply": "Updated."},
            "needs-input": {"question": "Which zone?"},
            "skipped": {"missed": 3},
            "scope-changed": {"assistants": ["dns"]},
            "failed": {"code": "assistant-rpc-failed", "actions": [["dns", "list-zones"]]},
            "denied": {"actions": []},
            "stopped": {"actions": [["dns", "list-zones"]]},
            "uncertain": {"actions": [["dns", "replace-dns-record"]]},
            "frozen": {"request_kind": "human", "assistant_id": "dns", "action": "replace-dns-record"},
        }
        self.assertEqual(set(valid), routine_contract.OUTCOMES)
        for outcome, detail in valid.items():
            self.assertEqual(routine_contract.canonical_notice_detail(outcome, detail), detail)
        for outcome, detail in (
            ("scope-changed", {"assistants": []}),
            ("scope-changed", {"assistants": ["Bad"]}),
            ("stopped", {"actions": [["dns", {"input": 1}]]}),
            ("stopped", {"actions": "dns"}),
            ("failed", {"code": "Bad Code", "actions": []}),
        ):
            with self.subTest(outcome=outcome, detail=detail):
                self.assertIsNone(routine_contract.canonical_notice_detail(outcome, detail))
        self.assertIsNone(routine_contract.canonical_notice_batch({"notices": ["x"], "more": False}))

    def test_routine_assertions_bind_no_human_authority(self) -> None:
        valid = VECTORS["local_routine"]["valid"][0]
        self.assertEqual(supervisor.canonical_claims(valid, audience=supervisor.ROUTINE_AUDIENCE), valid)
        for value in (
            {**valid, "assurance": {"kind": "auth:password", "challenge_id": "e" * 32}},
            {**valid, "authority": "session"},
        ):
            with self.subTest(value=value), self.assertRaises(supervisor.SupervisorAssertionError):
                supervisor.canonical_claims(value, audience=supervisor.ROUTINE_AUDIENCE)
