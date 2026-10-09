"""The Admin gate refuses a state change that another origin's page sends with the Supervisor's cookie (CSRF)."""

import asyncio
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from test_team_bridge_assistants import (
    _asgi_request,
    _LiveTeamCase,
    _multipart_file_body,
    _probe_session,
    _TeamHandler,
)

ADMIN = "http://127.0.0.1:7777"
BOUNDARY = "shimpz-admin-upload-boundary"
MULTIPART = f"multipart/form-data; boundary={BOUNDARY}"
INSTALL = json.dumps({"assistant_id": "hello-pulse", "source_digest": "sha256:" + "a" * 64}).encode()
REFUSED = {"status": 403, "body": {"detail": "browser origin is not admitted"}}

# What a browser sends for each initiating page; SameSite treats the first two as the Admin's own site.
PAGES = {
    "other_loopback_port": {"sec-fetch-site": "same-site", "origin": "http://127.0.0.1:5173"},
    "sibling_host": {"sec-fetch-site": "same-site", "origin": "https://store.shimpz.com"},
    "cross_site": {"sec-fetch-site": "cross-site", "origin": "https://attacker.example"},
    "admitted_origin_from_another_site": {"sec-fetch-site": "same-site", "origin": ADMIN},
    "foreign_origin_marked_same_origin": {"sec-fetch-site": "same-origin", "origin": "https://attacker.example"},
    "non_canonical_origin": {"sec-fetch-site": "same-origin", "origin": "HTTP://127.0.0.1:7777"},
    "no_browser_headers": {"sec-fetch-site": None},
}
ADMIN_PAGE = {"sec-fetch-site": "same-origin", "origin": ADMIN}


class CrossOriginGateTests(_LiveTeamCase):
    def test_only_the_admin_page_may_upload_a_file_or_post_json(self) -> None:
        _TeamHandler.responder = staticmethod(lambda _method, _path, _body: (409, b'{"detail":"held"}'))
        document = self._run_asgi_probe("cross-origin", Path(__file__).resolve())

        for page in PAGES:
            with self.subTest(page=page):
                self.assertEqual(document[f"upload:{page}"], REFUSED)
                self.assertEqual(document[f"install:{page}"], REFUSED)
        # Team's own answer reaching the browser proves the gate let the request through: a safe read never changes
        # state, so the session alone admits it, and the Admin page's own upload and install pass.
        for passed in ("read:cross_site", "upload:admin_page", "install:admin_page"):
            self.assertEqual(document[passed]["status"], 409, passed)
        self.assertEqual(
            [(request["method"], request["path"]) for request in _TeamHandler.requests],
            [
                ("GET", "/v1/teams/team_1/files"),
                ("POST", "/v1/teams/team_1/files"),
                ("POST", "/v1/teams/team_1/assistants"),
            ],
        )


def _run_asgi_probe() -> None:
    admin_app, token = _probe_session()
    upload = _multipart_file_body(BOUNDARY, b"Team private data")

    async def send(method: str, path: str, body: bytes, headers: dict[str, str | None]) -> dict[str, object]:
        status, payload = await _asgi_request(admin_app, method, path, body, token=token, headers=headers)
        return {"status": status, "body": payload}

    async def scenario() -> dict[str, object]:
        results: dict[str, object] = {}
        results["read:cross_site"] = await send("GET", "/api/teams/team_1/files", b"", PAGES["cross_site"])
        for page, headers in {**PAGES, "admin_page": ADMIN_PAGE}.items():
            upload_headers = {**headers, "content-type": MULTIPART}
            results[f"upload:{page}"] = await send("POST", "/api/teams/team_1/files", upload, upload_headers)
            results[f"install:{page}"] = await send("POST", "/api/teams/team_1/assistants", INSTALL, headers)
        return results

    print(json.dumps(asyncio.run(scenario())))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--asgi-probe":
        _run_asgi_probe()
    else:
        unittest.main()
