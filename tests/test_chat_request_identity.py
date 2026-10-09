"""Each logical send gets one sealed identity, which only its own resend can reuse while Team admits it (ADR-0092)."""

import sys
import unittest
from pathlib import Path
from unittest import mock

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
}


def _team_body(identity: dict[str, object]) -> dict[str, object]:
    """The exact Team chat body Admin forwards for this send, admitted by the Team protocol mirror."""
    return chat_payloads.canonical_team_chat_body({**PAYLOAD, "conversation": [], "request": identity})


class RequestIdentityTests(unittest.TestCase):
    def test_a_resend_keeps_its_identity_exactly_while_team_would_admit_it(self) -> None:
        identity, seal = chat_connection.request_identity("team_1", None, PAYLOAD, T)
        self.assertEqual(identity["issued_at"], T)
        self.assertEqual(_team_body(identity)["request"], identity)
        # The joined Admin to Team path: a resend at 899 s forwards the original identity, which Team still admits;
        # from 900 s Admin refuses it itself, the same second Team's predicate and receipt expire.
        for elapsed, admitted in ((899, True), (900, False), (901, False)):
            with self.subTest(elapsed=elapsed):
                resent = chat_connection.request_identity("team_1", seal, dict(PAYLOAD), T + elapsed)
                self.assertEqual(resent is not None, admitted)
                self.assertEqual(team_contract.request_identity_fresh(T, T + elapsed), admitted)
                if resent is not None:
                    self.assertEqual(resent, (identity, seal))

    def test_a_first_send_never_claims_another_sends_identity(self) -> None:
        first, _seal = chat_connection.request_identity("team_1", None, PAYLOAD, T)
        # Replaying the original first-send frame, later or after any restart, is a new logical send with a fresh
        # nonce: no frame can name an earlier identity except through that send's own seal.
        again, _again = chat_connection.request_identity("team_1", None, PAYLOAD, T + 2_000)
        self.assertNotEqual(again["nonce"], first["nonce"])
        self.assertEqual(again["issued_at"], T + 2_000)

    def test_an_altered_foreign_or_pre_restart_seal_is_refused_never_renewed(self) -> None:
        _identity, seal = chat_connection.request_identity("team_1", None, PAYLOAD, T)
        issued, nonce, tag = seal.split(".")
        for team_id, candidate, payload in (
            ("team_2", seal, PAYLOAD),
            ("team_1", seal, {**PAYLOAD, "message": "Outra coisa"}),
            ("team_1", f"{int(issued) + 1}.{nonce}.{tag}", PAYLOAD),
            ("team_1", f"{issued}.{'b' * 32}.{tag}", PAYLOAD),
            ("team_1", f"{issued}.{nonce}.{'0' * 64}", PAYLOAD),
            ("team_1", "not-a-seal", PAYLOAD),
        ):
            with self.subTest(team_id=team_id, candidate=candidate):
                self.assertIsNone(chat_connection.request_identity(team_id, candidate, payload, T + 1))
        # A restart starts with a new key: no seal issued before it verifies any more.
        with mock.patch.object(chat_connection, "_SEAL_KEY", b"\x00" * 32):
            self.assertIsNone(chat_connection.request_identity("team_1", seal, PAYLOAD, T + 1))
        self.assertIsNotNone(chat_connection.request_identity("team_1", seal, PAYLOAD, T + 1))

    def test_only_null_or_a_seal_names_a_send(self) -> None:
        _identity, seal = chat_connection.request_identity("team_1", None, PAYLOAD, T)
        self.assertTrue(chat_connection.valid_sent_request(None))
        self.assertTrue(chat_connection.valid_sent_request(seal))
        for value in ({"nonce": "a" * 32, "resend": True}, "0." + "a" * 32 + "." + "b" * 64, seal.upper(), 7):
            with self.subTest(value=value):
                self.assertFalse(chat_connection.valid_sent_request(value))


if __name__ == "__main__":
    unittest.main()
