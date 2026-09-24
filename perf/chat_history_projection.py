"""Measure the Local chat history read used before structured routing.

Run from the Admin checkout with
``PYTHONPATH=backend uv run --frozen --python 3.14 python -m perf.chat_history_projection``.
Only synthetic rows in a temporary SQLite file are read. Output contains timings and
counts, never transcript text. The contiguous-card stress case is not normal chat
turn ordering. This does not measure a complete chat turn.
"""

from __future__ import annotations

import json
import math
import sqlite3
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path

from history import context, store

TEAM = "marketing"
OTHER_TEAM = "other_team"
SAMPLES = 100
LONG_TEXT = "e\u0301🙂" * 1_600
LONG_ASCII_TEXT = "A" * len(LONG_TEXT)
CASES = (
    ("empty", 0, 0, None),
    ("eight_short", 8, 0, None),
    ("large_history", 10_000, 0, None),
    ("ineligible_tail_stress", 8, 10_000, None),
    ("long_text", 8, 0, LONG_TEXT),
    ("long_ascii", 8, 0, LONG_ASCII_TEXT),
)


class ConfoundedMeasurementError(RuntimeError):
    """The synthetic data or projection did not match the declared workload."""


def _turn(index: int) -> str:
    return f"{index + 1:032x}"


def _user_payload(text: str) -> str:
    return store._encoded({"kind": "message", "role": "user", "text": text})


def _card_payload() -> str:
    event = {
        "type": "assistant-install-plan",
        "state": "stopped",
        "plan_id": "f" * 32,
        "team_id": TEAM,
        "assistants": [
            {
                "id": "shimpz-cloudflare",
                "name": "Shimpz Cloudflare",
                "summary": "Manage DNS records.",
                "providers": ["cloudflare"],
                "provenance": "local",
                "status": "pending",
            }
        ],
    }
    return store._encoded(store._install_payload(event, TEAM))


def _public_encoding_matches(path: Path) -> None:
    store.STORE_PATH = path
    prior, anchor = _turn(0), _turn(1)
    if not store.append_user(TEAM, prior, LONG_TEXT) or not store.append_user(TEAM, anchor, "Current"):
        raise ConfoundedMeasurementError("public fixture write failed")
    public = store.conversation(TEAM, anchor)
    store.STORE_PATH = path.with_name("direct.sqlite3")
    with store._database() as database:
        database.executemany(
            "INSERT INTO transcript (team_id, event_key, payload) VALUES (?, ?, ?)",
            (
                (TEAM, f"{prior}:user", _user_payload(LONG_TEXT)),
                (TEAM, f"{anchor}:user", _user_payload("Current")),
            ),
        )
    if store.conversation(TEAM, anchor) != public:
        raise ConfoundedMeasurementError("direct fixture differs from public append")


def _rows(eligible: int, ineligible: int, long_text: str | None, anchor: str) -> Iterator[tuple[str, str, str]]:
    yield OTHER_TEAM, f"{_turn(100_000)}:user", _user_payload("Other Team only")
    for index in range(eligible):
        text = long_text if long_text is not None else f"Question {index}"
        yield TEAM, f"{_turn(index)}:user", _user_payload(text)
    card = _card_payload()
    for index in range(eligible, eligible + ineligible):
        yield TEAM, f"{_turn(index)}:install", card
    yield OTHER_TEAM, f"{anchor}:user", _user_payload("Other Team current")
    yield TEAM, f"{anchor}:user", _user_payload("Current")


def _expected(eligible: int, long_text: str | None) -> tuple[context.Entry, ...]:
    return tuple(
        context.bounded("user", long_text if long_text is not None else f"Question {index}")
        for index in range(max(0, eligible - context.MAX_ENTRIES), eligible)
    )


def _check_projection(anchor: str, expected: tuple[context.Entry, ...]) -> None:
    if store.conversation(TEAM, anchor) != expected:
        raise ConfoundedMeasurementError("projection count or order changed")
    if store.conversation(OTHER_TEAM, anchor) != (context.bounded("user", "Other Team only"),):
        raise ConfoundedMeasurementError("second Team projection changed")


def _timed(anchor: str, expected: tuple[context.Entry, ...]) -> float:
    started = time.perf_counter_ns()
    actual = store.conversation(TEAM, anchor)
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
    if actual != expected:
        raise ConfoundedMeasurementError("timed projection changed")
    return elapsed_ms


def _percentiles(values: list[float]) -> dict[str, float | int]:
    ordered = sorted(values)
    return {
        "n": len(ordered),
        "p50_ms": round(ordered[math.ceil(len(ordered) * 0.50) - 1], 3),
        "p95_ms": round(ordered[math.ceil(len(ordered) * 0.95) - 1], 3),
    }


def _case(path: Path, name: str, eligible: int, ineligible: int, long_text: str | None) -> dict[str, object]:
    store.STORE_PATH = path
    anchor = _turn(eligible + ineligible)
    with store._database() as database:
        database.executemany(
            "INSERT INTO transcript (team_id, event_key, payload) VALUES (?, ?, ?)",
            _rows(eligible, ineligible, long_text, anchor),
        )
        version = database.execute("PRAGMA user_version").fetchone()[0]
    if version != store.SCHEMA_VERSION or version != 4:
        raise ConfoundedMeasurementError("history schema changed")
    expected = _expected(eligible, long_text)
    first_ms = _timed(anchor, expected)
    _check_projection(anchor, expected)
    warm = [_timed(anchor, expected) for _ in range(SAMPLES)]
    _check_projection(anchor, expected)
    return {
        "case": name,
        "eligible_rows": eligible,
        "ineligible_tail_rows": ineligible,
        "projected_entries": len(expected),
        "first_read_ms": round(first_ms, 3),
        "warm": _percentiles(warm),
    }


def main() -> int:
    original_path = store.STORE_PATH
    try:
        with tempfile.TemporaryDirectory(prefix="shimpz-history-perf-") as temporary:
            root = Path(temporary)
            _public_encoding_matches(root / "public.sqlite3")
            results = [
                _case(root / f"{name}.sqlite3", name, eligible, ineligible, long_text)
                for name, eligible, ineligible, long_text in CASES
            ]
    except (ConfoundedMeasurementError, OSError, sqlite3.Error, ValueError) as exc:
        print(json.dumps({"status": "error", "error_type": type(exc).__name__}))
        return 1
    else:
        print(
            json.dumps(
                {
                    "status": "ok",
                    "scope": "isolated Admin history read; no chat or provider timing",
                    "samples_per_warm_case": SAMPLES,
                    "first_read_samples_per_case": 1,
                    "os_page_cache": "uncontrolled",
                    "temp_root": tempfile.gettempdir(),
                    "sqlite_version": sqlite3.sqlite_version,
                    "cases": results,
                }
            )
        )
        return 0
    finally:
        store.STORE_PATH = original_path


if __name__ == "__main__":
    raise SystemExit(main())
