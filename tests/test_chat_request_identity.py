"""Each logical send keeps one request identity across retries, resends, and reconnects (ADR-0092)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import connection as chat_connection
from protocol.http.v1 import payload as team_contract

NONCE = "a" * 32
PAYLOAD = {
    "message": "Todo dia às 9h, liste as zonas",
    "files": [],
    "assistant_ids": [],
    "locale": "pt",
    "timezone": None,
}


class Clock:
    def __init__(self, now: int = 1_000_000) -> None:
        self.now = now

    def __call__(self) -> float:
        return float(self.now)


def _sent(nonce: str = NONCE, *, resend: bool = False) -> dict[str, object]:
    return {"nonce": nonce, "resend": resend}


class RequestIdentityTests(unittest.TestCase):
    def test_a_resend_keeps_its_identity_exactly_while_team_would_admit_it(self) -> None:
        clock = Clock()
        book = chat_connection.RequestBook(clock)
        first = book.identity("team_1", _sent(), PAYLOAD)
        self.assertEqual(first, {"issued_at": 1_000_000, "nonce": NONCE})
        # The joined Admin to Team path: what Admin forwards at 899 s is fresh where Team judges it; from 900 s
        # Admin refuses the resend itself, the same second Team's predicate and receipt expire.
        for elapsed, admitted in ((899, True), (900, False), (901, False)):
            clock.now = 1_000_000 + elapsed
            with self.subTest(elapsed=elapsed):
                forwarded = book.identity("team_1", _sent(resend=True), dict(PAYLOAD))
                self.assertEqual(forwarded is not None, admitted)
                self.assertEqual(team_contract.request_identity_fresh(1_000_000, clock.now), admitted)
                if forwarded is not None:
                    self.assertEqual(forwarded, first)

    def test_a_reconnect_resends_through_the_same_process_wide_book(self) -> None:
        book = chat_connection.RequestBook(Clock())
        first = book.identity("team_1", _sent(), PAYLOAD)
        # A new connection carries no state of its own: the browser's nonce finds the same identity.
        chat_connection.Connection()
        self.assertEqual(book.identity("team_1", _sent(resend=True), PAYLOAD), first)

    def test_an_unknown_mismatched_or_reused_send_is_refused_never_renewed(self) -> None:
        book = chat_connection.RequestBook(Clock())
        book.identity("team_1", _sent(), PAYLOAD)
        for team_id, sent, payload in (
            ("team_1", _sent("b" * 32, resend=True), PAYLOAD),
            ("team_2", _sent(resend=True), PAYLOAD),
            ("team_1", _sent(resend=True), {**PAYLOAD, "message": "Outra coisa"}),
            ("team_1", _sent(), PAYLOAD),
        ):
            with self.subTest(team_id=team_id, sent=sent):
                self.assertIsNone(book.identity(team_id, sent, payload))
        self.assertEqual(book.identity("team_2", _sent(), PAYLOAD)["nonce"], NONCE)

    def test_a_full_book_lets_its_oldest_send_go_and_then_refuses_resending_it(self) -> None:
        clock = Clock()
        book = chat_connection.RequestBook(clock)
        for index in range(chat_connection.MAX_SENT_REQUESTS):
            clock.now = 1_000_000 + index % 2
            book.identity("team_1", _sent(f"{index:032x}"), PAYLOAD)
        book.identity("team_1", _sent("f" * 32), PAYLOAD)
        self.assertIsNone(book.identity("team_1", _sent(f"{0:032x}", resend=True), PAYLOAD))
        self.assertIsNotNone(book.identity("team_1", _sent(f"{1:032x}", resend=True), PAYLOAD))

    def test_only_a_canonical_sent_request_is_admitted(self) -> None:
        self.assertEqual(chat_connection.canonical_sent_request(_sent()), _sent())
        for value in (
            None,
            {"nonce": NONCE},
            {**_sent(), "issued_at": 1},
            {"nonce": NONCE, "resend": 0},
            {"nonce": "A" * 32, "resend": False},
            {"nonce": 7, "resend": False},
        ):
            with self.subTest(value=value):
                self.assertIsNone(chat_connection.canonical_sent_request(value))


if __name__ == "__main__":
    unittest.main()
