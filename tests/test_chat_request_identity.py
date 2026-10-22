"""Each send gets one fresh identity, which Admin forwards to Team exactly (ADR-0092)."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import connection as chat_connection
from chat import payloads as chat_payloads
from protocol.http.v1 import payload as team_contract

T = 1_000_000
PAYLOAD = {
    "message": "Todo dia às 9h, liste as zonas",
    "files": [],
    "assistant_ids": [],
    "locale": "pt",
    "timezone": None,
    "refine": None,
}


class RequestIdentityTests(unittest.TestCase):
    def test_a_send_identity_is_fresh_and_forwarded_exactly(self) -> None:
        identity = chat_connection.request_identity(T)
        self.assertEqual(identity["issued_at"], T)
        self.assertTrue(team_contract.request_identity_fresh(T, T))
        body = chat_payloads.canonical_team_chat_body({**PAYLOAD, "conversation": [], "request": identity})
        self.assertEqual(body["request"], identity)

    def test_every_send_gets_its_own_nonce(self) -> None:
        # Sending the same message again is a new send: it never names an earlier send's identity.
        first = chat_connection.request_identity(T)
        again = chat_connection.request_identity(T)
        self.assertNotEqual(again["nonce"], first["nonce"])


if __name__ == "__main__":
    unittest.main()
