"""Bounded untrusted conversation evidence projected from Local chat history."""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Literal

MAX_ENTRIES = 8
MAX_TEXT_CHARS = 512
MAX_TOTAL_CHARS = 4_096
TRUNCATION_MARKER = "…"
_LAYOUT_CONTROLS = frozenset({"\n", "\r", "\t"})


@dataclass(frozen=True, slots=True)
class Entry:
    role: Literal["user", "assistant"]
    text: str
    truncated: bool


def canonical_text(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("conversation text is invalid")
    canonical = unicodedata.normalize("NFC", value)
    if not canonical or canonical.strip() != canonical:
        raise ValueError("conversation text is invalid")
    # The first check skips replacement scans for ordinary printable text.
    if canonical.isprintable() or canonical.replace("\n", "").replace("\r", "").replace("\t", "").isprintable():
        return canonical
    if any(
        unicodedata.category(character).startswith("C")
        and unicodedata.category(character) != "Cf"
        and character not in _LAYOUT_CONTROLS
        for character in canonical
    ):
        raise ValueError("conversation text is invalid")
    return canonical


def bounded(role: object, text: object) -> Entry:
    if role not in {"user", "assistant"}:
        raise ValueError("conversation role is invalid")
    canonical = canonical_text(text)
    if len(canonical) <= MAX_TEXT_CHARS:
        return Entry(role, canonical, False)
    remaining = MAX_TEXT_CHARS - len(TRUNCATION_MARKER)
    head = remaining // 2
    tail = remaining - head
    return Entry(role, f"{canonical[:head]}{TRUNCATION_MARKER}{canonical[-tail:]}", True)


def admit(value: object) -> tuple[Entry, ...]:
    if not isinstance(value, tuple) or len(value) > MAX_ENTRIES:
        raise ValueError("conversation window is invalid")
    admitted: list[Entry] = []
    for entry in value:
        if (
            not isinstance(entry, Entry)
            or entry.role not in {"user", "assistant"}
            or not isinstance(entry.truncated, bool)
        ):
            raise ValueError("conversation entry is invalid")
        canonical = canonical_text(entry.text)
        if len(canonical) > MAX_TEXT_CHARS:
            raise ValueError("conversation entry is invalid")
        admitted.append(Entry(entry.role, canonical, entry.truncated))
    result = tuple(admitted)
    if sum(len(entry.text) for entry in result) > MAX_TOTAL_CHARS:
        raise ValueError("conversation window is invalid")
    return result
