"""The browser's copies of Team HTTP presentation rules stay identical to the pinned Team protocol (ADR-0090)."""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from protocol.http.v1 import payload as team_contract

LOCAL_CHAT = ROOT / "frontend" / "src" / "lib" / "localChat.js"
VALIDATE = ROOT / "frontend" / "src" / "lib" / "validate.js"


def _constant(source: str, name: str) -> str:
    match = re.search(rf"^const {name} = (.+);$", source, re.MULTILINE)
    if match is None:
        raise AssertionError(f"{name} is missing from the browser parser")
    return match[1]


class FrontendProtocolParityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = LOCAL_CHAT.read_text(encoding="utf-8")

    def test_the_browser_help_url_grammar_is_the_team_pattern_byte_for_byte(self) -> None:
        block = re.search(r"export const HELP_URL_PATTERN = \[\n(.*?)\n\]\.join\(''\);", self.source, re.DOTALL)
        self.assertIsNotNone(block)
        pieces = re.findall(r"^  String\.raw`([^`]*)`,$", block[1], re.MULTILINE)
        self.assertEqual(len(pieces), 5)
        self.assertEqual(len(block[1].splitlines()), len(pieces))
        self.assertEqual("".join(pieces), team_contract.HELP_URL_PATTERN)
        self.assertEqual(int(_constant(self.source, "MAX_HELP_URL_CHARS")), team_contract.MAX_HELP_URL_CHARS)

    def test_the_browser_purpose_rule_mirrors_the_team_rule(self) -> None:
        self.assertEqual(int(_constant(self.source, "MAX_PURPOSE_CHARS")), team_contract.MAX_PURPOSE_CHARS)
        forbidden = _constant(self.source, "PURPOSE_FORBIDDEN_RE")
        for marker in (r"\p{C}", r"\p{Zl}", r"\p{Zp}", r"(?!-)\p{Pd}", " -", "- ", r":\/\/"):
            with self.subTest(marker=marker):
                self.assertIn(marker, forbidden)
        rule = self.source[self.source.index("export function canonicalPurpose(") :]
        rule = rule[: rule.index("\n}\n")]
        for check in (
            "value.normalize('NFC') !== value",
            "value.trim() !== value",
            "codePointLength(value) < 1",
            "codePointLength(value) > MAX_PURPOSE_CHARS",
            "PURPOSE_FORBIDDEN_RE.test(value)",
            "value.toLowerCase().includes('www.')",
        ):
            with self.subTest(check=check):
                self.assertIn(check, rule)

    def test_the_browser_rendered_copy_bounds_are_the_team_bounds(self) -> None:
        for name, bounds in (
            ("RENDERED_FIELD_CHARS", team_contract.RENDERED_FIELD_CHARS),
            ("RENDERED_OPTION_CHARS", team_contract.RENDERED_OPTION_CHARS),
        ):
            with self.subTest(name=name):
                literal = re.fullmatch(r"Object\.freeze\(\{ (.+) \}\)", _constant(self.source, name))
                self.assertIsNotNone(literal)
                pairs = dict(re.findall(r"(\w+): (\d+)", literal[1]))
                self.assertEqual({field: int(value) for field, value in pairs.items()}, bounds)


class FrontendIdentifierParityTests(unittest.TestCase):
    def test_the_browser_identifier_kinds_are_the_team_identifiers(self) -> None:
        source = VALIDATE.read_text(encoding="utf-8")

        def exported(name: str) -> str:
            match = re.search(rf"^export const {name} = (.+);$", source, re.MULTILINE)
            if match is None:
                raise AssertionError(f"{name} is missing from the browser validators")
            return match[1]

        self.assertEqual(exported("ASSISTANT_ID_RE"), f"/{team_contract.ASSISTANT_ID_PATTERN}/")
        self.assertEqual(exported("ACTION_ID_RE"), f"/{team_contract.ACTION_ID_PATTERN}/")
        for name in ("MAX_ASSISTANT_ID_CHARS", "MAX_IDENTIFIER_CHARS", "MAX_ACTION_ID_CHARS"):
            with self.subTest(name=name):
                self.assertEqual(int(exported(name)), getattr(team_contract, name))
        self.assertEqual(team_contract.IDENTIFIER_RE.pattern, team_contract.ASSISTANT_ID_PATTERN)


if __name__ == "__main__":
    unittest.main()
