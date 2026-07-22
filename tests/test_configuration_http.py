"""HTTP journey for Admin configuration and integration state."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from admin_http import AdminHTTPServer, request, session_cookie

PASSWORD = " ".join(("correct", "horse", "battery", "staple"))


class ConfigurationHTTPTests(unittest.TestCase):
    def test_configuration_and_integration_changes_cross_the_real_http_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            integration_store = root / "integrations.json"
            with AdminHTTPServer(root, SHIMPZ_INTEGRATIONS_STORE=str(integration_store)) as server:
                session = self._bootstrap(server.port)
                self._exercise_configuration(server.port, root, session)
                self._exercise_integrations(server.port, root, integration_store, session)

    def _bootstrap(self, port: int) -> str:
        self.assertEqual(request(port, "GET", "/api/state")[0], 401)
        status, payload, set_cookie = request(
            port,
            "POST",
            "/api/admin/setup",
            {"password": PASSWORD},
        )
        session = session_cookie(set_cookie)
        self.assertEqual((status, payload), (200, {"ok": True}))
        self.assertIsNotNone(session)
        return str(session)

    def _exercise_configuration(self, port: int, root: Path, session: str) -> None:
        status, payload, _ = request(port, "GET", "/api/state", session=session)
        self.assertEqual(status, 200)
        self.assertTrue(payload["fields"])
        self.assertTrue(all(field["masked"] == "" for field in payload["fields"] if field["secret"]))

        valid = request(
            port,
            "POST",
            "/api/validate",
            {"key": "SHIMPZ_SIGNUP_ENABLED", "value": "1"},
            session=session,
        )
        invalid = request(
            port,
            "POST",
            "/api/validate",
            {"key": "SHIMPZ_SIGNUP_ENABLED", "value": "2"},
            session=session,
        )
        unknown = request(
            port,
            "POST",
            "/api/validate",
            {"key": "EVIL", "value": "x"},
            session=session,
        )
        self.assertEqual((valid[0], valid[1]["ok"]), (200, True))
        self.assertEqual((invalid[0], invalid[1]["ok"]), (200, False))
        self.assertEqual(unknown[0], 400)

        rejected = request(
            port,
            "POST",
            "/api/apply",
            {"values": {"SHIMPZ_SIGNUP_ENABLED": "2"}},
            session=session,
        )
        self.assertEqual((rejected[0], rejected[1]["applied"]), (400, False))
        self.assertFalse((root / ".env").exists())

        applied = request(
            port,
            "POST",
            "/api/apply",
            {"values": {"SHIMPZ_SIGNUP_ENABLED": "1"}},
            session=session,
        )
        self.assertEqual((applied[0], applied[1]["applied"]), (200, True))
        self.assertEqual(applied[1]["generated"], ["POSTGRES_PASSWORD"])
        env_path = root / ".env"
        self.assertEqual(env_path.stat().st_mode & 0o777, 0o600)
        self.assertIn("SHIMPZ_SIGNUP_ENABLED=1", env_path.read_text(encoding="utf-8"))

        state = request(port, "GET", "/api/state", session=session)[1]
        postgres = next(field for field in state["fields"] if field["key"] == "POSTGRES_PASSWORD")
        self.assertTrue(postgres["set"])
        self.assertRegex(postgres["masked"], r"^••••.{4}$")

    def _exercise_integrations(self, port: int, root: Path, store: Path, session: str) -> None:
        status, payload, _ = request(port, "GET", "/api/integrations", session=session)
        self.assertEqual(status, 200)
        integrations = {item["group"]: item for item in payload["integrations"]}
        self.assertEqual(set(integrations), {"internal", "advanced"})
        self.assertEqual(payload["categories"], ["INFRA"])
        self.assertFalse(integrations["internal"]["reconfigurable"])
        self.assertTrue(integrations["advanced"]["reconfigurable"])
        self.assertEqual(request(port, "GET", "/api/integrations")[0], 401)

        saved = request(
            port,
            "POST",
            "/api/integrations/advanced",
            {"values": {"KASM_USER": "operator"}},
            session=session,
        )
        self.assertEqual((saved[0], saved[1]["applied"]), (200, True))
        self.assertEqual(
            saved[1]["recreate"],
            {"target": None, "note": "saved; applies on the next restart of the affected service"},
        )
        self.assertIn("KASM_USER=operator", (root / ".env").read_text(encoding="utf-8"))
        self.assertTrue(json.loads(store.read_text(encoding="utf-8"))["advanced"]["enabled"])

        refreshed = request(port, "GET", "/api/integrations", session=session)[1]
        advanced = next(item for item in refreshed["integrations"] if item["group"] == "advanced")
        self.assertTrue(advanced["configured"])
        self.assertEqual(
            request(
                port,
                "POST",
                "/api/integrations/advanced",
                {"values": {"POSTGRES_PASSWORD": "not-advanced"}},
                session=session,
            )[0],
            400,
        )
        self.assertEqual(
            request(port, "POST", "/api/integrations/not-a-group", {"values": {}}, session=session)[0],
            400,
        )

        toggled = request(
            port,
            "POST",
            "/api/integrations/advanced/toggle",
            {"enabled": False},
            session=session,
        )
        self.assertEqual((toggled[0], toggled[1]["enabled"]), (200, False))
        self.assertFalse(json.loads(store.read_text(encoding="utf-8"))["advanced"]["enabled"])


if __name__ == "__main__":
    unittest.main()
