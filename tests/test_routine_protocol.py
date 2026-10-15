"""Admin's mirror of Team's Routine protocol admits exactly Team's golden vectors (ADR-0086, ADR-0101)."""

import json
import sys
import unittest
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import routine as routine_contract
from protocol.http.v1 import routine_notice as routine_notice_contract
from protocol.http.v1 import routine_proposal as routine_proposal_contract
from protocol.http.v1 import routine_run as routine_run_contract
from protocol.http.v1 import supervisor

VECTORS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())
CARD = VECTORS["routine_proposal"]["valid"][0]
VIEWS = {
    "output": routine_contract.canonical_output,
    "routine": routine_notice_contract.canonical_routine_view,
    "run": routine_notice_contract.canonical_run_view,
    "notice_batch": routine_notice_contract.canonical_notice_batch,
    "claim": routine_run_contract.canonical_claim,
    "claim_request": routine_run_contract.canonical_claim_request,
    "incident": routine_notice_contract.canonical_incident_view,
    "card": routine_run_contract.canonical_card,
    "card_answer_request": routine_run_contract.canonical_card_answer_request,
    "card_answer": routine_run_contract.canonical_card_answer,
    "segment_request": routine_run_contract.canonical_segment_request,
    "page": routine_contract.canonical_page,
    "summary": routine_contract.canonical_summary,
    "run_steps": routine_run_contract.canonical_run_steps,
}
FAMILIES = {
    "routine_schedule": routine_contract.canonical_schedule,
    "routine_timezone": routine_contract.canonical_timezone,
    "routine_run_usage": routine_contract.canonical_run_usage,
    "routine_proposal": routine_proposal_contract.canonical_proposal,
    "routine_refusal": routine_proposal_contract.canonical_refusal,
    "routine_question": routine_proposal_contract.canonical_question,
    "routine_proposal_answer": routine_proposal_contract.canonical_proposal_answer,
    "routine_diagnostics": routine_run_contract.canonical_diagnostics,
}


