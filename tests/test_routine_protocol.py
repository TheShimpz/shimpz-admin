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
DEFINED = {
    "name": "Weekly zones",
    "steps": [
        {
            "id": "zones",
            "assistant": "dns",
            "action": "list-zones",
            "inputs": [{"member": "page", "source": "literal", "value": "1"}],
            "stored_inputs": [],
        }
    ],
    "schedule": {"kind": "daily", "time": "09:00"},
    "timezone": "UTC",
}


class RoutineProtocolMirrorTests(unittest.TestCase):
    def test_every_routine_vector_family_is_admitted_exactly(self) -> None:
        families = {
            "routine_schedule": routine_contract.canonical_schedule,
            "routine_timezone": routine_contract.canonical_timezone,
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
        # A Routine's rolling cap is its whole daily rate, and its mode says how its runs are claimed.
        self.assertEqual(routine_contract.daily_cap({"kind": "hourly", "every": 5}), 5)
        self.assertEqual(routine_contract.daily_cap({"kind": "continuous", "gap": 5, "cap": 300}), 300)
        self.assertEqual(routine_contract.run_mode({"kind": "continuous", "gap": 5, "cap": 300}), "continuous")
        self.assertEqual(routine_contract.run_mode({"kind": "daily", "time": "09:00"}), "scheduled")
        views = {
            "routine": routine_contract.canonical_routine_view,
            "run": routine_contract.canonical_run_view,
            "notice_batch": routine_contract.canonical_notice_batch,
            "claim": routine_contract.canonical_claim,
            "claim_request": routine_contract.canonical_claim_request,
            "incident": routine_contract.canonical_incident_view,
            "card": routine_contract.canonical_card,
            "card_answer_request": routine_contract.canonical_card_answer_request,
            "card_answer": routine_contract.canonical_card_answer,
            "segment_request": routine_contract.canonical_segment_request,
        }
        for kind, admit in views.items():
            for value in VECTORS["routine_views"][kind]["valid"]:
                with self.subTest(kind=kind, value=value):
                    self.assertEqual(admit(value), value)
            for value in VECTORS["routine_views"][kind]["invalid"]:
                with self.subTest(kind=kind, value=value):
                    self.assertIsNone(admit(value))
            self.assertIsNone(admit(["not", "a", "view"]))

    def test_run_diagnostics_admit_exactly_the_golden_vectors(self) -> None:
        for value in VECTORS["routine_diagnostics"]["valid"]:
            with self.subTest(value=value):
                self.assertEqual(routine_contract.canonical_diagnostics(value), value)
        for value in VECTORS["routine_diagnostics"]["invalid"]:
            with self.subTest(value=value):
                self.assertIsNone(routine_contract.canonical_diagnostics(value))
        self.assertIsNone(routine_contract.canonical_failure([]))
        self.assertIsNone(routine_contract.canonical_diagnostic([]))
        self.assertFalse(routine_contract._diagnostic_text("lone \ud800 surrogate"))
        self.assertFalse(routine_contract._diagnostic_text(7))

    def test_notice_details_are_closed_and_never_carry_action_data(self) -> None:
        valid = {
            "done": {"actions": [["dns", "list-zones"]]},
            "recovered": {"actions": [["dns", "replace-dns-record"]]},
            "held": {"assistant_id": "dns", "action": "replace-dns-record"},
            "paused": {"assistant_id": "dns", "action": "replace-dns-record", "reason": "person"},
            "user-skipped": {"assistant_id": None, "action": None},
            "skipped": {"missed": 3},
            "scope-changed": {"assistants": ["dns"]},
            "failed": {"code": "assistant-rpc-failed", "actions": [["dns", "list-zones"]]},
            "denied": {"actions": []},
            "stopped": {"actions": [["dns", "list-zones"]]},
            "frozen": {"request_kind": "human", "assistant_id": "dns", "action": "replace-dns-record"},
            "created": DEFINED,
            "changed": DEFINED,
        }
        self.assertEqual(set(valid), routine_contract.OUTCOMES)
        for outcome, detail in valid.items():
            self.assertEqual(routine_contract.canonical_notice_detail(outcome, detail), detail)
        for outcome, detail in (
            ("done", {"reply": "Updated."}),
            ("uncertain", {"actions": []}),
            ("needs-input", {"question": "Which zone?"}),
            ("paused", {"assistant_id": "dns", "action": "x", "reason": "approve"}),
            ("scope-changed", {"assistants": []}),
            ("scope-changed", {"assistants": ["Bad"]}),
            ("stopped", {"actions": [["dns", {"input": 1}]]}),
            ("stopped", {"actions": "dns"}),
            ("failed", {"code": "Bad Code", "actions": []}),
            ("created", {**DEFINED, "steps": []}),
            ("created", {**DEFINED, "steps": [{**DEFINED["steps"][0], "stored_inputs": ["API key"]}]}),
            ("changed", {**DEFINED, "input": {"zone": "example.com"}}),
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

    def test_the_plan_projection_is_closed_and_its_previews_bounded(self) -> None:
        self.assertEqual(routine_contract.literal_preview({"a": "x‮"}), '{"a":"x\\u202e"}')
        self.assertEqual(len(routine_contract.literal_preview("y" * 300)), routine_contract.MAX_PREVIEW_CHARS)
        step = DEFINED["steps"][0]
        self.assertEqual(routine_contract.canonical_steps([step]), [step])
        for steps in (
            ["x"],
            [{**step, "inputs": ["x"]}],
            [{**step, "inputs": [{"member": "", "source": "literal", "value": "1"}]}],
        ):
            with self.subTest(steps=steps):
                self.assertIsNone(routine_contract.canonical_steps(steps))
