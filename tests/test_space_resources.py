"""The Space's read-only resource signal Admin projects from Team for the Supervisor's console."""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import app_import
from http_request import LOOPBACK, http_request, through_gate

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge, transport

GIB = 2**30
SIGNAL = {
    "services_running": 6,
    "services_total": 7,
    "memory_used_bytes": 429_496_730,
    "memory_total_bytes": 4 * GIB,
    "storage_used_bytes": None,
    "storage_total_bytes": None,
}


class SpaceResourceBridgeTests(unittest.TestCase):
    def project(self, team_response: transport.TeamResponse) -> transport.TeamResponse:
        with mock.patch.object(bridge, "_call", return_value=team_response) as call:
            response = bridge.space_resources()
        call.assert_called_once_with("GET", "/v1/space/resources")
        return response

    def test_projects_exactly_the_closed_signal_without_team_trace(self) -> None:
        for body in (SIGNAL, {**SIGNAL, "trace_id": "a" * 32}):
            with self.subTest(traced="trace_id" in body):
                response = self.project(transport.TeamResponse(200, body))
                self.assertEqual((response.status, response.body), (200, SIGNAL))

    def test_refuses_a_signal_outside_its_closed_shape(self) -> None:
        for body in (
            {},
            {**SIGNAL, "trace_id": "not a trace"},
            {**SIGNAL, "healthy": True},
            {key: value for key, value in SIGNAL.items() if key != "services_total"},
            {**SIGNAL, "services_running": 8},
            {**SIGNAL, "memory_used_bytes": None},
        ):
            with self.subTest(body=body), self.assertLogs("shimpz-admin", "WARNING"):
                response = self.project(transport.TeamResponse(200, body))
            self.assertEqual(response.status, 502)
            self.assertEqual(response.body, {"detail": "Team Space resources response is invalid."})

    def test_passes_a_team_failure_through(self) -> None:
        failure = transport.TeamResponse(503, {"error": "Docker is unavailable", "code": "docker-unavailable"})
        self.assertIs(self.project(failure), failure)


class SpaceResourceRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.admin_app = app_import.load_app(app_import.temporary_root(cls))

    def test_the_route_answers_the_projection(self) -> None:
        self.assertIn(("/api/space/resources", "GET"), app_import.route_methods(self.admin_app))
        routes = self.admin_app.app.routes
        route = next(route for route in routes if getattr(route, "path", "") == "/api/space/resources")
        with mock.patch.object(bridge, "space_resources", return_value=transport.TeamResponse(200, SIGNAL)):
            response = route.endpoint()
        self.assertEqual((response.status_code, json.loads(response.body)), (200, SIGNAL))

    def test_the_route_requires_the_local_admin_session(self) -> None:
        self.assertNotIn("/api/space/resources", self.admin_app.OPEN_API)

        async def should_not_run(_request):
            self.fail("an unauthenticated request reached the Space resources route")

        response = asyncio.run(
            through_gate(self.admin_app, http_request("/api/space/resources", LOOPBACK, method="GET"), should_not_run)
        )
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
