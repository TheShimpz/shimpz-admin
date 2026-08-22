"""Emit the bounded Local Supervisor authentication-state admission contract."""

import sys

import auth
import state

_ADMITTED_STATES = frozenset(
    {
        auth.RECORD_STATE_UNINITIALIZED,
        auth.RECORD_STATE_ENROLLMENT_REQUIRED,
        auth.RECORD_STATE_CONFIGURED,
        auth.RECORD_STATE_RECOVERY_REQUIRED,
    }
)


def main() -> int:
    """Write exactly one admitted state, or fail without projecting store details."""
    try:
        authentication_state = state.classified_authentication_state()
    except OSError, RuntimeError:
        return 1
    if authentication_state not in _ADMITTED_STATES:
        return 1
    sys.stdout.write(authentication_state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
