"""Closed edge contracts for small Admin-owned helpers."""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import hmac
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import auth
import models
import state
from team import assets, bridge, transport

from chat import payloads
from chat import progress as chat_progress


class AuthenticationEdgeTests(unittest.TestCase):
    def test_malformed_and_non_numeric_signed_sessions_fail_closed(self) -> None:
        secret = auth.new_secret()
        self.assertFalse(auth.verify_session(secret, "v2:1:nonce:signature"))
        body = "v1:not-a-time:nonce"
        signature = hmac.new(bytes.fromhex(secret), body.encode(), hashlib.sha256).hexdigest()
        self.assertFalse(auth.verify_session(secret, f"{body}:{signature}"))


class ModelEdgeTests(unittest.TestCase):
    def test_unknown_and_invalid_stored_credentials_fail_closed(self) -> None:
        with (
            mock.patch.object(state, "model_credentials", return_value={"unknown": {}}),
            self.assertRaisesRegex(RuntimeError, "unsupported model credentials"),
        ):
            models.status()
        self.assertIsNone(models._verified_secret({"verified_at": 1, "api_key": "short"}))

    def test_connection_construction_failure_is_unavailable(self) -> None:
        with (
            mock.patch.object(models.http.client, "HTTPSConnection", side_effect=OSError("offline")),
            self.assertRaises(models.ModelProviderUnavailableError),
        ):
            models._validate_api_key("openai", "sk-openai-0123456789")


class StateEdgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.previous_path = state.STORE_PATH
        state.STORE_PATH = Path(self.temporary.name) / "admin.json"
        self.addCleanup(setattr, state, "STORE_PATH", self.previous_path)
        with state._STORE_LOCK:
            state._store_cache = None

    def test_corrupt_changed_and_non_object_stores_fail_loud(self) -> None:
        state.STORE_PATH.write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "is corrupt"):
            state.get()

        state.STORE_PATH.write_text("[]", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "is not a JSON object"):
            state.get()

        state.STORE_PATH.write_text("{}", encoding="utf-8")
        real_identity = state._store_identity(state.STORE_PATH)
        with (
            mock.patch.object(state, "_store_identity", side_effect=[real_identity, None]),
            self.assertRaisesRegex(RuntimeError, "changed while reading"),
        ):
            state.get()

    def test_invalid_write_origin_and_credential_shapes_fail_closed(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "is not a JSON object"):
            state._write([])
        with self.assertRaises(ValueError):
            state.set_password("password", "http://example.test")

        state._write({"browser_origin": 7})
        with self.assertRaisesRegex(RuntimeError, "invalid browser origin"):
            state.browser_origin()

        state._write({"model_credentials": []})
        with self.assertRaisesRegex(RuntimeError, "invalid model credentials"):
            state.model_credentials()
        with self.assertRaisesRegex(RuntimeError, "invalid model credentials"):
            state.set_model_api_key("openai", "sk-openai-0123456789")
        with self.assertRaisesRegex(RuntimeError, "invalid model credentials"):
            state.delete_model_api_key("openai")

    def test_deleting_absent_key_does_not_rewrite_store(self) -> None:
        state._write({"model_credentials": {}})
        with mock.patch.object(state, "_write", wraps=state._write) as write:
            self.assertFalse(state.delete_model_api_key("openai"))
        write.assert_not_called()

    def test_password_initialization_preserves_existing_session_secret(self) -> None:
        state._write({"session_secret": "existing-session-secret"})
        state.set_password("password")
        self.assertEqual(state.get()["session_secret"], "existing-session-secret")


class AssetProjectionEdgeTests(unittest.TestCase):
    def test_asset_errors_json_and_binary_results_are_projected(self) -> None:
        with self.assertRaisesRegex(assets.HTTPException, "invalid") as caught:
            assets._response(lambda: (_ for _ in ()).throw(bridge.TeamRequestError("invalid")))
        self.assertEqual(caught.exception.status_code, 400)

        error = assets._response(lambda: transport.TeamAssetResponse(404, None, {"code": "not-found"}))
        self.assertEqual(error.status_code, 404)
        self.assertEqual(error.body, b'{"code":"not-found"}')

        with mock.patch.object(
            bridge,
            "assistant_icon",
            return_value=transport.TeamAssetResponse(200, b"png", {}),
        ) as assistant_icon:
            response = assets.assistant_icon("team_1", "assistant")
        assistant_icon.assert_called_once_with("team_1", "assistant")
        self.assertEqual(response.body, b"png")
        self.assertEqual(response.headers["cache-control"], "no-store")


class PayloadEdgeTests(unittest.TestCase):
    def test_chat_payload_limits_and_duplicates_fail_closed(self) -> None:
        invalid = (
            {"message": " ", "files": [], "assistant_ids": []},
            {"message": "x" * (payloads.MAX_CHAT_MESSAGE_CHARS + 1), "files": [], "assistant_ids": []},
            {"message": "ok", "files": "bad", "assistant_ids": []},
            {"message": "ok", "files": ["a" * 32, "a" * 32], "assistant_ids": []},
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(transport.TeamRequestError):
                payloads.canonical_chat_payload(value)

    def test_human_payload_shapes_fail_closed(self) -> None:
        invalid = (
            None,
            {"decision": "later", "challenge_id": "a" * 32},
            {"decision": "deny", "challenge_id": "a" * 32, "value": True},
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(transport.TeamRequestError):
                payloads.canonical_human_resume(value)
        with self.assertRaises(transport.TeamRequestError):
            payloads.canonical_human_assurance(None)


class ProgressEdgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_enqueue_drops_invalid_and_excess_events(self) -> None:
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue(maxsize=1)
        chat_progress._enqueue(queue, {"invalid": True})
        self.assertTrue(queue.empty())
        event = {"origin": "admin", "phase": "admin-preparation", "state": "started"}
        chat_progress._enqueue(queue, event)
        chat_progress._enqueue(queue, event)
        self.assertEqual(queue.qsize(), 1)

    async def test_inactive_completed_result_and_drain_stop_without_delivery(self) -> None:
        completed: concurrent.futures.Future[str] = concurrent.futures.Future()
        completed.set_result("done")
        result = await chat_progress.await_result(
            completed,
            asyncio.Queue(),
            lambda: True,
            mock.AsyncMock(return_value=True),
            mock.Mock(),
        )
        self.assertIsNone(result)

        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        queue.put_nowait({"origin": "admin", "phase": "admin-preparation", "state": "started"})
        result = await chat_progress.await_result(
            completed,
            queue,
            mock.Mock(side_effect=[False, True]),
            mock.AsyncMock(return_value=True),
            mock.Mock(),
        )
        self.assertIsNone(result)

    async def test_failed_final_drain_returns_completed_result(self) -> None:
        completed: concurrent.futures.Future[str] = concurrent.futures.Future()
        completed.set_result("done")
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        queue.put_nowait({"origin": "admin", "phase": "admin-preparation", "state": "started"})
        mark_closed = mock.Mock()
        result = await chat_progress.await_result(
            completed,
            queue,
            lambda: False,
            mock.AsyncMock(return_value=False),
            mark_closed,
        )
        self.assertEqual(result, "done")
        mark_closed.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
