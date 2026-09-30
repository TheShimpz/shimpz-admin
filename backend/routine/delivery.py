"""Deliver Team's Routine notices to each Team's transcript (ADR-0086).

A notice is written before its exact version is acknowledged, so a crash between them only delivers it again, and the
transcript write is idempotent per version.
"""

from __future__ import annotations

from history import store as history

from routine import team

MAX_BATCHES = 32


def deliver() -> int:
    """Write and acknowledge every undelivered notice, one bounded batch at a time; returns how many were written."""
    written = 0
    for _ in range(MAX_BATCHES):
        # A batch is read, written, and acknowledged while no Team deletion or Space reset runs.
        with history.LIFECYCLE_LOCK:
            batch = team.notices()
            for notice in batch["notices"]:
                if not history.append_routine_notice(notice):
                    raise history.HistoryUnavailableError("a Routine notice conflicts with its transcript row")
            if batch["notices"]:
                team.acknowledge(batch["notices"])
        written += len(batch["notices"])
        if not batch["more"]:
            return written
    return written
