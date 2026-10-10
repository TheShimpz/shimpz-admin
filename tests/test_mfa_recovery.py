"""Security contracts for the Supervisor's single-use recovery codes."""

import copy
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from mfa import recovery
from mfa_helper import recovery_codes, recovery_record

DISPLAY = re.compile(r"[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}")
NOW = 1_800_000_000


class RecoveryCodeTests(unittest.TestCase):
    def test_a_set_is_ten_distinct_codes_kept_only_as_digests(self) -> None:
        codes, record = recovery_codes(), recovery_record()

        self.assertEqual(len(set(codes)), recovery.CODE_COUNT)
        self.assertTrue(all(DISPLAY.fullmatch(code) for code in codes))
        self.assertEqual(recovery.remaining(record), recovery.CODE_COUNT)
        stored = repr(record)
        for code in codes:
            self.assertNotIn(code, stored)
            self.assertNotIn(code.replace("-", ""), stored)

    def test_a_code_is_typed_without_regard_to_case_spaces_or_hyphens(self) -> None:
        code = recovery_codes()[0]
        compact = code.replace("-", "")

        for typed in (code, compact, code.upper(), f"  {compact[:6]} {compact[6:]} "):
            with self.subTest(typed=typed):
                self.assertEqual(recovery.normalized(typed), compact)
        for typed in (None, 7, "", compact[:-1], compact + "0", "i" * 12, "o" * 12, "u" * 12, "x" * 65):
            with self.subTest(typed=typed):
                self.assertIsNone(recovery.normalized(typed))

    def test_each_code_is_spent_once_and_a_wrong_or_malformed_code_spends_nothing(self) -> None:
        record = recovery_record()
        first, second = recovery_codes()[:2]

        self.assertTrue(recovery.spend(record, recovery.candidate(record, first), NOW))
        self.assertFalse(recovery.spend(record, recovery.candidate(record, first), NOW + 1))
        self.assertFalse(recovery.spend(record, recovery.candidate(record, "0000-0000-0000"), NOW + 1))
        self.assertFalse(recovery.spend(record, recovery.candidate(record, "not a code"), NOW + 1))
        self.assertEqual(recovery.remaining(record), recovery.CODE_COUNT - 1)
        self.assertTrue(recovery.spend(record, recovery.candidate(record, second.upper()), NOW + 2))
        self.assertEqual([entry["used_at"] for entry in record["codes"]][:2], [NOW, NOW + 2])

    def test_a_code_of_another_set_never_matches(self) -> None:
        other = recovery.new_set()

        record = recovery_record()
        self.assertFalse(recovery.spend(record, recovery.candidate(record, other.codes[0]), NOW))

    def test_persisted_sets_fail_closed_unless_exact(self) -> None:
        valid = recovery_record()
        cases = [None, [], {"salt": valid["salt"]}, {**valid, "extra": 1}]
        for field, value in (("salt", "short"), ("salt", 7), ("codes", {}), ("codes", valid["codes"][:9])):
            cases.append({**valid, field: value})
        for change in (
            lambda entries: entries.__setitem__(0, "digest"),
            lambda entries: entries[0].update(extra=1),
            lambda entries: entries[0].update(digest="A" * 64),
            lambda entries: entries[0].update(digest=7),
            lambda entries: entries[0].update(used_at=True),
            lambda entries: entries[0].update(used_at=0),
            lambda entries: entries[0].update(used_at="now"),
            lambda entries: entries[1].update(digest=entries[0]["digest"]),
        ):
            record = copy.deepcopy(valid)
            change(record["codes"])
            cases.append(record)

        for record in cases:
            with self.subTest(record=repr(record)[:60]), self.assertRaises(recovery.RecoveryStateError):
                recovery.validated(record)
        self.assertIs(recovery.validated(valid), valid)


if __name__ == "__main__":
    unittest.main()
