"""Security contracts for Local Supervisor passkey state and challenges."""

from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path

from mfa_helper import configure_supervisor

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import state
from mfa import passkeys

NOW = 1_800_000_000
ORIGIN = "http://localhost:7777"


def credential() -> dict[str, object]:
    return {
        "credential_id": "credential_A",
        "public_key": "public_key_A",
        "sign_count": 3,
        "backup_eligible": False,
        "backup_state": False,
        "rp_id": "localhost",
        "origin": ORIGIN,
        "status": "active",
        "created_at": NOW,
        "updated_at": NOW,
        "last_used_at": NOW,
    }


class PasskeyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.previous_path = state.STORE_PATH
        state.STORE_PATH = Path(self.temporary.name) / "admin.json"
        self.addCleanup(setattr, state, "STORE_PATH", self.previous_path)
        with state._STORE_LOCK:
            state._store_cache = None
        configure_supervisor(state, "violet otter lantern quartz 92")

    def test_rp_id_is_exact_host_and_rejects_ip_or_external_http(self) -> None:
        self.assertEqual(passkeys.rp_id_for_origin(ORIGIN), "localhost")
        self.assertEqual(passkeys.rp_id_for_origin("https://admin.example.test:444"), "admin.example.test")
        for origin in ("http://127.0.0.1:7777", "https://127.0.0.1:7777", "http://admin.example.test"):
            with self.subTest(origin=origin), self.assertRaises(passkeys.PasskeyUnavailableError):
                passkeys.rp_id_for_origin(origin)

    def test_challenges_are_exact_binding_single_use_and_bounded(self) -> None:
        clock = [100.0]
        store = passkeys.ChallengeStore(clock=lambda: clock[0], capacity=1, ttl_seconds=30)
        challenge = store.issue("a" * 32, "registration", ORIGIN, 2)

        self.assertEqual(store.consume("a" * 32, "registration"), challenge)
        with self.assertRaises(passkeys.PasskeyUnavailableError):
            store.consume("a" * 32, "registration")

        store.issue("b" * 32, "authentication", ORIGIN, 2)
        with self.assertRaises(passkeys.PasskeyUnavailableError):
            store.issue("c" * 32, "authentication", ORIGIN, 2)
        clock[0] = 131.0
        store.issue("c" * 32, "authentication", ORIGIN, 2)

    def test_registration_rotates_sessions_and_selects_only_the_exact_origin(self) -> None:
        generation = state.factor_generation()
        old_secret = state.get()["session_secret"]
        self.assertEqual(state.passkeys_for_registration(ORIGIN), [])

        new_secret = state.add_passkey(credential(), generation)

        self.assertNotEqual(new_secret, old_secret)
        self.assertEqual(state.active_passkeys(ORIGIN), [credential()])
        self.assertEqual(state.active_passkeys("https://other.example.test"), [])
        with self.assertRaises(passkeys.PasskeyConflictError):
            state.add_passkey(credential(), generation)
        with self.assertRaises(passkeys.PasskeyConflictError):
            state.add_passkey(credential(), state.factor_generation())
        with self.assertRaises(passkeys.PasskeyUnavailableError):
            state.passkey_for_authentication("missing", ORIGIN)

    def test_counter_regression_suspends_the_credential_and_rotates_sessions(self) -> None:
        generation = state.factor_generation()
        state.add_passkey(credential(), generation)
        generation = state.factor_generation()
        original = state.passkey_for_authentication("credential_A", ORIGIN)
        old_secret = state.get()["session_secret"]
        result = passkeys.Authentication("credential_A", 3, False, False)

        new_secret, suspension_reason = state.commit_passkey_authentication(original, result, generation, now=NOW + 1)

        self.assertEqual(suspension_reason, "counter-regression")
        self.assertNotEqual(new_secret, old_secret)
        self.assertEqual(state.active_passkeys(ORIGIN), [])

        replacement = credential()
        replacement["credential_id"] = "credential_B"
        replacement["public_key"] = "public_key_B"
        state.add_passkey(replacement, state.factor_generation())
        self.assertEqual([item["credential_id"] for item in state.get()["passkeys"]], ["credential_B"])

    def test_registration_capacity_counts_active_credentials_before_the_ceremony(self) -> None:
        for index in range(passkeys.MAX_PASSKEYS):
            record = credential()
            record["credential_id"] = f"credential_{index}"
            record["public_key"] = f"public_key_{index}"
            state.add_passkey(record, state.factor_generation())

        with self.assertRaisesRegex(passkeys.PasskeyUnavailableError, "maximum passkey count"):
            state.passkeys_for_registration(ORIGIN)

    def test_successful_assertion_updates_counter_only_against_exact_original(self) -> None:
        state.add_passkey(credential(), state.factor_generation())
        generation = state.factor_generation()
        original = state.passkey_for_authentication("credential_A", ORIGIN)
        result = passkeys.Authentication("credential_A", 4, False, False)

        secret, suspension_reason = state.commit_passkey_authentication(original, result, generation, now=NOW + 1)

        self.assertIsNone(suspension_reason)
        self.assertEqual(secret, state.get()["session_secret"])
        self.assertEqual(state.active_passkeys(ORIGIN)[0]["sign_count"], 4)
        changed = copy.deepcopy(original)
        changed["sign_count"] = 99
        with self.assertRaises(passkeys.PasskeyConflictError):
            state.commit_passkey_authentication(changed, result, generation, now=NOW + 2)
        with self.assertRaises(passkeys.PasskeyConflictError):
            state.commit_passkey_authentication(original, result, generation + 1, now=NOW + 2)

    def test_impossible_backup_state_and_changed_eligibility_fail_closed(self) -> None:
        impossible = credential()
        impossible["backup_state"] = True
        with self.assertRaises(passkeys.PasskeyError):
            state.add_passkey(impossible, state.factor_generation())

        state.add_passkey(credential(), state.factor_generation())
        generation = state.factor_generation()
        original = state.passkey_for_authentication("credential_A", ORIGIN)
        result = passkeys.Authentication("credential_A", 4, True, True)

        _secret, suspension_reason = state.commit_passkey_authentication(original, result, generation, now=NOW + 1)

        self.assertEqual(suspension_reason, "backup-identity-change")
        self.assertEqual(state.active_passkeys(ORIGIN), [])

        state.add_passkey(credential(), state.factor_generation())
        generation = state.factor_generation()
        original = state.passkey_for_authentication("credential_A", ORIGIN)
        impossible_result = passkeys.Authentication("credential_A", 4, False, True)
        _secret, suspension_reason = state.commit_passkey_authentication(
            original,
            impossible_result,
            generation,
            now=NOW + 2,
        )
        self.assertEqual(suspension_reason, "backup-identity-change")

    def test_persisted_passkey_collections_fail_closed(self) -> None:
        with self.assertRaises(passkeys.PasskeyError):
            state._validated_passkey(None)
        wrong_origin = credential()
        wrong_origin["rp_id"] = "other.example"
        with self.assertRaises(passkeys.PasskeyError):
            state._validated_passkey(wrong_origin)
        with self.assertRaises(passkeys.PasskeyError):
            state._validated_passkeys(None)
        with self.assertRaises(passkeys.PasskeyError):
            state._validated_passkeys([credential(), credential()])

        data = state.get()
        data["passkeys"] = [{}]
        state._write(data)
        with self.assertRaises(state.auth.PasswordRecordError):
            state.authentication_state()


if __name__ == "__main__":
    unittest.main()
