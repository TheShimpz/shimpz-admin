"""Security contracts for Local Supervisor passkey state and challenges."""

from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from mfa_helper import configure_supervisor

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import state
from mfa import passkeys
from webauthn.authentication.verify_authentication_response import VerifiedAuthentication
from webauthn.helpers.structs import (
    AttestationFormat,
    AuthenticationCredential,
    AuthenticatorAssertionResponse,
    PublicKeyCredentialType,
)
from webauthn.registration.verify_registration_response import VerifiedRegistration

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

    def test_challenge_limits_and_bindings_fail_closed(self) -> None:
        for limits in ({"capacity": 0}, {"capacity": 1025}, {"ttl_seconds": 29}, {"ttl_seconds": 301}):
            with self.subTest(limits=limits), self.assertRaises(ValueError):
                passkeys.ChallengeStore(**limits)

        store = passkeys.ChallengeStore()
        for binding, ceremony, generation in (
            (None, "registration", 1),
            ("a" * 32, "invalid", 1),
            ("a" * 32, "registration", True),
        ):
            with (
                self.subTest(binding=binding, ceremony=ceremony, generation=generation),
                self.assertRaises((ValueError, passkeys.PasskeyUnavailableError)),
            ):
                store.issue(binding, ceremony, ORIGIN, generation)
        store.clear()

    def test_rp_id_rejects_noncanonical_and_credential_origins(self) -> None:
        with self.assertRaises(passkeys.PasskeyUnavailableError):
            passkeys.rp_id_for_origin("HTTPS://admin.example.test")
        credential_origin = "https://user:secret@admin.example.test"
        with (
            mock.patch.object(passkeys, "canonical_origin", return_value=credential_origin),
            self.assertRaises(passkeys.PasskeyUnavailableError),
        ):
            passkeys.rp_id_for_origin(credential_origin)

    @staticmethod
    def challenge() -> passkeys.Challenge:
        return passkeys.Challenge(b"c" * 32, ORIGIN, "localhost", 2, NOW + 30)

    def test_option_generation_binds_uv_and_maps_invalid_state(self) -> None:
        challenge = self.challenge()
        generated = object()
        with (
            mock.patch.object(
                passkeys,
                "generate_registration_options",
                autospec=True,
                return_value=generated,
            ) as registration,
            mock.patch.object(
                passkeys,
                "options_to_json",
                autospec=True,
                return_value='{"kind":"registration"}',
            ),
        ):
            options = passkeys.registration_options(challenge, "00" * 32, [credential()])
        self.assertEqual(options, {"kind": "registration"})
        registration_arguments = registration.call_args.kwargs
        self.assertEqual(registration_arguments["rp_id"], challenge.rp_id)
        self.assertEqual(registration_arguments["rp_name"], passkeys.RP_NAME)
        self.assertEqual(registration_arguments["user_name"], "Supervisor")
        self.assertEqual(registration_arguments["user_id"], bytes.fromhex("00" * 32))
        self.assertEqual(registration_arguments["challenge"], challenge.challenge)
        self.assertEqual(registration_arguments["timeout"], passkeys.CEREMONY_TIMEOUT_MS)
        self.assertEqual(len(registration_arguments["exclude_credentials"]), 1)
        selection = registration_arguments["authenticator_selection"]
        self.assertIs(selection.user_verification, passkeys.UserVerificationRequirement.REQUIRED)

        with self.assertRaises(passkeys.PasskeyError):
            passkeys._descriptors([{}])
        with self.assertRaises(passkeys.PasskeyError):
            passkeys.registration_options(challenge, "not-hex", [])
        with self.assertRaises(passkeys.PasskeyUnavailableError):
            passkeys.authentication_options(challenge, [])

        with (
            mock.patch.object(
                passkeys,
                "generate_authentication_options",
                autospec=True,
                return_value=generated,
            ) as authentication,
            mock.patch.object(
                passkeys,
                "options_to_json",
                autospec=True,
                return_value='{"kind":"authentication"}',
            ),
        ):
            self.assertEqual(
                passkeys.authentication_options(challenge, [credential()]),
                {"kind": "authentication"},
            )
        authentication_arguments = authentication.call_args.kwargs
        self.assertEqual(authentication_arguments["rp_id"], challenge.rp_id)
        self.assertEqual(authentication_arguments["challenge"], challenge.challenge)
        self.assertEqual(authentication_arguments["timeout"], passkeys.CEREMONY_TIMEOUT_MS)
        self.assertEqual(len(authentication_arguments["allow_credentials"]), 1)
        self.assertIs(
            authentication_arguments["user_verification"],
            passkeys.UserVerificationRequirement.REQUIRED,
        )
        with (
            mock.patch.object(
                passkeys,
                "generate_authentication_options",
                autospec=True,
                return_value=generated,
            ),
            mock.patch.object(passkeys, "options_to_json", autospec=True, side_effect=ValueError),
            self.assertRaises(passkeys.PasskeyError),
        ):
            passkeys.authentication_options(challenge, [credential()])

    def test_registration_verification_projects_only_public_state(self) -> None:
        verified = VerifiedRegistration(
            credential_id=b"credential-id",
            credential_public_key=b"public-key",
            sign_count=7,
            aaguid="00000000-0000-0000-0000-000000000000",
            fmt=AttestationFormat.NONE,
            credential_type=PublicKeyCredentialType.PUBLIC_KEY,
            user_verified=True,
            attestation_object=b"attestation",
            credential_device_type=passkeys.CredentialDeviceType.MULTI_DEVICE,
            credential_backed_up=True,
        )
        credential_payload = {"credential": "response"}
        challenge = self.challenge()
        with mock.patch.object(
            passkeys,
            "verify_registration_response",
            autospec=True,
            return_value=verified,
        ) as verify:
            record = passkeys.verify_registration(challenge, credential_payload, NOW)

        self.assertEqual(record["sign_count"], 7)
        self.assertEqual(record["backup_eligible"], True)
        self.assertEqual(record["backup_state"], True)
        self.assertEqual(record["rp_id"], "localhost")
        self.assertEqual(record["origin"], ORIGIN)
        self.assertNotIn("challenge", record)
        self.assertEqual(
            verify.call_args.kwargs,
            {
                "credential": credential_payload,
                "expected_challenge": challenge.challenge,
                "expected_rp_id": challenge.rp_id,
                "expected_origin": challenge.origin,
                "require_user_verification": True,
            },
        )

        with (
            mock.patch.object(
                passkeys,
                "verify_registration_response",
                autospec=True,
                side_effect=TypeError,
            ),
            self.assertRaises(passkeys.PasskeyUnavailableError),
        ):
            passkeys.verify_registration(self.challenge(), None, NOW)

    def test_authentication_verification_is_bounded_and_fail_closed(self) -> None:
        parsed = AuthenticationCredential(
            id="Y3JlZGVudGlhbC1pZA",
            raw_id=b"credential-id",
            response=AuthenticatorAssertionResponse(b"client", b"authenticator", b"signature"),
        )
        with mock.patch.object(
            passkeys,
            "parse_authentication_credential_json",
            autospec=True,
            return_value=parsed,
        ):
            self.assertEqual(passkeys.credential_id({}), "Y3JlZGVudGlhbC1pZA")
        with self.assertRaises(passkeys.PasskeyUnavailableError):
            passkeys.credential_id(None)
        with (
            mock.patch.object(
                passkeys,
                "parse_authentication_credential_json",
                autospec=True,
                return_value=parsed,
            ),
            mock.patch.object(passkeys, "bytes_to_base64url", return_value="."),
            self.assertRaises(passkeys.PasskeyUnavailableError),
        ):
            passkeys.credential_id({})

        verified = VerifiedAuthentication(
            credential_id=b"credential-id",
            new_sign_count=8,
            credential_device_type=passkeys.CredentialDeviceType.SINGLE_DEVICE,
            credential_backed_up=False,
            user_verified=True,
        )
        challenge = self.challenge()
        stored = credential()
        credential_payload = {"credential": "response"}
        with (
            mock.patch.object(
                passkeys,
                "parse_authentication_credential_json",
                autospec=True,
                return_value=parsed,
            ) as parse,
            mock.patch.object(
                passkeys,
                "verify_authentication_response",
                autospec=True,
                return_value=verified,
            ) as verify,
        ):
            result = passkeys.verify_authentication(challenge, credential_payload, stored)
        self.assertEqual(result, passkeys.Authentication("Y3JlZGVudGlhbC1pZA", 8, False, False))
        parse.assert_called_once_with(credential_payload)
        self.assertEqual(
            verify.call_args.kwargs,
            {
                "credential": parsed,
                "expected_challenge": challenge.challenge,
                "expected_rp_id": challenge.rp_id,
                "expected_origin": challenge.origin,
                "credential_public_key": passkeys.base64url_to_bytes(str(stored["public_key"])),
                "credential_current_sign_count": 0,
                "require_user_verification": True,
            },
        )

        with (
            mock.patch.object(
                passkeys,
                "parse_authentication_credential_json",
                autospec=True,
                side_effect=TypeError,
            ),
            self.assertRaises(passkeys.PasskeyUnavailableError),
        ):
            passkeys.verify_authentication(self.challenge(), None, credential())
        with (
            mock.patch.object(
                passkeys,
                "parse_authentication_credential_json",
                autospec=True,
                return_value=parsed,
            ),
            mock.patch.object(
                passkeys,
                "verify_authentication_response",
                autospec=True,
                side_effect=passkeys.WebAuthnException("stored key is invalid"),
            ),
            self.assertRaises(passkeys.PasskeyError),
        ):
            passkeys.verify_authentication(self.challenge(), {}, credential())

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
