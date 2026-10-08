"""The browser's copies of Team HTTP presentation rules stay identical to the pinned Team protocol (ADR-0090)."""

from __future__ import annotations

import ast
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import turn as turn_contract

LOCAL_CHAT = ROOT / "frontend" / "src" / "lib" / "localChat.js"
VALIDATE = ROOT / "frontend" / "src" / "lib" / "validate.js"
LIB = ROOT / "frontend" / "src" / "lib"
# The browser's copies of Team chat-turn bounds, which it cannot import, each pinned to its one Team definition.
TURN_BOUNDS = {
    "localChat.js": {
        "MAX_MESSAGE_CHARS": team_contract.MAX_CHAT_MESSAGE_CHARS,
        "MAX_FILES": team_contract.MAX_CHAT_FILES,
        "MAX_REPLY_CHARS": turn_contract.MAX_REPLY_CHARS,
        "MAX_GUIDANCE_REPLY_CHARS": turn_contract.MAX_INTENT_ROUTE_REPLY_CHARS,
        "MAX_TEAM_NAME_CHARS": team_contract.MAX_TEAM_NAME_CHARS,
    },
    "chatHistory.js": {
        "MAX_MESSAGE_CHARS": team_contract.MAX_CHAT_MESSAGE_CHARS,
        "MAX_REPLY_CHARS": turn_contract.MAX_REPLY_CHARS,
        "MAX_GUIDANCE_REPLY_CHARS": turn_contract.MAX_INTENT_ROUTE_REPLY_CHARS,
        "MAX_TEAM_NAME_CHARS": team_contract.MAX_TEAM_NAME_CHARS,
    },
    "attachments.js": {
        "MAX_ATTACHMENTS": team_contract.MAX_CHAT_FILES,
        "MAX_UPLOAD_BYTES": team_contract.MAX_FILE_UPLOAD_BYTES,
        "MAX_FILENAME_BYTES": team_contract.MAX_FILENAME_BYTES,
        "MAX_MEDIA_TYPE_CHARS": team_contract.MAX_MEDIA_TYPE_CHARS,
        "MAX_MESSAGE_IMAGES": turn_contract.MAX_ATTACHMENT_IMAGES,
        "MAX_MESSAGE_TEXT_CHARACTERS": turn_contract.MAX_ATTACHED_TEXT_CHARS,
        "MAX_MESSAGE_TEXT_BYTES": turn_contract.MAX_ATTACHED_TEXT_BYTES,
        "MAX_TEXT_CHARACTERS": turn_contract.MAX_ATTACHMENT_TEXT_CHARS,
        "MAX_TEXT_BYTES": turn_contract.MAX_ATTACHMENT_TEXT_BYTES,
    },
}


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


def _definitions(source: str, name: str) -> list[str]:
    return re.findall(rf"^(?:export )?const {name} = (.+);$", source, re.MULTILINE)


def _integer(source: str, expression: str, depth: int = 0) -> int:
    """A browser constant's integer: a product of integer literals and constants the same file defines that way."""
    if depth > 4:
        raise AssertionError(f"{expression} nests too deeply")
    node = ast.parse(expression.replace("_", ""), mode="eval").body
    factors: list[ast.expr] = []
    while isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
        factors.append(node.right)
        node = node.left
    factors.append(node)
    product = 1
    for factor in factors:
        if isinstance(factor, ast.Constant) and type(factor.value) is int:
            product *= factor.value
        elif isinstance(factor, ast.Name) and len(defined := _definitions(source, factor.id)) == 1:
            product *= _integer(source, defined[0], depth + 1)
        else:
            raise AssertionError(f"{expression} is not a literal browser bound")
    return product


class FrontendTurnBoundParityTests(unittest.TestCase):
    def test_each_browser_turn_bound_is_the_team_definition(self) -> None:
        for filename, bounds in TURN_BOUNDS.items():
            source = (LIB / filename).read_text(encoding="utf-8")
            for name, expected in bounds.items():
                with self.subTest(file=filename, bound=name):
                    found = _definitions(source, name)
                    self.assertEqual(len(found), 1)
                    self.assertEqual(_integer(source, found[0]), expected)

    def test_a_browser_bound_reads_its_own_units_and_refuses_anything_else(self) -> None:
        units = "const KIB = 1024;\nconst MIB = 1024 * KIB;\n"
        self.assertEqual(_integer(units, "512 * KIB"), 512 * 1024)
        self.assertEqual(_integer(units, "25 * MIB"), 25 * 1024 * 1024)
        self.assertEqual(_integer(units, "60_000"), 60_000)
        # A unit the browser redefines changes the bound it reads.
        self.assertEqual(_integer("const KIB = 1000;\n", "512 * KIB"), 512_000)
        for expression in ("LIMIT", "1 + 2", "2 * OTHER", "1.5", "2 * LOOP"):
            with self.subTest(expression=expression), self.assertRaises(AssertionError):
                _integer(units + "const LOOP = 2 * LOOP;\n", expression)


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
