"""Bounded one-shot authentication-state projection contracts."""

from __future__ import annotations

import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import authentication_state


class AuthenticationStateProjectionTests(unittest.TestCase):
    def test_emits_each_exact_admitted_state(self) -> None:
        for projected in sorted(authentication_state._ADMITTED_STATES):
            with self.subTest(projected=projected):
                stdout = io.StringIO()
                with (
                    mock.patch.object(
                        authentication_state.state,
                        "classified_authentication_state",
                        return_value=projected,
                    ),
                    contextlib.redirect_stdout(stdout),
                ):
                    self.assertEqual(authentication_state.main(), 0)
                self.assertEqual(stdout.getvalue(), projected)

    def test_store_failure_emits_no_detail(self) -> None:
        stdout = io.StringIO()
        with (
            mock.patch.object(
                authentication_state.state,
                "classified_authentication_state",
                side_effect=RuntimeError("secret store detail"),
            ),
            contextlib.redirect_stdout(stdout),
        ):
            self.assertEqual(authentication_state.main(), 1)
        self.assertEqual(stdout.getvalue(), "")

    def test_unknown_projection_fails_closed(self) -> None:
        stdout = io.StringIO()
        with (
            mock.patch.object(
                authentication_state.state,
                "classified_authentication_state",
                return_value="future-state",
            ),
            contextlib.redirect_stdout(stdout),
        ):
            self.assertEqual(authentication_state.main(), 1)
        self.assertEqual(stdout.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
