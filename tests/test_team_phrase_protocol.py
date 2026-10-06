"""Admin's mirror of Team's Routine phrase reader and Brain-facing forms reads exactly Team's rules (ADR-0101)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from protocol.http.v1 import phrase, routine_context, routine_proposal

VECTORS = ROOT / "backend" / "protocol" / "http" / "v1" / "vectors.json"
CARD = {
    "member": "note",
    "origin": "assistant",
    "value": "",
    "step": None,
    "pointer": None,
    "where": None,
    "item": None,
}


class PhraseTests(unittest.TestCase):
    def test_schedules_read_only_real_times_and_admitted_intervals(self) -> None:
        for text, schedules in (
            ("every day at 9 pm", ({"kind": "daily", "time": "21:00"},)),
            ("every day at 12am", ({"kind": "daily", "time": "00:00"},)),
            ("every day at 13pm", ()),
            ("every 2 seconds", ()),
        ):
            with self.subTest(text=text):
                self.assertEqual(phrase.stated(text), schedules)

    def test_a_repeated_output_or_zone_is_read_once(self) -> None:
        self.assertEqual(phrase.outputs("Mostrar o resultado sempre e mostrar o resultado sempre"), ("show",))
        self.assertEqual(phrase.zones("Europe/London e Europe/London"), ("Europe/London",))

    def test_a_zone_that_does_not_load_or_is_not_canonical_is_not_read(self) -> None:
        for text in ("Europe/Atlantis", "America/" + "X" * 40 + "/Yyyy"):
            with self.subTest(text=text):
                self.assertEqual(phrase.zones(text), ())

    def test_a_card_input_with_an_unsafe_member_is_refused(self) -> None:
        self.assertIs(routine_proposal._card_input({**CARD, "member": "bad\x00member"}, 1), False)

    def test_the_brain_listing_reads_through_the_package_import(self) -> None:
        listings = json.loads(VECTORS.read_text(encoding="utf-8"))["routine_listing"]
        for value in listings["valid"]:
            with self.subTest(value=str(value)[:40]):
                self.assertIsNotNone(routine_context.canonical_routine_listings(value))


if __name__ == "__main__":
    unittest.main()
