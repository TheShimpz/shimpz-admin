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
SUMMARY = VECTORS["routine_views"]["summary"]["valid"][1]
DEFINED = {
    "name": "Weekly zones",
    "plan": SUMMARY,
    "output": {"mode": "show", "step": 1},
    "schedule": {"kind": "daily", "time": "09:00"},
    "timezone": "UTC",
}
STEP = VECTORS["routine_views"]["page"]["valid"][0]["steps"][0]


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
            "page": routine_contract.canonical_page,
            "summary": routine_contract.canonical_summary,
            "run_steps": routine_contract.canonical_run_steps,
        }
        for kind, admit in views.items():
            for value in VECTORS["routine_views"][kind]["valid"]:
                with self.subTest(kind=kind, value=value):
                    self.assertEqual(admit(value), value)
            for value in VECTORS["routine_views"][kind]["invalid"]:
                with self.subTest(kind=kind, value=value):
                    self.assertIsNone(admit(value))
            self.assertIsNone(admit(["not", "a", "view"]))

    def test_shown_results_and_dispositions_admit_exactly_the_closed_forms(self) -> None:
        """A run's shown result is Team's closed projection; a disposition names a projected step (2026-10-05)."""
        output = VECTORS["routine_views"]["output"]
        for value in output["valid"]:
            self.assertEqual(routine_contract.canonical_output(value), value)
        for value in output["invalid"]:
            self.assertIsNone(routine_contract.canonical_output(value))
        shown = output["valid"][0]
        nested: dict[str, object] = {"kind": "null"}
        for _depth in range(routine_contract.MAX_OUTPUT_DEPTH + 1):
            nested = {"kind": "list", "items": [nested], "omitted": 0}
        text = {"kind": "text", "value": "x", "cut": False}
        for node in (
            nested,
            {"kind": []},
            {"kind": "list", "items": "x", "omitted": 0},
            {"kind": "list", "items": [text] * 51, "omitted": 0},
            {"kind": "fields", "fields": [["a"]], "omitted": 0},
            {"kind": "fields", "fields": [["k", text]] * 25, "omitted": 0},
            {"kind": "fields", "fields": [], "omitted": 0, "x": 1},
            {"kind": "list", "items": [{**text, "value": "é" * 300}] * 50, "omitted": 0},
            "text",
        ):
            self.assertIsNone(routine_contract.canonical_output({**shown, "value": node}))
        self.assertIsNone(routine_contract.canonical_output([]))
        self.assertEqual(routine_contract.escaped("a\u202eb"), "a\\u202eb")
        # A shown step is named by its 1-based position among the plan's steps (ADR-0092 amendment, 2026-10-05, scale).
        self.assertEqual(
            routine_contract.canonical_disposition({"mode": "show", "step": 2}, 2), {"mode": "show", "step": 2}
        )
        for value, total in (
            ({"mode": "show", "step": 3}, 2),
            ({"mode": "show", "step": "zones"}, 2),
            ({"mode": "show", "step": 1}, "steps"),
            ({"mode": "none", "step": 1}, 2),
            ({"mode": "none", "step": None}, 0),
            ([], 2),
        ):
            with self.subTest(value=value, total=total):
                self.assertIsNone(routine_contract.canonical_disposition(value, total))

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
        held = {"assistant_id": "dns", "action": "replace-dns-record", "step": 2, "steps": 3}
        unplaced = {"assistant_id": None, "action": None, "step": None, "steps": None}
        valid = {
            "done": {"plan": SUMMARY, "output": None},
            "recovered": {"plan": SUMMARY, "output": None},
            "held": held,
            "paused": {**held, "reason": "policy"},
            "user-skipped": {**unplaced, "choice": "delete"},
            "skipped": {"missed": 3},
            "healthy": {"runs": 12},
            "scope-changed": {"assistants": ["dns"]},
            "failed": {"code": "assistant-rpc-failed", "actions": [["dns", "list-zones"]], "step": 37, "steps": 120},
            "denied": {"actions": []},
            "stopped": {"actions": [["dns", "list-zones"]]},
            "frozen": {"request_kind": "human", **held},
            "created": DEFINED,
            "changed": DEFINED,
        }
        self.assertEqual(set(valid), routine_contract.OUTCOMES)
        for outcome, detail in valid.items():
            self.assertEqual(routine_contract.canonical_notice_detail(outcome, detail), detail)
        for outcome, detail in (
            ("done", {"reply": "Updated."}),
            ("done", {"actions": [["dns", "list-zones"]], "output": None}),
            ("done", {"plan": SUMMARY, "output": {"step": 2, "state": "unchanged", "value": None, "truncated": False}}),
            ("held", {**held, "step": None}),
            ("held", {**unplaced, "steps": 3}),
            ("held", {**held, "step": 4}),
            ("frozen", {"request_kind": "human", **unplaced}),
            ("failed", {"code": "x", "actions": [], "step": 1, "steps": None}),
            ("failed", {"code": "x", "actions": []}),
            ("uncertain", {"actions": []}),
            ("needs-input", {"question": "Which zone?"}),
            ("paused", {**held, "reason": "approve"}),
            ("paused", {**held, "reason": "person"}),
            ("user-skipped", held),
            ("user-skipped", {**held, "choice": "skip"}),
            ("scope-changed", {"assistants": []}),
            ("scope-changed", {"assistants": ["Bad"]}),
            ("healthy", {"runs": 13}),
            ("stopped", {"actions": [["dns", {"input": 1}]]}),
            ("stopped", {"actions": "dns"}),
            ("failed", {"code": "Bad Code", "actions": []}),
            ("created", {**DEFINED, "plan": {**SUMMARY, "steps": 2}}),
            ("created", {**DEFINED, "output": {"mode": "show", "step": 2}}),
            ("created", {**{key: value for key, value in DEFINED.items() if key != "plan"}, "steps": [STEP]}),
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
        self.assertEqual(routine_contract.canonical_step(STEP, 1), STEP)
        for step, position in (
            ("x", 1),
            (STEP, 2),
            (STEP, 0),
            ({**STEP, "position": True}, 1),
            ({**STEP, "id": "zones"}, 1),
            ({**STEP, "inputs": ["x"]}, 1),
            ({**STEP, "inputs": [{"member": "", "source": "literal", "value": "1"}]}, 1),
            ({**STEP, "inputs": [{"member": "z", "source": "step_output", "step": 1, "pointer": ""}]}, 1),
            ({**STEP, "stored_inputs": ["API key"]}, 1),
            ({**STEP, "inputs": [{"member": "z", "source": "literal", "value": "y" * 120}] * 2}, 1),
        ):
            with self.subTest(step=step, position=position):
                self.assertIsNone(routine_contract.canonical_step(step, position))
        # A step referring to an earlier one names its position, never an id, and never a later step.
        later = {**STEP, "position": 2, "inputs": [{"member": "z", "source": "step_text", "step": 1, "pointer": ""}]}
        self.assertEqual(routine_contract.canonical_step(later, 2), later)
        self.assertIsNone(routine_contract.canonical_step({**later, "inputs": [{**later["inputs"][0], "step": 2}]}, 2))
        # A step's projection over its byte bound is refused whole, never cut.
        pointer = "/" + '"' * 255
        wide = [
            {"member": f"{index:03d}" + "m" * 125, "source": "step_output", "step": 1, "pointer": pointer}
            for index in range(routine_contract.MAX_STEP_INPUTS)
        ]
        self.assertGreater(routine_contract.encoded_bytes(wide), routine_contract.MAX_STEP_VIEW_BYTES)
        self.assertTrue(routine_contract.canonical_step({**later, "inputs": wide}, 2) is None)

    def test_a_long_run_is_named_by_its_active_time_and_admin_claims_only_saying_whether_it_takes_one(self) -> None:
        self.assertEqual(routine_contract.active_seconds(8), routine_contract.SHORT_ACTIVE_SECONDS)
        self.assertEqual(routine_contract.active_seconds(256), routine_contract.MAX_ACTIVE_SECONDS)
        for request in ({}, {"long": 1}, {"long": True, "key": "x"}, []):
            with self.subTest(request=request):
                self.assertIsNone(routine_contract.canonical_claim_request(request))

    def test_a_run_s_step_records_admit_exactly_their_closed_forms(self) -> None:
        page = VECTORS["routine_views"]["run_steps"]["valid"][0]
        done, failed, recovered, unavailable, not_run = page["steps"]
        for step in (done, failed, recovered, unavailable, not_run):
            with self.subTest(step=step):
                self.assertEqual(routine_contract.canonical_run_step(step, step["position"]), step)
        for step, position in (
            (done, 2),
            ([], 1),
            ({**done, "status": "running"}, 1),
            ({**not_run, "attempt": 1}, 5),
            ({**recovered, "duration_ms": 5}, 3),
            ({**done, "duration_ms": -1}, 1),
            ({**done, "duration_ms": 2**53}, 1),
            ({**done, "attempt": 0}, 1),
            ({**done, "recorded_at": "yesterday"}, 1),
            ({**done, "inputs": "x"}, 1),
            ({**done, "inputs": [{"member": "a", "source": "secret", "value": None}]}, 1),
            ({**done, "inputs": [{"member": "a", "source": "literal", "value": "x\u202e"}]}, 1),
            ({**done, "inputs": [{"member": "b", "source": "literal", "value": None}] * 2}, 1),
            ({**done, "inputs": [{"member": "a", "source": "literal"}]}, 1),
            ({**done, "position": 0}, 0),
        ):
            with self.subTest(step=step, position=position):
                self.assertIsNone(routine_contract.canonical_run_step(step, position))
