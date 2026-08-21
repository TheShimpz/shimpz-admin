"""Security contracts for bounded Local Supervisor password tickets."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from mfa import tickets


class TicketStoreTests(unittest.TestCase):
    def test_limits_and_bindings_fail_closed(self) -> None:
        for limits in ({"capacity": 0}, {"capacity": 1025}, {"ttl_seconds": 29}, {"ttl_seconds": 301}):
            with self.subTest(limits=limits), self.assertRaises(ValueError):
                tickets.TicketStore(**limits)

        store = tickets.TicketStore()
        for purpose, generation in (("invalid", 1), ("login", True), ("login", 0)):
            with self.subTest(purpose=purpose, generation=generation), self.assertRaises(ValueError):
                store.issue(purpose, None, generation)

    def test_tokens_are_unique_bounded_and_one_use(self) -> None:
        clock = [100.0]
        store = tickets.TicketStore(clock=lambda: clock[0], capacity=2, ttl_seconds=30)
        first = "a" * 43
        second = "b" * 43
        with mock.patch.object(tickets.secrets, "token_urlsafe", side_effect=(first, first, second)):
            self.assertEqual(store.issue("login", None, 1), first)
            self.assertEqual(store.issue("totp-enrollment", "https://admin.example", 2), second)

        with self.assertRaises(tickets.TicketError):
            store.issue("login", None, 1)
        consumed = store.consume(first, "login")
        self.assertEqual((consumed.purpose, consumed.origin, consumed.generation), ("login", None, 1))
        with self.assertRaises(tickets.TicketError):
            store.consume(first, "login")
        with self.assertRaises(tickets.TicketError):
            store.consume(second, "login")

    def test_expiry_malformed_tokens_and_clear_invalidate_authority(self) -> None:
        clock = [100.0]
        store = tickets.TicketStore(clock=lambda: clock[0], ttl_seconds=30)
        expired = store.issue("login", None, 1)
        clock[0] += 30
        replacement = store.issue("login", None, 1)

        with self.assertRaises(tickets.TicketError):
            store.consume(expired, "login")
        for malformed in (None, "short", "é" * 32, "x" * 65):
            with self.subTest(token=malformed), self.assertRaises(tickets.TicketError):
                store.consume(malformed, "login")

        store.clear()
        with self.assertRaises(tickets.TicketError):
            store.consume(replacement, "login")


if __name__ == "__main__":
    unittest.main()
