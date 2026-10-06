"""In-process rejection and orchestration contracts for Local Admin authentication."""

from __future__ import annotations

import asyncio
import json
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from http_request import LOOPBACK, http_request
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import auth
import local_auth
from mfa import passkeys, tickets, totp

ORIGIN = "http://localhost:7777"


def _request(
    payload: object = None,
    *,
    raw: bytes | None = None,
    origin: str | None = ORIGIN,
    cookies: dict[str, str] | None = None,
    content_type: str | None = "application/json",
    include_length: bool = True,
    length: str | None = None,
) -> Request:
    body = raw if raw is not None else (b"" if payload is None else json.dumps(payload).encode())
    headers: list[tuple[bytes, bytes]] = []
    if content_type is not None:
        headers.append((b"content-type", content_type.encode()))
    if include_length:
        headers.append((b"content-length", (length or str(len(body))).encode()))
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    if cookies:
        encoded = "; ".join(f"{name}={value}" for name, value in cookies.items())
        headers.append((b"cookie", encoded.encode()))
    return http_request("/api/auth-test", LOOPBACK, body=body, headers=headers)


class LocalAuthEdgeTests(unittest.TestCase):
    def test_json_body_boundary_rejects_every_ambiguous_shape(self) -> None:
        cases = (
            (_request({}, content_type="text/plain"), 415),
            (_request({}, length=str(local_auth.MAX_BODY_BYTES + 1)), 413),
            (_request({}, length="invalid"), 400),
            (_request(None, include_length=False), 400),
            (_request(raw=b"x" * (local_auth.MAX_BODY_BYTES + 1), include_length=False), 413),
            (_request(raw=b"{", include_length=False), 400),
            (_request(raw=b"[]", include_length=False), 400),
        )
        for request, expected in cases:
            with self.subTest(expected=expected), self.assertRaises(HTTPException) as raised:
                asyncio.run(local_auth._json_object(request))
            self.assertEqual(raised.exception.status_code, expected)
        accepted = asyncio.run(local_auth._json_object(_request({"ok": True}, include_length=False)))
        self.assertEqual(accepted, {"ok": True})

    def test_json_body_without_length_stops_reading_at_the_authentication_limit(self) -> None:
        chunk = b"x" * 1024
        consumed = 0

        async def receive():
            nonlocal consumed
            consumed += len(chunk)
            return {"type": "http.request", "body": chunk, "more_body": consumed < 80 * 1024}

        request = _request(include_length=False)
        chunked = Request(request.scope, receive)
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(local_auth._json_object(chunked))
        self.assertEqual(raised.exception.status_code, 413)
        self.assertLessEqual(consumed, local_auth.MAX_BODY_BYTES + len(chunk))

    def test_password_ticket_and_totp_failures_map_to_closed_http_outcomes(self) -> None:
        context = local_auth.Context()
        with self.assertRaises(HTTPException) as malformed:
            asyncio.run(local_auth._verify_password(None, context))
        self.assertEqual(malformed.exception.status_code, 400)

        with (
            mock.patch.object(local_auth.state, "get", return_value={}),
            mock.patch.object(local_auth.auth, "attempt_login", mock.AsyncMock(return_value=(False, 12))),
            self.assertRaises(HTTPException) as locked,
        ):
            asyncio.run(local_auth._verify_password("password", context))
        self.assertEqual(locked.exception.status_code, 429)
        self.assertEqual(locked.exception.headers, {"Retry-After": "12"})

        with self.assertRaises(HTTPException) as absent:
            local_auth._ticket(_request({}), context, "login")
        self.assertEqual(absent.exception.status_code, 401)

        changed_origin = context.ticket_store.issue("login", ORIGIN, 2)
        with (
            mock.patch.object(local_auth.state, "factor_generation", return_value=2),
            self.assertRaises(HTTPException) as origin_error,
        ):
            local_auth._ticket(
                _request({}, origin="https://other.example", cookies={local_auth.TICKET_COOKIE: changed_origin}),
                context,
                "login",
            )
        self.assertEqual(origin_error.exception.status_code, 403)

        changed_factor = context.ticket_store.issue("login", ORIGIN, 2)
        with (
            mock.patch.object(local_auth.state, "factor_generation", return_value=3),
            self.assertRaises(HTTPException) as factor_error,
        ):
            local_auth._ticket(
                _request({}, cookies={local_auth.TICKET_COOKIE: changed_factor}),
                context,
                "login",
            )
        self.assertEqual(factor_error.exception.status_code, 409)

        for result, expected in (
            (totp.Verification.LOCKED, 429),
            (totp.Verification.EXPIRED, 409),
            (totp.Verification.CHANGED, 409),
            (totp.Verification.INVALID, 401),
        ):
            with (
                self.subTest(result=result),
                mock.patch.object(local_auth.state, "verify_totp", return_value=result),
                self.assertRaises(HTTPException) as totp_error,
            ):
                local_auth._complete_totp("000000", enrollment=False, generation=2)
            self.assertEqual(totp_error.exception.status_code, expected)

    def test_setup_and_login_reject_wrong_fields_and_resume_exact_enrollment(self) -> None:
        context = local_auth.Context()
        with self.assertRaises(HTTPException) as setup_shape:
            asyncio.run(local_auth.setup(_request({"password": "secret", "extra": True}), context))
        self.assertEqual(setup_shape.exception.status_code, 400)

        with (
            mock.patch.object(local_auth.state, "authentication_state", return_value=auth.RECORD_STATE_CONFIGURED),
            self.assertRaises(HTTPException) as configured,
        ):
            asyncio.run(local_auth.setup(_request({"password": "secret"}), context))
        self.assertEqual(configured.exception.status_code, 409)

        enrollment = totp.Enrollment("A" * 32, "otpauth://exact")
        with (
            mock.patch.object(
                local_auth.state,
                "authentication_state",
                return_value=auth.RECORD_STATE_ENROLLMENT_REQUIRED,
            ),
            mock.patch.object(local_auth, "_verify_password", mock.AsyncMock(return_value={})),
            mock.patch.object(local_auth.state, "resume_totp_enrollment", return_value=enrollment),
            mock.patch.object(local_auth.state, "factor_generation", return_value=2),
        ):
            resumed = asyncio.run(local_auth.setup(_request({"password": "secret"}), context))
        self.assertEqual(resumed.status_code, 202)
        self.assertEqual(json.loads(resumed.body)["enrollment"]["secret"], "A" * 32)

        for handler, payload in (
            (local_auth.confirm_setup, {"extra": True}),
            (local_auth.login, {"extra": True}),
            (local_auth.confirm_login_totp, {"extra": True}),
        ):
            with self.subTest(handler=handler.__name__), self.assertRaises(HTTPException) as shape:
                asyncio.run(handler(_request(payload), context))
            self.assertEqual(shape.exception.status_code, 400)

    def test_login_projects_available_passkey_without_weakening_totp(self) -> None:
        context = local_auth.Context()
        with (
            mock.patch.object(local_auth.state, "active_passkeys", return_value=[{"credential_id": "credential"}]),
            mock.patch.object(local_auth.passkeys, "authentication_options", return_value={"challenge": "exact"}),
        ):
            options = local_auth._login_passkey_options("a" * 32, ORIGIN, 2, context)
        self.assertEqual(options, {"challenge": "exact"})

        with (
            mock.patch.object(local_auth.state, "authentication_state", return_value=auth.RECORD_STATE_CONFIGURED),
            mock.patch.object(local_auth, "_verify_password", mock.AsyncMock(return_value={})),
            mock.patch.object(local_auth.state, "factor_generation", return_value=2),
            mock.patch.object(local_auth, "_login_passkey_options", return_value=options),
        ):
            response = asyncio.run(local_auth.login(_request({"password": "secret"}), context))
        self.assertEqual(json.loads(response.body)["methods"], ["totp", "passkey"])
        self.assertEqual(json.loads(response.body)["passkey_options"], options)

    def test_passkey_availability_helpers_fail_closed(self) -> None:
        self.assertIs(local_auth.passkey_enrollment_available(None), False)
        with (
            mock.patch.object(local_auth, "passkey_enrollment_available", return_value=True),
            mock.patch.object(
                local_auth.state,
                "active_passkeys",
                side_effect=passkeys.PasskeyUnavailableError("invalid state"),
            ),
        ):
            self.assertIs(local_auth.passkey_registered(ORIGIN), False)

    def test_passkey_login_handles_success_conflict_unavailable_and_suspension(self) -> None:
        with self.assertRaises(HTTPException) as shape:
            asyncio.run(local_auth.confirm_login_passkey(_request({"extra": True}), local_auth.Context()))
        self.assertEqual(shape.exception.status_code, 400)

        ticket = tickets.Ticket("login", ORIGIN, 2, time.monotonic() + 30)
        challenge = passkeys.Challenge(b"c" * 32, ORIGIN, "localhost", 2, time.monotonic() + 30)
        original = {"credential_id": "credential"}
        verified = passkeys.Authentication("credential", 2, False, False)
        context = local_auth.Context()
        with (
            mock.patch.object(local_auth, "_ticket", return_value=("b" * 32, ticket)),
            mock.patch.object(context.challenge_store, "consume", return_value=challenge),
            mock.patch.object(local_auth.passkeys, "credential_id", return_value="credential"),
            mock.patch.object(local_auth.state, "passkey_for_authentication", return_value=original),
            mock.patch.object(local_auth.passkeys, "verify_authentication", return_value=verified),
            mock.patch.object(
                local_auth.state,
                "commit_passkey_authentication",
                return_value=("a" * 64, None),
            ),
        ):
            response = asyncio.run(local_auth.confirm_login_passkey(_request({"credential": {}}), context))
        self.assertEqual(json.loads(response.body), {"ok": True, "method": "passkey"})

        changed = passkeys.Challenge(b"c" * 32, ORIGIN, "localhost", 3, time.monotonic() + 30)
        context = local_auth.Context()
        with (
            mock.patch.object(local_auth, "_ticket", return_value=("b" * 32, ticket)),
            mock.patch.object(context.challenge_store, "consume", return_value=changed),
            self.assertRaises(HTTPException) as conflict,
        ):
            asyncio.run(local_auth.confirm_login_passkey(_request({"credential": {}}), context))
        self.assertEqual(conflict.exception.status_code, 409)

        context = local_auth.Context()
        with (
            mock.patch.object(local_auth, "_ticket", return_value=("b" * 32, ticket)),
            mock.patch.object(context.challenge_store, "consume", return_value=challenge),
            mock.patch.object(
                local_auth.passkeys,
                "credential_id",
                side_effect=passkeys.PasskeyUnavailableError("invalid"),
            ),
            self.assertRaises(HTTPException) as unavailable,
        ):
            asyncio.run(local_auth.confirm_login_passkey(_request({"credential": {}}), context))
        self.assertEqual(unavailable.exception.status_code, 401)

        for reason in ("counter-regression", "backup-identity-change"):
            context = local_auth.Context()
            with (
                self.subTest(reason=reason),
                mock.patch.object(local_auth, "_ticket", return_value=("b" * 32, ticket)),
                mock.patch.object(context.challenge_store, "consume", return_value=challenge),
                mock.patch.object(local_auth.passkeys, "credential_id", return_value="credential"),
                mock.patch.object(local_auth.state, "passkey_for_authentication", return_value=original),
                mock.patch.object(local_auth.passkeys, "verify_authentication", return_value=verified),
                mock.patch.object(
                    local_auth.state,
                    "commit_passkey_authentication",
                    return_value=("a" * 64, reason),
                ),
                self.assertLogs("shimpz-admin", level="WARNING") as captured,
                self.assertRaises(HTTPException) as suspended,
            ):
                asyncio.run(local_auth.confirm_login_passkey(_request({"credential": {}}), context))
            self.assertEqual(suspended.exception.status_code, 401)
            messages = [record.getMessage() for record in captured.records]
            self.assertEqual(messages, [f"Local Supervisor passkey suspended: {reason}"])
            self.assertNotIn("a" * 64, " ".join(messages))

    def test_passkey_registration_begin_requires_empty_payload_available_origin_and_fresh_mfa(self) -> None:
        with self.assertRaises(HTTPException) as shape:
            asyncio.run(local_auth.begin_passkey_registration(_request({"extra": True}), local_auth.Context()))
        self.assertEqual(shape.exception.status_code, 400)

        with (
            mock.patch.object(local_auth, "passkey_enrollment_available", return_value=False),
            self.assertRaises(HTTPException) as unavailable,
        ):
            asyncio.run(local_auth.begin_passkey_registration(_request({}), local_auth.Context()))
        self.assertEqual(unavailable.exception.status_code, 409)

        with (
            mock.patch.object(local_auth, "passkey_enrollment_available", return_value=True),
            mock.patch.object(local_auth.auth, "verify_session", return_value=None),
            self.assertRaises(HTTPException) as stale,
        ):
            asyncio.run(local_auth.begin_passkey_registration(_request({}), local_auth.Context()))
        self.assertEqual(stale.exception.status_code, 401)

        token = "s" * 32
        evidence = auth.SessionEvidence(int(time.time()) + auth.TTL, "totp")
        context = local_auth.Context()
        with (
            mock.patch.object(local_auth, "passkey_enrollment_available", return_value=True),
            mock.patch.object(local_auth.auth, "verify_session", return_value=evidence),
            mock.patch.object(local_auth.state, "factor_generation", return_value=2),
            mock.patch.object(local_auth.state, "passkeys_for_registration", return_value=[]),
            mock.patch.object(local_auth.state, "webauthn_user_id", return_value="0" * 64),
            mock.patch.object(local_auth.passkeys, "registration_options", return_value={"challenge": "exact"}),
        ):
            response = asyncio.run(
                local_auth.begin_passkey_registration(
                    _request({}, cookies={local_auth.SESSION_COOKIE: token}),
                    context,
                )
            )
        self.assertEqual(json.loads(response.body), {"options": {"challenge": "exact"}})

    def test_non_ascii_session_cookie_is_refused_as_stale_authentication(self) -> None:
        secret = auth.new_secret()
        body = auth.issue_session(secret, "totp").rpartition(":")[0]
        # The cookie travels as UTF-8 bytes and Starlette decodes it as Latin-1 text the signature check must refuse.
        forged = _request({}, cookies={local_auth.SESSION_COOKIE: f"{body}:{'\u00e9' * 64}"})
        self.assertFalse(forged.cookies[local_auth.SESSION_COOKIE].isascii())
        with (
            mock.patch.object(local_auth, "passkey_enrollment_available", return_value=True),
            mock.patch.object(local_auth.state, "get", return_value={"session_secret": secret}),
            self.assertRaises(HTTPException) as refused,
        ):
            asyncio.run(local_auth.begin_passkey_registration(forged, local_auth.Context()))
        self.assertEqual(refused.exception.status_code, 401)

    def test_passkey_registration_completion_rotates_sessions_and_maps_failures(self) -> None:
        with self.assertRaises(HTTPException) as shape:
            asyncio.run(local_auth.complete_passkey_registration(_request({"extra": True}), local_auth.Context()))
        self.assertEqual(shape.exception.status_code, 400)

        with (
            mock.patch.object(local_auth, "passkey_enrollment_available", return_value=False),
            self.assertRaises(HTTPException) as unavailable_origin,
        ):
            asyncio.run(local_auth.complete_passkey_registration(_request({"credential": {}}), local_auth.Context()))
        self.assertEqual(unavailable_origin.exception.status_code, 409)

        token = "s" * 32
        challenge = passkeys.Challenge(b"c" * 32, ORIGIN, "localhost", 2, time.monotonic() + 30)

        def register(context: local_auth.Context):
            request = _request({"credential": {}}, cookies={local_auth.SESSION_COOKIE: token})
            return asyncio.run(local_auth.complete_passkey_registration(request, context))

        context = local_auth.Context()
        with (
            mock.patch.object(local_auth, "passkey_enrollment_available", return_value=True),
            mock.patch.object(context.challenge_store, "consume", return_value=challenge),
            mock.patch.object(local_auth.state, "factor_generation", return_value=3),
            self.assertRaises(HTTPException) as conflict,
        ):
            register(context)
        self.assertEqual(conflict.exception.status_code, 409)

        context = local_auth.Context()
        with (
            mock.patch.object(local_auth, "passkey_enrollment_available", return_value=True),
            mock.patch.object(context.challenge_store, "consume", return_value=challenge),
            mock.patch.object(local_auth.state, "factor_generation", return_value=2),
            mock.patch.object(
                local_auth.passkeys,
                "verify_registration",
                side_effect=passkeys.PasskeyUnavailableError("invalid"),
            ),
            self.assertRaises(HTTPException) as unavailable,
        ):
            register(context)
        self.assertEqual(unavailable.exception.status_code, 400)

        record = {"credential_id": "credential"}
        context = local_auth.Context()
        with (
            mock.patch.object(local_auth, "passkey_enrollment_available", return_value=True),
            mock.patch.object(context.challenge_store, "consume", return_value=challenge),
            mock.patch.object(local_auth.state, "factor_generation", return_value=2),
            mock.patch.object(local_auth.passkeys, "verify_registration", return_value=record),
            mock.patch.object(local_auth.state, "add_passkey", return_value="a" * 64),
        ):
            response = register(context)
        self.assertEqual(json.loads(response.body), {"registered": True})


if __name__ == "__main__":
    unittest.main()
