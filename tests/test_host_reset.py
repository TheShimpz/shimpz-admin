"""Host-capability contracts for Local Space reset."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from mfa_helper import configure_supervisor
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import host_reset
import state

SPACE_ID = "space-0123456789abcdef01234567"
CAPABILITY = "a" * 64


def _request(payload: dict[str, object]) -> Request:
    body = json.dumps(payload).encode()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "DELETE",
        "scheme": "http",
        "path": "/api/space/host",
        "raw_path": b"/api/space/host",
        "query_string": b"",
        "root_path": "",
        "headers": [(b"content-type", b"application/json")],
        "client": ("172.18.0.1", 1234),
        "server": ("admin", 4600),
    }

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive)


async def _read_json(request: Request) -> dict:
    return await request.json()


class HostResetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.capability_path = root / "capability.json"
        self.previous_capability_path = host_reset.CAPABILITY_PATH
        self.previous_store_path = state.STORE_PATH
        host_reset.CAPABILITY_PATH = self.capability_path
        state.STORE_PATH = root / "admin.json"
        self.addCleanup(setattr, host_reset, "CAPABILITY_PATH", self.previous_capability_path)
        self.addCleanup(setattr, state, "STORE_PATH", self.previous_store_path)
        self.environment = mock.patch.dict(os.environ, {"SHIMPZ_SPACE_ID": SPACE_ID})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        with state._STORE_LOCK:
            state._store_cache = None
        self.write_capability()

    def write_capability(self, *, created_at: int | None = None, expires_at: int | None = None) -> None:
        now = int(time.time())
        document = {
            "version": 1,
            "purpose": "space-reset",
            "space_id": SPACE_ID,
            "created_at": now if created_at is None else created_at,
            "expires_at": now + 120 if expires_at is None else expires_at,
            "capability_sha256": hashlib.sha256(bytes.fromhex(CAPABILITY)).hexdigest(),
        }
        self.capability_path.write_text(json.dumps(document), encoding="utf-8")
        self.capability_path.chmod(0o600)

    def test_file_verifier_is_exact_bounded_and_rejects_expiry_or_wrong_secret(self) -> None:
        digest, expires_at = host_reset.verify_capability(CAPABILITY)

        self.assertEqual(digest, hashlib.sha256(bytes.fromhex(CAPABILITY)).hexdigest())
        self.assertGreater(expires_at, int(time.time()))
        with self.assertRaises(host_reset.HostResetCapabilityError):
            host_reset.verify_capability("b" * 64)

        now = int(time.time())
        self.write_capability(created_at=now - 121, expires_at=now - 1)
        with self.assertRaises(host_reset.HostResetCapabilityError):
            host_reset.verify_capability(CAPABILITY, now=now)

    def test_file_verifier_rejects_unsafe_mode_link_and_space_binding(self) -> None:
        self.capability_path.chmod(0o644)
        with self.assertRaises(host_reset.HostResetCapabilityError):
            host_reset.verify_capability(CAPABILITY)

    def test_file_verifier_rejects_truncation_invalid_inputs_and_malformed_json(self) -> None:
        with (
            mock.patch.object(host_reset.os, "read", return_value=b"{}"),
            self.assertRaises(host_reset.HostResetCapabilityError),
        ):
            host_reset.verify_capability(CAPABILITY)
        with (
            mock.patch.dict(os.environ, {"SHIMPZ_SPACE_ID": "invalid"}),
            self.assertRaises(host_reset.HostResetCapabilityError),
        ):
            host_reset.verify_capability(CAPABILITY)
        with self.assertRaises(host_reset.HostResetCapabilityError):
            host_reset.verify_capability(None)
        with self.assertRaises(ValueError):
            host_reset.verify_capability(CAPABILITY, now=True)

        self.capability_path.write_text("[]", encoding="utf-8")
        self.capability_path.chmod(0o600)
        with self.assertRaises(host_reset.HostResetCapabilityError):
            host_reset.verify_capability(CAPABILITY)
        self.capability_path.write_bytes(b"{")
        self.capability_path.chmod(0o600)
        with self.assertRaises(host_reset.HostResetCapabilityError):
            host_reset.verify_capability(CAPABILITY)

        self.write_capability()
        link = self.capability_path.with_name("link.json")
        link.symlink_to(self.capability_path)
        host_reset.CAPABILITY_PATH = link
        with self.assertRaises(host_reset.HostResetCapabilityError):
            host_reset.verify_capability(CAPABILITY)

        host_reset.CAPABILITY_PATH = self.capability_path
        with (
            mock.patch.dict(
                os.environ,
                {"SHIMPZ_SPACE_ID": "space-aaaaaaaaaaaaaaaaaaaaaaaa"},
            ),
            self.assertRaises(host_reset.HostResetCapabilityError),
        ):
            host_reset.verify_capability(CAPABILITY)

    def test_uninitialized_reset_requires_only_host_capability_and_is_one_use(self) -> None:
        bootstrap = mock.Mock(return_value=JSONResponse({"reset": True}))
        password = mock.AsyncMock()
        established = mock.Mock()

        response = asyncio.run(
            host_reset.reset(
                _request({"capability": CAPABILITY}),
                setup_lock=asyncio.Lock(),
                read_json=_read_json,
                verify_password=password,
                bootstrap_reset=bootstrap,
                established_reset=established,
            )
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        bootstrap.assert_called_once_with()
        password.assert_not_awaited()
        established.assert_not_called()
        with self.assertRaises(HTTPException) as replay:
            asyncio.run(
                host_reset.reset(
                    _request({"capability": CAPABILITY}),
                    setup_lock=asyncio.Lock(),
                    read_json=_read_json,
                    verify_password=password,
                    bootstrap_reset=bootstrap,
                    established_reset=established,
                )
            )
        self.assertEqual(replay.exception.status_code, 403)

    def test_reset_rejects_invalid_payloads_and_reports_busy_authority(self) -> None:
        with self.assertRaises(HTTPException) as unavailable:
            asyncio.run(
                host_reset.reset(
                    _request({"capability": None}),
                    setup_lock=asyncio.Lock(),
                    read_json=_read_json,
                    verify_password=mock.AsyncMock(),
                    bootstrap_reset=mock.Mock(),
                    established_reset=mock.Mock(),
                )
            )
        self.assertEqual(unavailable.exception.status_code, 403)

        async def while_busy():
            lock = asyncio.Lock()
            await lock.acquire()
            try:
                return await host_reset.reset(
                    _request({"capability": CAPABILITY}),
                    setup_lock=lock,
                    read_json=_read_json,
                    verify_password=mock.AsyncMock(),
                    bootstrap_reset=mock.Mock(),
                    established_reset=mock.Mock(),
                )
            finally:
                lock.release()

        busy = asyncio.run(while_busy())
        self.assertEqual(busy.status_code, 409)
        self.assertEqual(json.loads(busy.body)["code"], "host-reset-busy")

        with self.assertRaises(HTTPException) as extra:
            asyncio.run(
                host_reset.reset(
                    _request({"capability": CAPABILITY, "password": "unexpected"}),
                    setup_lock=asyncio.Lock(),
                    read_json=_read_json,
                    verify_password=mock.AsyncMock(),
                    bootstrap_reset=mock.Mock(),
                    established_reset=mock.Mock(),
                )
            )
        self.assertEqual(extra.exception.status_code, 400)

    def test_consumption_remembers_every_unexpired_capability(self) -> None:
        now = int(time.time())
        digest_a = "a" * 64
        digest_b = "b" * 64

        self.assertIs(state.consume_host_reset_capability(digest_a, now + 120, now=now), True)
        self.assertIs(state.consume_host_reset_capability(digest_b, now + 120, now=now), True)
        self.assertIs(state.consume_host_reset_capability(digest_a, now + 120, now=now), False)

        self.assertIs(state.consume_host_reset_capability("c" * 64, now + 241, now=now + 121), True)
        self.assertEqual(state.get()["consumed_host_resets"], [{"digest": "c" * 64, "expires_at": now + 241}])

    def test_initialized_reset_requires_password_and_uses_established_authority(self) -> None:
        configure_supervisor(state, "violet otter lantern quartz 92")
        password = mock.AsyncMock()
        established = mock.Mock(return_value=JSONResponse({"reset": True}))

        missing = asyncio.run(
            host_reset.reset(
                _request({"capability": CAPABILITY}),
                setup_lock=asyncio.Lock(),
                read_json=_read_json,
                verify_password=password,
                bootstrap_reset=mock.Mock(),
                established_reset=established,
            )
        )
        response = asyncio.run(
            host_reset.reset(
                _request({"capability": CAPABILITY, "password": "secret"}),
                setup_lock=asyncio.Lock(),
                read_json=_read_json,
                verify_password=password,
                bootstrap_reset=mock.Mock(),
                established_reset=established,
            )
        )

        self.assertEqual(missing.status_code, 409)
        self.assertEqual(json.loads(missing.body)["code"], "supervisor-password-required")
        self.assertEqual(response.status_code, 200)
        password.assert_awaited_once_with("secret")
        established.assert_called_once_with(hashlib.sha256(bytes.fromhex(CAPABILITY)).hexdigest())

    def test_recovery_reset_uses_host_capability_and_remaining_supervisor_identity(self) -> None:
        configure_supervisor(state, "violet otter lantern quartz 92")
        data = state.get()
        data["auth_version"] = 999
        state._write(data)
        established = mock.Mock(return_value=JSONResponse({"reset": True}))
        password = mock.AsyncMock()

        response = asyncio.run(
            host_reset.reset(
                _request({"capability": CAPABILITY}),
                setup_lock=asyncio.Lock(),
                read_json=_read_json,
                verify_password=password,
                bootstrap_reset=mock.Mock(),
                established_reset=established,
            )
        )

        self.assertEqual(response.status_code, 200)
        password.assert_not_awaited()
        established.assert_called_once_with(hashlib.sha256(bytes.fromhex(CAPABILITY)).hexdigest())

    def test_recovery_reset_defers_to_team_when_supervisor_identity_is_absent(self) -> None:
        configure_supervisor(state, "violet otter lantern quartz 92")
        data = state.get()
        data["auth_version"] = 999
        data.pop("supervisor_id")
        data.pop("supervisor_signing_key")
        state._write(data)
        bootstrap = mock.Mock(return_value=JSONResponse({"reset": True}))

        response = asyncio.run(
            host_reset.reset(
                _request({"capability": CAPABILITY}),
                setup_lock=asyncio.Lock(),
                read_json=_read_json,
                verify_password=mock.AsyncMock(),
                bootstrap_reset=bootstrap,
                established_reset=mock.Mock(),
            )
        )

        self.assertEqual(response.status_code, 200)
        bootstrap.assert_called_once_with()

    def test_recovery_reset_rejects_extra_fields_and_missing_action(self) -> None:
        error = host_reset.auth.PasswordRecordError("corrupt")
        with (
            mock.patch.object(state, "authentication_state", side_effect=error),
            self.assertRaises(HTTPException) as extra,
        ):
            asyncio.run(
                host_reset.reset(
                    _request({"capability": CAPABILITY, "extra": True}),
                    setup_lock=asyncio.Lock(),
                    read_json=_read_json,
                    verify_password=mock.AsyncMock(),
                    bootstrap_reset=mock.Mock(),
                    established_reset=mock.Mock(),
                )
            )
        self.assertEqual(extra.exception.status_code, 400)

        with (
            mock.patch.object(state, "authentication_state", side_effect=error),
            mock.patch.object(host_reset, "_recovery_reset_action", return_value=(None, "")),
            self.assertRaises(RuntimeError),
        ):
            asyncio.run(
                host_reset.reset(
                    _request({"capability": CAPABILITY}),
                    setup_lock=asyncio.Lock(),
                    read_json=_read_json,
                    verify_password=mock.AsyncMock(),
                    bootstrap_reset=mock.Mock(),
                    established_reset=mock.Mock(),
                )
            )

    def test_reset_logs_and_propagates_team_failure(self) -> None:
        failure = RuntimeError("team reset failed")
        with (
            self.assertLogs("shimpz-admin", level="ERROR") as captured,
            self.assertRaisesRegex(RuntimeError, "team reset failed"),
        ):
            asyncio.run(
                host_reset.reset(
                    _request({"capability": CAPABILITY}),
                    setup_lock=asyncio.Lock(),
                    read_json=_read_json,
                    verify_password=mock.AsyncMock(),
                    bootstrap_reset=mock.Mock(side_effect=failure),
                    established_reset=mock.Mock(),
                )
            )
        self.assertIn("host reset failed after host-capability authorization", "\n".join(captured.output))

    def test_reset_audit_names_only_the_authority_class_and_outcome(self) -> None:
        with self.assertLogs("shimpz-admin", level="INFO") as captured:
            asyncio.run(
                host_reset.reset(
                    _request({"capability": CAPABILITY}),
                    setup_lock=asyncio.Lock(),
                    read_json=_read_json,
                    verify_password=mock.AsyncMock(),
                    bootstrap_reset=mock.Mock(return_value=JSONResponse({"reset": True})),
                    established_reset=mock.Mock(),
                )
            )

        log_output = "\n".join(captured.output)
        self.assertIn("completed with host-capability authorization", log_output)
        self.assertNotIn(CAPABILITY, log_output)
        self.assertNotIn(hashlib.sha256(bytes.fromhex(CAPABILITY)).hexdigest(), log_output)


if __name__ == "__main__":
    unittest.main()
