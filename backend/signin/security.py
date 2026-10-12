"""The Supervisor's own view of its sign-in security (ADR-0051).

It holds the sign-in before this one and the refused attempts since (read back from the authentication journal), the
reported second-factor failures, and the recovery codes left. A successful sign-in reports the second-factor attempts
refused since the previous one, and Admin keeps reporting them after every later sign-in until the Supervisor
acknowledges them. An acknowledgment names how many it saw, so a refusal that arrives while the report is on screen is
never dismissed unseen.
"""

import logging

import state
from signin import audit, auth

log = logging.getLogger("shimpz-admin")


class SessionEndedError(RuntimeError):
    """The session the summary was asked for is no longer current."""


def _history(session: str) -> dict[str, object] | None:
    """The sign-in before this session's and the refused attempts since, or None while the journal is unreadable."""
    evidence = auth.verify_session(state.get()["session_secret"], session)
    if evidence is None:
        raise SessionEndedError("the session is no longer current")
    try:
        return audit.sign_in_history(evidence.issued_at)
    except OSError, audit.HistoryUnavailableError:
        log.warning("Local Supervisor sign-in history is unavailable")
        return None


def summary_for(session: str) -> dict[str, object]:
    """The sign-in security summary the session socket's `security.summary` and an acknowledgment answer."""
    return {
        "failed_second_factor_attempts": state.unacknowledged_second_factor_failures(),
        "recovery_codes_remaining": state.recovery_codes_remaining(),
        "sign_in_history": _history(session),
    }


def acknowledged_count(payload: dict) -> int | None:
    """The positive count an acknowledgment names, as its only member, or None."""
    count = payload.get("acknowledged") if set(payload) == {"acknowledged"} else None
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= state.MAX_SECOND_FACTOR_FAILURES:
        return None
    return count


def acknowledge(session: str, count: int) -> dict[str, object]:
    """Acknowledge exactly the refused attempts the Supervisor saw, and answer the summary after it."""
    state.acknowledge_second_factor_failures(count)
    return summary_for(session)
