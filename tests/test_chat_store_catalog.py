"""Strict public Store catalog discovery contracts for Local chat."""

import concurrent.futures
import copy
import hashlib
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import store_catalog

DIGEST = "sha256:" + ("a" * 64)
ICON_DIGEST = "sha256:" + ("b" * 64)
ICON_BYTES = b"\x89PNG\r\n\x1a\nverified-icon"
VERIFIED_ICON_DIGEST = "sha256:" + hashlib.sha256(ICON_BYTES).hexdigest()


def _assistant(**changes) -> dict[str, object]:
    value = {
        "assistant_id": "shimpz-cloudflare",
        "name": "Shimpz Cloudflare",
        "summary": "Manages reviewed Cloudflare zones and DNS records.",
        "description": "Reads your zones and records and changes one only after your approval.",
        "links": {"github": "https://github.com/shimpz", "site": "https://shimpz.com/"},
        "assistant_version": "1.2.3",
        "creators": ["@shimpz"],
        "github": "https://github.com/TheShimpz/shimpz-cloudflare",
        "icon_digest": ICON_DIGEST,
        "source_digest": DIGEST,
        "platforms": ["linux/amd64", "linux/arm64"],
        "allowed_hosts": ["api.cloudflare.com"],
        "integrations": [{"id": "cloudflare", "provider": "cloudflare", "scopes": ["zone.read"]}],
        "stored_inputs": [{"id": "cloudflare-token", "label": "Cloudflare token"}],
        "actions": [
            {
                "id": "list-zones",
                "integrations": ["cloudflare"],
                "human_requests": [],
                "effect": "read_only",
                "description": "List your zones.",
            }
        ],
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


def _validate(value: object) -> tuple[store_catalog.CatalogAssistant, ...]:
    return store_catalog.validate_catalog(value, "en")


class StoreCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.icon_cache = store_catalog.StoreIconCache()

    def test_projects_only_bounded_discovery_metadata(self) -> None:
        result = _validate({"version": 1, "locale": "en", "assistants": [_assistant()]})

        self.assertEqual(
            result,
            (
                store_catalog.CatalogAssistant(
                    assistant_id="shimpz-cloudflare",
                    name="Shimpz Cloudflare",
                    summary="Manages reviewed Cloudflare zones and DNS records.",
                    source_digest=DIGEST,
                    icon_digest=ICON_DIGEST,
                    integrations=(store_catalog.CatalogIntegration("cloudflare", ("zone.read",)),),
                    actions=("list-zones",),
                    assistant_version="1.2.3",
                    creators=("@shimpz",),
                    page=store_catalog.CatalogPage(
                        description="Reads your zones and records and changes one only after your approval.",
                        links=(("site", "https://shimpz.com/"), ("github", "https://github.com/shimpz")),
                        actions=(store_catalog.CatalogAction("list-zones", "read_only", "List your zones."),),
                        stored_inputs=(("cloudflare-token", "Cloudflare token"),),
                    ),
                ),
            ),
        )
        # The repository and egress hosts are checked but never projected; the GitHub link is the Creator's own.
        self.assertNotIn("TheShimpz/shimpz-cloudflare", repr(result))
        self.assertNotIn("api.cloudflare.com", repr(result))

    def test_admits_the_producer_catalog_size_and_no_more(self) -> None:
        # Store and Developers admit up to 1,000 Assistants; Admin must consume every valid producer catalog.
        def catalog(count: int) -> dict[str, object]:
            assistants = [_assistant(assistant_id=f"assistant-{index:04d}") for index in range(count)]
            return {"version": 1, "locale": "en", "assistants": assistants}

        self.assertEqual(len(_validate(catalog(1000))), 1000)
        with self.assertRaisesRegex(ValueError, "catalog size is invalid"):
            _validate(catalog(1001))

    def test_the_summary_is_a_short_description_of_at_most_eighty_code_points(self) -> None:
        for summary in ("s" * 80, "s" * 79 + "\U0001f44b"):
            with self.subTest(summary=summary):
                catalog = {"version": 1, "locale": "en", "assistants": [_assistant(summary=summary)]}
                self.assertEqual(_validate(catalog)[0].summary, summary)
        with self.assertRaises(ValueError):
            _validate({"version": 1, "locale": "en", "assistants": [_assistant(summary="s" * 81)]})

    def test_admits_the_producer_action_count_and_no_more(self) -> None:
        # Developers' install protocol admits up to 128 Actions per Assistant.
        def catalog(count: int) -> dict[str, object]:
            actions = [
                {
                    "id": f"action-{index:03d}",
                    "integrations": [],
                    "human_requests": [],
                    "effect": "read_only",
                    "description": "List your zones.",
                }
                for index in range(count)
            ]
            return {"version": 1, "locale": "en", "assistants": [_assistant(actions=actions)]}

        (assistant,) = _validate(catalog(128))
        self.assertEqual(len(assistant.actions), 128)
        with self.assertRaisesRegex(ValueError, "catalog Actions are invalid"):
            _validate(catalog(129))

    def test_admits_the_page_copy_at_its_bounds_and_every_link_kind(self) -> None:
        links = {
            "site": "https://example.org/" + "a" * 236,
            "github": "https://github.com/shimpz",
            "x": "https://x.com/shimpz",
            "youtube": "https://www.youtube.com/@shimpz",
            "linkedin": "https://linkedin.com/company/shimpz",
            "instagram": "https://instagram.com/shimpz",
        }
        actions = [
            {
                "id": "list-zones",
                "integrations": [],
                "human_requests": [],
                "effect": "mutating",
                "description": "x" * 120,
            }
        ]
        value = _assistant(
            description="d" * 499 + "\U0001f44b",
            links=links,
            actions=actions,
            stored_inputs=[{"id": "token", "label": "l" * 120}],
        )
        (assistant,) = _validate({"version": 1, "locale": "en", "assistants": [value]})
        self.assertEqual(len(assistant.page.description), 500)
        self.assertEqual([kind for kind, _ in assistant.page.links], list(store_catalog.LINK_PREFIXES))
        self.assertEqual(assistant.page.actions[0].effect, "mutating")
        self.assertEqual(assistant.actions, ("list-zones",))

    def test_refuses_page_copy_outside_its_contract(self) -> None:
        refused = (
            {"description": "d" * 501},
            {"description": " untrimmed"},
            {"description": "control\x85character"},
            {"links": {"facebook": "https://facebook.com/shimpz"}},
            {"links": {"github": "https://gitlab.com/shimpz"}},
            {"links": {"x": "https://twitter.com/shimpz"}},
            {"links": {"youtube": "https://youtube.com.example.org/watch"}},
            {"links": {"site": "http://example.org/"}},
            {"links": {"site": "https://example.org/" + "a" * 237}},
            {"links": {"site": "https://user@example.org/"}},
            {"links": []},
            {"stored_inputs": [{"id": "token", "label": "l" * 121}]},
            {"stored_inputs": [{"id": "token", "label": "Token", "description": "English."}]},
            {"stored_inputs": [{"id": "token", "label": "Token"}, {"id": "token", "label": "Token"}]},
            {
                "actions": [
                    {
                        "id": "list-zones",
                        "integrations": [],
                        "human_requests": [],
                        "effect": "deleting",
                        "description": "List your zones.",
                    }
                ]
            },
            {
                "actions": [
                    {
                        "id": "list-zones",
                        "integrations": [],
                        "human_requests": [],
                        "effect": "read_only",
                        "description": "x" * 121,
                    }
                ]
            },
            {"actions": [{"id": "list-zones", "integrations": [], "human_requests": [], "effect": "read_only"}]},
        )
        for changes in refused:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                _validate({"version": 1, "locale": "en", "assistants": [_assistant(**changes)]})

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
                value = {"version": 1, "locale": "en", "assistants": [_assistant()]}
                mutate(value)
                with self.assertRaises(ValueError):
                    _validate(value)

    def test_rejects_every_nested_catalog_authority_violation(self) -> None:
        mutations = (
            lambda value: value.update(assistants={}),
            lambda value: value["assistants"][0].update(extra=True),
            lambda value: value["assistants"][0].update(assistant_id="Bad"),
            lambda value: value["assistants"][0].update(assistant_version="01.0.0"),
            lambda value: value["assistants"][0].update(icon_digest="sha256:bad"),
            lambda value: value["assistants"][0].update(creators=["@shimpz", "@shimpz"]),
            lambda value: value["assistants"][0].update(integrations={}),
            lambda value: value["assistants"][0].update(
                integrations=[{"id": "other", "provider": "cloudflare", "scopes": []}]
            ),
            lambda value: value["assistants"][0].update(
                integrations=[
                    {"id": "cloudflare", "provider": "cloudflare", "scopes": []},
                    {"id": "cloudflare", "provider": "cloudflare", "scopes": []},
                ]
            ),
            lambda value: value["assistants"][0].update(actions=[{}]),
            lambda value: value["assistants"][0].update(
                actions=[
                    {
                        "id": "Bad",
                        "integrations": [],
                        "human_requests": [],
                        "effect": "read_only",
                        "description": "List your zones.",
                    }
                ]
            ),
            lambda value: value["assistants"][0].update(
                actions=[
                    {
                        "id": "list-zones",
                        "integrations": [],
                        "human_requests": [],
                        "effect": "read_only",
                        "description": "List your zones.",
                    },
                    {
                        "id": "list-zones",
                        "integrations": [],
                        "human_requests": [],
                        "effect": "read_only",
                        "description": "List your zones.",
                    },
                ]
            ),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = {"version": 1, "locale": "en", "assistants": [_assistant()]}
                mutate(value)
                with self.assertRaises(ValueError):
                    _validate(value)

    def test_string_collection_bounds_are_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            store_catalog._strings({}, 1, 1)
        with self.assertRaises(ValueError):
            store_catalog._strings(["same", "same"], 2, 8)

    def test_fetch_is_fixed_bounded_and_closes_the_connection(self) -> None:
        body = json.dumps({"version": 1, "locale": "en", "assistants": [_assistant()]}).encode()
        connection = _Connection(_Response(body))
        called = None

        def factory(host: str, port: int, *, timeout: int):
            nonlocal called
            called = (host, port, timeout)
            return connection

        result = store_catalog.fetch_catalog("en", factory)

        self.assertEqual(
            called,
            (store_catalog.CATALOG_HOST, 443, store_catalog.CATALOG_TIMEOUT_SECONDS),
        )
        self.assertEqual(
            connection.request_value,
            ("GET", f"{store_catalog.CATALOG_PATH}?locale=en", {"Accept": "application/json"}),
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
                    store_catalog.fetch_catalog("en", factory)
                self.assertTrue(connection.closed)

    def test_fetches_only_the_catalog_resolved_immutable_icon(self) -> None:
        assistants = _validate(
            {"version": 1, "locale": "en", "assistants": [_assistant(icon_digest=VERIFIED_ICON_DIGEST)]}
        )
        catalog = store_catalog.StoreCatalog(loader=lambda _locale: assistants)
        connection = _Connection(_Response(ICON_BYTES, content_type="image/png"))
        called = None

        def factory(host: str, port: int, *, timeout: int):
            nonlocal called
            called = (host, port, timeout)
            return connection

        result = store_catalog.fetch_assistant_icon(
            "shimpz-cloudflare",
            catalog=catalog,
            cache=self.icon_cache,
            connection_factory=factory,
        )

        self.assertEqual(result, ICON_BYTES)
        self.assertEqual(called, (store_catalog.CATALOG_HOST, 443, store_catalog.CATALOG_TIMEOUT_SECONDS))
        self.assertEqual(
            connection.request_value,
            (
                "GET",
                f"/api/assistant-icons/{'a' * 64}/{VERIFIED_ICON_DIGEST.removeprefix('sha256:')}.png",
                {"Accept": "image/png"},
            ),
        )
        self.assertTrue(connection.closed)

    def test_icon_lookup_rejects_invalid_and_absent_assistant_ids_before_egress(self) -> None:
        catalog = mock.Mock(spec=store_catalog.StoreCatalog)
        with self.assertRaises(store_catalog.CatalogAssistantNotFoundError):
            store_catalog.fetch_assistant_icon("Invalid", catalog=catalog, cache=self.icon_cache)
        catalog.get.assert_not_called()

        catalog.get.return_value = ()
        with self.assertRaises(store_catalog.CatalogAssistantNotFoundError):
            store_catalog.fetch_assistant_icon("missing", catalog=catalog, cache=self.icon_cache)
        catalog.get.assert_called_once_with("en")

    def test_icon_fetch_rejects_untrusted_status_type_length_and_contents(self) -> None:
        assistants = _validate(
            {"version": 1, "locale": "en", "assistants": [_assistant(icon_digest=VERIFIED_ICON_DIGEST)]}
        )
        catalog = store_catalog.StoreCatalog(loader=lambda _locale: assistants)
        cases = [
            _Response(ICON_BYTES, status=302, content_type="image/png"),
            _Response(ICON_BYTES, content_type="text/html"),
            _Response(b"wrong", content_type="image/png"),
        ]
        missing_length = _Response(ICON_BYTES, content_type="image/png")
        missing_length._headers.pop("Content-Length")
        cases.append(missing_length)
        invalid_length = _Response(ICON_BYTES, content_type="image/png")
        invalid_length._headers["Content-Length"] = "invalid"
        cases.append(invalid_length)
        oversized_length = _Response(ICON_BYTES, content_type="image/png")
        oversized_length._headers["Content-Length"] = str(store_catalog.MAX_ICON_BYTES + 1)
        cases.append(oversized_length)
        mismatched_length = _Response(ICON_BYTES, content_type="image/png")
        mismatched_length._headers["Content-Length"] = str(len(ICON_BYTES) - 1)
        cases.append(mismatched_length)

        for response in cases:
            with self.subTest(response=response):
                connection = _Connection(response)
                with self.assertRaises(store_catalog.CatalogUnavailableError):
                    store_catalog.fetch_assistant_icon(
                        "shimpz-cloudflare",
                        catalog=catalog,
                        cache=self.icon_cache,
                        connection_factory=lambda *_args, selected=connection, **_kwargs: selected,
                    )
                self.assertTrue(connection.closed)

    def test_icon_fetch_wraps_transport_failure_and_suppresses_close_failure(self) -> None:
        assistants = _validate(
            {"version": 1, "locale": "en", "assistants": [_assistant(icon_digest=VERIFIED_ICON_DIGEST)]}
        )
        with (
            mock.patch.object(store_catalog.CATALOG, "get", return_value=assistants),
            self.assertRaises(store_catalog.CatalogUnavailableError),
        ):
            store_catalog.fetch_assistant_icon(
                "shimpz-cloudflare",
                cache=self.icon_cache,
                connection_factory=mock.Mock(side_effect=OSError("offline")),
            )

        connection = _Connection(_Response(ICON_BYTES, content_type="image/png"))
        connection.close = mock.Mock(side_effect=OSError("close failed"))
        catalog = store_catalog.StoreCatalog(loader=lambda _locale: assistants)
        self.assertEqual(
            store_catalog.fetch_assistant_icon(
                "shimpz-cloudflare",
                catalog=catalog,
                cache=self.icon_cache,
                connection_factory=lambda *_args, **_kwargs: connection,
            ),
            ICON_BYTES,
        )

    def test_icon_cache_reuses_verified_bytes_after_current_catalog_resolution(self) -> None:
        assistants = _validate(
            {"version": 1, "locale": "en", "assistants": [_assistant(icon_digest=VERIFIED_ICON_DIGEST)]}
        )
        catalog = mock.Mock(spec=store_catalog.StoreCatalog)
        catalog.get.return_value = assistants
        factory = mock.Mock(return_value=_Connection(_Response(ICON_BYTES, content_type="image/png")))

        for _ in range(2):
            self.assertEqual(
                store_catalog.fetch_assistant_icon(
                    "shimpz-cloudflare",
                    catalog=catalog,
                    cache=self.icon_cache,
                    connection_factory=factory,
                ),
                ICON_BYTES,
            )

        self.assertEqual(catalog.get.call_count, 2)
        factory.assert_called_once_with(
            store_catalog.CATALOG_HOST,
            443,
            timeout=store_catalog.CATALOG_TIMEOUT_SECONDS,
        )

    def test_icon_fetch_uses_the_production_catalog_and_cache_singletons(self) -> None:
        assistants = _validate(
            {"version": 1, "locale": "en", "assistants": [_assistant(icon_digest=VERIFIED_ICON_DIGEST)]}
        )
        catalog = mock.Mock(spec=store_catalog.StoreCatalog)
        catalog.get.return_value = assistants
        cache = store_catalog.StoreIconCache()
        factory = mock.Mock(return_value=_Connection(_Response(ICON_BYTES, content_type="image/png")))
        with (
            mock.patch.object(store_catalog, "CATALOG", catalog),
            mock.patch.object(store_catalog, "ICON_CACHE", cache),
        ):
            for _ in range(2):
                self.assertEqual(
                    store_catalog.fetch_assistant_icon(
                        "shimpz-cloudflare",
                        connection_factory=factory,
                    ),
                    ICON_BYTES,
                )

        self.assertEqual(catalog.get.call_count, 2)
        self.assertEqual(factory.call_count, 1)

    def test_icon_cache_never_bypasses_current_catalog_absence_or_failure(self) -> None:
        assistants = _validate(
            {"version": 1, "locale": "en", "assistants": [_assistant(icon_digest=VERIFIED_ICON_DIGEST)]}
        )
        connection = _Connection(_Response(ICON_BYTES, content_type="image/png"))
        factory = mock.Mock(return_value=connection)
        for second, expected in (
            ((), store_catalog.CatalogAssistantNotFoundError),
            (store_catalog.CatalogUnavailableError("offline"), store_catalog.CatalogUnavailableError),
        ):
            with self.subTest(expected=expected.__name__):
                catalog = mock.Mock(spec=store_catalog.StoreCatalog)
                catalog.get.side_effect = (assistants, second)
                cache = store_catalog.StoreIconCache()
                self.assertEqual(
                    store_catalog.fetch_assistant_icon(
                        "shimpz-cloudflare",
                        catalog=catalog,
                        cache=cache,
                        connection_factory=factory,
                    ),
                    ICON_BYTES,
                )
                with self.assertRaises(expected):
                    store_catalog.fetch_assistant_icon(
                        "shimpz-cloudflare",
                        catalog=catalog,
                        cache=cache,
                        connection_factory=factory,
                    )

        self.assertEqual(factory.call_count, 2)

    def test_icon_cache_keys_the_exact_catalog_publication(self) -> None:
        first = _validate({"version": 1, "locale": "en", "assistants": [_assistant(icon_digest=VERIFIED_ICON_DIGEST)]})
        second = _validate(
            {
                "version": 1,
                "locale": "en",
                "assistants": [_assistant(source_digest="sha256:" + ("c" * 64), icon_digest=VERIFIED_ICON_DIGEST)],
            }
        )
        catalog = mock.Mock(spec=store_catalog.StoreCatalog)
        catalog.get.side_effect = (first, second)
        connections = [
            _Connection(_Response(ICON_BYTES, content_type="image/png")),
            _Connection(_Response(ICON_BYTES, content_type="image/png")),
        ]
        factory = mock.Mock(side_effect=connections)

        for _ in range(2):
            self.assertEqual(
                store_catalog.fetch_assistant_icon(
                    "shimpz-cloudflare",
                    catalog=catalog,
                    cache=self.icon_cache,
                    connection_factory=factory,
                ),
                ICON_BYTES,
            )

        self.assertEqual(factory.call_count, 2)
        self.assertIn("/" + ("a" * 64) + "/", connections[0].request_value[1])
        self.assertIn("/" + ("c" * 64) + "/", connections[1].request_value[1])

    def test_icon_cache_does_not_negative_cache_transport_or_admission_failure(self) -> None:
        assistants = _validate(
            {"version": 1, "locale": "en", "assistants": [_assistant(icon_digest=VERIFIED_ICON_DIGEST)]}
        )
        for factory in (
            mock.Mock(side_effect=OSError("offline")),
            mock.Mock(
                side_effect=[
                    _Connection(_Response(b"wrong", content_type="image/png")),
                    _Connection(_Response(b"wrong", content_type="image/png")),
                ]
            ),
        ):
            with self.subTest(factory=factory):
                catalog = store_catalog.StoreCatalog(loader=lambda _locale: assistants)
                cache = store_catalog.StoreIconCache()
                for _ in range(2):
                    with self.assertRaises(store_catalog.CatalogUnavailableError):
                        store_catalog.fetch_assistant_icon(
                            "shimpz-cloudflare",
                            catalog=catalog,
                            cache=cache,
                            connection_factory=factory,
                        )
                self.assertEqual(factory.call_count, 2)

    def test_icon_cache_enforces_independent_lru_byte_and_count_bounds(self) -> None:
        cache = store_catalog.StoreIconCache()
        keys = [(f"source-{value}", f"icon-{value}") for value in range(store_catalog.MAX_CACHED_ICONS + 1)]
        large_icon = b"x" * store_catalog.MAX_ICON_BYTES
        for key in keys[:8]:
            cache.remember(key, large_icon)
        self.assertIs(cache.get(keys[0]), large_icon)
        cache.remember(keys[8], large_icon)
        self.assertIsNone(cache.get(keys[1]))
        self.assertIs(cache.get(keys[0]), large_icon)

        cache = store_catalog.StoreIconCache()
        for key in keys:
            cache.remember(key, b"x")
        self.assertIsNone(cache.get(keys[0]))
        self.assertEqual(cache.get(keys[-1]), b"x")

    def test_content_length_and_stream_length_are_independently_bounded(self) -> None:
        response = _Response(b"{}")
        response._headers.pop("Content-Length")
        store_catalog._content_length(response)

        response._headers["Content-Length"] = "invalid"
        with self.assertRaises(store_catalog.CatalogUnavailableError):
            store_catalog._content_length(response)

        oversized = _Response(b"x" * (store_catalog.MAX_CATALOG_BYTES + 1))
        oversized._headers.pop("Content-Length")
        connection = _Connection(oversized)
        with self.assertRaises(store_catalog.CatalogUnavailableError):
            store_catalog.fetch_catalog("en", lambda *_args, **_kwargs: connection)

    def test_cache_expires_without_stale_fallback(self) -> None:
        now = [10.0]
        calls = 0
        assistant = _validate({"version": 1, "locale": "en", "assistants": [_assistant()]})

        def loader(_locale):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise store_catalog.CatalogUnavailableError("unavailable")
            return assistant

        catalog = store_catalog.StoreCatalog(loader=loader, clock=lambda: now[0])
        self.assertIs(catalog.get("en"), assistant)
        self.assertIs(catalog.get("en"), assistant)
        self.assertEqual(calls, 1)
        now[0] += store_catalog.CATALOG_TTL_SECONDS
        with self.assertRaises(store_catalog.CatalogUnavailableError):
            catalog.get("en")
        self.assertEqual(calls, 2)
        with self.assertRaises(store_catalog.CatalogUnavailableError):
            catalog.get("en")
        self.assertEqual(calls, 2)
        now[0] += store_catalog.CATALOG_TTL_SECONDS
        self.assertIs(catalog.get("en"), assistant)
        self.assertEqual(calls, 3)

    def test_cache_does_not_hold_its_state_lock_during_fetch(self) -> None:
        assistant = _validate({"version": 1, "locale": "en", "assistants": [_assistant()]})
        started = threading.Event()
        release = threading.Event()

        def loader(_locale):
            started.set()
            self.assertTrue(release.wait(timeout=10))
            return assistant

        catalog = store_catalog.StoreCatalog(loader=loader)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            refresh = executor.submit(catalog.get, "en")
            self.assertTrue(started.wait(timeout=10))
            # The cache state stays readable while the refresh is in flight.
            self.assertIsNone(executor.submit(catalog._cached, "en").result(timeout=5))
            release.set()
            self.assertIs(refresh.result(timeout=10), assistant)

    def test_concurrent_cold_reads_share_one_upstream_load(self) -> None:
        assistants = _validate({"version": 1, "locale": "en", "assistants": [_assistant()]})
        loads = 0
        entered = threading.Event()
        release = threading.Event()

        def loader(_locale) -> tuple[store_catalog.CatalogAssistant, ...]:
            nonlocal loads
            loads += 1
            entered.set()
            self.assertTrue(release.wait(timeout=10))
            return assistants

        catalog = store_catalog.StoreCatalog(loader=loader, clock=lambda: 100.0)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(catalog.get, "en")
            self.assertTrue(entered.wait(timeout=10))
            second = pool.submit(catalog.get, "en")
            release.set()
            self.assertEqual((first.result(timeout=10), second.result(timeout=10)), (assistants, assistants))
        self.assertEqual(loads, 1)

    def test_a_reader_behind_a_failed_refresh_shares_its_unavailability_without_loading_again(self) -> None:
        loads = 0
        entered = threading.Event()
        release = threading.Event()

        def loader(_locale):
            nonlocal loads
            loads += 1
            entered.set()
            self.assertTrue(release.wait(timeout=10))
            raise store_catalog.CatalogUnavailableError("unavailable")

        catalog = store_catalog.StoreCatalog(loader=loader, clock=lambda: 10.0)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(catalog.get, "en")
            self.assertTrue(entered.wait(timeout=10))
            second = pool.submit(catalog.get, "en")
            release.set()
            for reader in (first, second):
                with self.assertRaises(store_catalog.CatalogUnavailableError):
                    reader.result(timeout=10)
        self.assertEqual(loads, 1)


class LocalizedStoreCatalogTests(unittest.TestCase):
    """The catalog is fetched and cached per interface language; only summaries differ (ADR-0091)."""

    def test_admits_only_a_catalog_in_exactly_the_requested_locale(self) -> None:
        portuguese = {"version": 1, "locale": "pt", "assistants": [_assistant(summary="Gerencia zonas revisadas.")]}
        (assistant,) = store_catalog.validate_catalog(portuguese, "pt")
        self.assertEqual(assistant.summary, "Gerencia zonas revisadas.")
        for value, locale in (
            (portuguese, "en"),
            (portuguese, "it"),
            ({"version": 1, "assistants": []}, "en"),
            ({"version": 1, "locale": None, "assistants": []}, "en"),
        ):
            with self.subTest(locale=locale), self.assertRaisesRegex(ValueError, "catalog envelope is invalid"):
                store_catalog.validate_catalog(value, locale)

    def test_fetches_the_requested_locale_and_refuses_an_invalid_one_before_egress(self) -> None:
        body = json.dumps({"version": 1, "locale": "ja", "assistants": [_assistant()]}).encode()
        connection = _Connection(_Response(body))
        result = store_catalog.fetch_catalog("ja", lambda *_args, **_kwargs: connection)
        self.assertEqual(result[0].assistant_id, "shimpz-cloudflare")
        self.assertEqual(connection.request_value[1], f"{store_catalog.CATALOG_PATH}?locale=ja")
        factory = mock.Mock()
        for locale in ("it", "", "en&x=1"):
            with self.subTest(locale=locale), self.assertRaises(store_catalog.CatalogUnavailableError):
                store_catalog.fetch_catalog(locale, factory)
        factory.assert_not_called()

    def test_caches_each_locale_independently_and_refuses_an_invalid_locale(self) -> None:
        loads: list[str] = []

        def loader(locale: str) -> tuple[store_catalog.CatalogAssistant, ...]:
            loads.append(locale)
            value = {"version": 1, "locale": locale, "assistants": [_assistant(summary=f"Summary {locale}.")]}
            return store_catalog.validate_catalog(value, locale)

        catalog = store_catalog.StoreCatalog(loader=loader, clock=lambda: 10.0)
        self.assertEqual(catalog.get("en")[0].summary, "Summary en.")
        self.assertEqual(catalog.get("pt")[0].summary, "Summary pt.")
        self.assertEqual(catalog.get("en")[0].summary, "Summary en.")
        self.assertEqual(catalog.get("pt")[0].summary, "Summary pt.")
        self.assertEqual(loads, ["en", "pt"])
        with self.assertRaises(store_catalog.CatalogUnavailableError):
            catalog.get("pt-BR")
        self.assertEqual(loads, ["en", "pt"])


if __name__ == "__main__":
    unittest.main()