class RoutineProtocolMirrorTests(unittest.TestCase):
    def test_every_routine_vector_family_is_admitted_exactly(self) -> None:
        for family, admit in FAMILIES.items():
            for value in VECTORS[family]["valid"]:
                with self.subTest(family=family, value=value):
                    self.assertEqual(admit(value), value)
            for value in VECTORS[family]["invalid"]:
                with self.subTest(family=family, value=value):
                    self.assertIsNone(admit(value))
        for kind, admit in VIEWS.items():
            for value in VECTORS["routine_views"][kind]["valid"]:
                with self.subTest(kind=kind, value=value):
                    self.assertEqual(admit(value), value)
            for value in VECTORS["routine_views"][kind]["invalid"]:
                with self.subTest(kind=kind, value=value):
                    self.assertIsNone(admit(value))
            self.assertIsNone(admit(["not", "a", "view"]))
        for case in VECTORS["routine_position"]["valid"]:
            self.assertEqual(routine_contract.canonical_position(case["value"], case["steps"]), case["value"])
        for case in VECTORS["routine_position"]["invalid"]:
            with self.subTest(case=case):
                self.assertIsNone(routine_contract.canonical_position(case["value"], case["steps"]))

    def test_schedules_name_their_rate_cap_mode_and_active_time(self) -> None:
        for case in VECTORS["routine_schedule"]["daily_rate"]:
            self.assertEqual(str(routine_contract.daily_rate(case["schedule"])), case["rate"])
        self.assertEqual(routine_contract.daily_rate({"kind": "hourly", "every": 5}), Fraction(24, 5))
        self.assertEqual(routine_contract.daily_cap({"kind": "hourly", "every": 5}), 5)
        self.assertEqual(routine_contract.daily_cap({"kind": "continuous", "gap": 5, "cap": 300}), 300)
        self.assertEqual(routine_run_contract.run_mode({"kind": "continuous", "gap": 5, "cap": 300}), "continuous")
        self.assertEqual(routine_run_contract.run_mode({"kind": "daily", "time": "09:00"}), "scheduled")
        self.assertEqual(routine_run_contract.active_seconds(8), routine_run_contract.SHORT_ACTIVE_SECONDS)
        self.assertEqual(routine_run_contract.active_seconds(320), routine_run_contract.MAX_ACTIVE_SECONDS)

    def test_closed_forms_refuse_anything_but_their_own_shape(self) -> None:
        self.assertIsNone(routine_contract.canonical_output([]))
        self.assertIsNone(routine_notice_contract.canonical_notice_detail(None, {}))
        self.assertIsNone(routine_notice_contract.canonical_notice_detail("deleted", []))
        self.assertIsNone(routine_run_contract.canonical_failure([]))
        self.assertIsNone(routine_run_contract.canonical_diagnostic([]))
        self.assertFalse(routine_run_contract._diagnostic_text("lone \ud800 surrogate"))
        self.assertFalse(routine_run_contract._diagnostic_text(7))
        self.assertEqual(routine_contract.escaped("a‮b"), "a\\u202eb")
        self.assertEqual(routine_contract.where_text("x‮y"), '"x\\u202ey"')
        self.assertIsNone(routine_notice_contract.canonical_notice_batch({"notices": ["x"], "more": False}))

    def test_previews_and_card_parts_refuse_anything_but_their_own_shape(self) -> None:
        self.assertEqual(routine_contract.literal_preview({"a": "x\u202e"}), '{"a":"x\\u202e"}')
        self.assertEqual(len(routine_contract.literal_preview("y" * 300)), routine_contract.MAX_PREVIEW_CHARS)
        self.assertFalse(routine_contract._input({"member": "", "source": "literal", "value": "1"}, 1))
        # Every plan has a step, and only a closed output mode is admitted.
        self.assertEqual(
            routine_contract.canonical_disposition({"mode": "none", "step": None}, 1), {"mode": "none", "step": None}
        )
        self.assertIsNone(routine_contract.canonical_disposition({"mode": "none", "step": None}, 0))
        self.assertIsNone(routine_contract.canonical_disposition({"mode": "other", "step": None}, 1))
        literal = CARD["steps"][1]["inputs"][0]
        self.assertFalse(routine_proposal_contract._card_input([], 1))
        self.assertFalse(routine_proposal_contract._card_input({**literal, "origin": "guess"}, 2))
        self.assertFalse(routine_proposal_contract._card_input({**literal, "member": "a\u2028b"}, 2))
        self.assertFalse(routine_proposal_contract._card_permitted({}))
        self.assertFalse(
            routine_proposal_contract._card_permitted([CARD["permitted"][0]] * (routine_contract.MAX_PERMITTED + 1))
        )
        self.assertFalse(routine_proposal_contract._card_permitted([{**CARD["permitted"][0], "read_only": 1}]))

    def test_routine_assertions_bind_no_human_authority(self) -> None:
        valid = VECTORS["local_routine"]["valid"][0]
        self.assertEqual(supervisor.canonical_claims(valid, audience=supervisor.ROUTINE_AUDIENCE), valid)
        for value in (
            {**valid, "assurance": {"kind": "auth:password", "challenge_id": "e" * 32}},
            {**valid, "authority": "session"},
        ):
            with self.subTest(value=value), self.assertRaises(supervisor.SupervisorAssertionError):
                supervisor.canonical_claims(value, audience=supervisor.ROUTINE_AUDIENCE)

    def test_a_run_usage_may_name_no_model_and_a_chat_usage_must_name_one(self) -> None:
        replay = {"duration_ms": 1200, "models": []}
        self.assertEqual(team_contract.canonical_run_usage(replay), replay)
        self.assertIsNone(team_contract.canonical_turn_usage(replay))

    def test_the_card_shows_the_owner_s_selector_whole(self) -> None:
        selector = [item for step in CARD["steps"] for item in step["inputs"] if item["origin"] == "selector"]
        self.assertTrue(selector)
        self.assertEqual(routine_proposal_contract.canonical_proposal(CARD), CARD)


if __name__ == "__main__":
    unittest.main()
