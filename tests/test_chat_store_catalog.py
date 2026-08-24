"""Strict public Store catalog discovery contracts for Local chat."""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import store_catalog

DIGEST = "sha256:" + ("a" * 64)
ICON_DIGEST = "sha256:" + ("b" * 64)


def _assistant(**changes) -> dict[str, object]:
    value = {
        "assistant_id": "shimpz-cloudflare",
        "name": "Shimpz Cloudflare",
        "summary": "Manages reviewed Cloudflare zones and DNS records.",
        "assistant_version": "1.2.3",
        "creators": ["@shimpz"],
        "github": "https://github.com/TheShimpz/shimpz-cloudflare",
        "icon_digest": ICON_DIGEST,
        "source_digest": DIGEST,
        "platforms": ["linux/amd64", "linux/arm64"],
        "allowed_hosts": ["api.cloudflare.com"],
        "integrations": [{"id": "cloudflare", "provider": "cloudflare", "scopes": ["zone.read"]}],
        "actions": [{"id": "list-zones", "integrations": ["cloudflare"], "human_requests": []}],
    }
    value.update(changes)
    return value


class _Response:
    def __init__(self, body: bytes, *, status: int = 200, content_type: str = "application/json") -> None:
        self.status = status
        self._body = body
        self._headers = {"Content-Type": content_type, "Content-Length": str(len(body))}

    def getheader(self, name: str):
        return self._headers.get(name)

    def read(self, maximum: int) -> bytes:
        return self._body[:maximum]


class _Connection:
    def __init__(self, response: _Response) -> None:
        self.response = response
        self.request_value = None
        self.closed = False

    def request(self, method: str, path: str, *, headers: dict[str, str]) -> None:
        self.request_value = (method, path, headers)

    def getresponse(self) -> _Response:
        return self.response

    def close(self) -> None:
        self.closed = True


class StoreCatalogTests(unittest.TestCase):
    def test_projects_only_bounded_discovery_metadata(self) -> None:
        result = store_catalog.validate_catalog({"version": 1, "assistants": [_assistant()]})

        self.assertEqual(
            result,
            (
                store_catalog.CatalogAssistant(
                    assistant_id="shimpz-cloudflare",
                    name="Shimpz Cloudflare",
                    summary="Manages reviewed Cloudflare zones and DNS records.",
                    source_digest=DIGEST,
                    integrations=(store_catalog.CatalogIntegration("cloudflare", ("zone.read",)),),
                    actions=("list-zones",),
                ),
            ),
        )
        self.assertNotIn("github", repr(result))
        self.assertNotIn("allowed_hosts", repr(result))

    def test_rejects_malformed_or_ambiguous_catalogs(self) -> None:
        mutations = (
            lambda value: value.update(extra=True),
            lambda value: value["assistants"][0].update(name=" bad"),
            lambda value: value["assistants"][0].update(source_digest="sha256:bad"),
            lambda value: value["assistants"][0].update(platforms=["linux/amd64"]),
            lambda value: value["assistants"][0].update(github="https://example.com/repo"),
            lambda value: value["assistants"][0].update(creators=[]),
            lambda value: value["assistants"][0].update(allowed_hosts=["API.cloudflare.com"]),
            lambda value: value["assistants"][0].update(integrations=[{"id": "cloudflare"}]),
            lambda value: value["assistants"][0].update(actions=[]),
            lambda value: value["assistants"].append(copy.deepcopy(value["assistants"][0])),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = {"version": 1, "assistants": [_assistant()]}
                mutate(value)
                with self.assertRaises(ValueError):
                    store_catalog.validate_catalog(value)

    def test_fetch_is_fixed_bounded_and_closes_the_connection(self) -> None:
        body = json.dumps({"version": 1, "assistants": [_assistant()]}).encode()
        connection = _Connection(_Response(body))
        called = None

        def factory(host: str, port: int, *, timeout: int):
            nonlocal called
            called = (host, port, timeout)
            return connection

        result = store_catalog.fetch_catalog(factory)

        self.assertEqual(
            called,
            (store_catalog.CATALOG_HOST, 443, store_catalog.CATALOG_TIMEOUT_SECONDS),
        )
        self.assertEqual(
            connection.request_value,
            ("GET", store_catalog.CATALOG_PATH, {"Accept": "application/json"}),
        )
        self.assertEqual(result[0].assistant_id, "shimpz-cloudflare")
        self.assertTrue(connection.closed)

    def test_fetch_rejects_status_type_length_and_malformed_json(self) -> None:
        cases = (
            _Response(b"{}", status=302),
            _Response(b"{}", content_type="text/html"),
            _Response(b"{"),
            _Response(b"x" * (store_catalog.MAX_CATALOG_BYTES + 1)),
        )
        for response in cases:
            with self.subTest(response=response):
                connection = _Connection(response)

                def factory(*_args, selected=connection, **_kwargs):
                    return selected

                with self.assertRaises(store_catalog.CatalogUnavailableError):
                    store_catalog.fetch_catalog(factory)
                self.assertTrue(connection.closed)

    def test_cache_expires_without_stale_fallback(self) -> None:
        now = [10.0]
        calls = 0
        assistant = store_catalog.validate_catalog({"version": 1, "assistants": [_assistant()]})

        def loader():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise store_catalog.CatalogUnavailableError("unavailable")
            return assistant

        catalog = store_catalog.StoreCatalog(loader=loader, clock=lambda: now[0])
        self.assertIs(catalog.get(), assistant)
        self.assertIs(catalog.get(), assistant)
        self.assertEqual(calls, 1)
        now[0] += store_catalog.CATALOG_TTL_SECONDS
        with self.assertRaises(store_catalog.CatalogUnavailableError):
            catalog.get()
        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
