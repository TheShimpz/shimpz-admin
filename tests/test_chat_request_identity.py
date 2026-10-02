"""Each sent message has one request identity, kept when the same message is sent again (ADR-0092)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import connection as chat_connection

PAYLOAD = {
    "message": "Todo dia às 9h, liste as zonas",
    "files": [],
    "assistant_ids": [],
    "locale": "pt",
    "timezone": None,
}


class RequestIdentityTests(unittest.TestCase):
    def test_a_resend_of_the_same_message_keeps_its_identity_while_team_would_admit_it(self) -> None:
        connection = chat_connection.Connection()
        with mock.patch.object(chat_connection.time, "time", return_value=1_000_000):
            first = chat_connection.request_identity(connection, "team_1", PAYLOAD)
            self.assertEqual(chat_connection.request_identity(connection, "team_1", dict(PAYLOAD)), first)
        self.assertEqual(first["issued_at"], 1_000_000)
        self.assertRegex(first["nonce"], r"\A[0-9a-f]{32}\Z")
        later = 1_000_000 + chat_connection.REQUEST_REUSE_SECONDS
        with mock.patch.object(chat_connection.time, "time", return_value=later - 1):
            self.assertEqual(chat_connection.request_identity(connection, "team_1", PAYLOAD), first)
        with mock.patch.object(chat_connection.time, "time", return_value=later):
            renewed = chat_connection.request_identity(connection, "team_1", PAYLOAD)
        self.assertNotEqual(renewed["nonce"], first["nonce"])

    def test_another_message_or_team_is_a_new_request(self) -> None:
        connection = chat_connection.Connection()
        first = chat_connection.request_identity(connection, "team_1", PAYLOAD)
        other = chat_connection.request_identity(connection, "team_1", {**PAYLOAD, "message": "Outra coisa"})
        self.assertNotEqual(other["nonce"], first["nonce"])
        self.assertNotEqual(
            chat_connection.request_identity(connection, "team_2", {**PAYLOAD, "message": "Outra coisa"}), other
        )
        # Only the latest sent message is remembered.
        self.assertNotEqual(chat_connection.request_identity(connection, "team_1", PAYLOAD), first)


if __name__ == "__main__":
    unittest.main()
