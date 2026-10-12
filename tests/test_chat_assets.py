"""The Store catalog in bounded session pages and the bounded same-origin public Assistant icons."""

import asyncio
import concurrent.futures
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from protocol.socket.v1 import frames

from chat import assets, store_catalog


def _future(*, result: object = None, error: Exception | None = None):
    future = concurrent.futures.Future()
    if error is not None:
        future.set_exception(error)
    else:
        future.set_result(result)
    return future


def _assistant(assistant_id: str = "shimpz-cloudflare", description: str = "Lê seus domínios."):
    return store_catalog.CatalogAssistant(
        assistant_id=assistant_id,
        name="Shimpz Cloudflare",
        summary="Manage Cloudflare DNS.",
        source_digest="sha256:" + ("a" * 64),
        icon_digest="sha256:" + ("b" * 64),
        integrations=(),
        actions=("list-zones",),
        assistant_version="0.4.5",
        creators=("@shimpz",),
        page=store_catalog.CatalogPage(
            description=description,
            links=(),
            actions=(store_catalog.CatalogAction("list-zones", "read_only", "Ver seus domínios."),),
            stored_inputs=(),
        ),
    )


def _catalog(*assistants):
    return mock.patch.object(store_catalog.CATALOG, "get", return_value=assistants)


class CatalogPageTests(unittest.TestCase):
    def test_projects_one_page_of_the_catalog_in_its_locale(self) -> None:
        assistant = store_catalog.CatalogAssistant(
            assistant_id="shimpz-cloudflare",
            name="Shimpz Cloudflare",
            summary="Manage Cloudflare DNS.",
            source_digest="sha256:" + ("a" * 64),
            icon_digest="sha256:" + ("b" * 64),
            integrations=(store_catalog.CatalogIntegration("cloudflare", ("zone.read",)),),
            actions=("list-zones",),
            assistant_version="0.4.5",
            creators=("@shimpz",),
            page=store_catalog.CatalogPage(
                description="Lê seus domínios.",
                links=(("github", "https://github.com/shimpz"),),
                actions=(store_catalog.CatalogAction("list-zones", "read_only", "Ver seus domínios."),),
                stored_inputs=(
                    store_catalog.CatalogStoredInput(
                        "token", "Chave", "Crie uma chave no painel e copie-a.", "https://dashboard.exa.ai/api-keys"
                    ),
                ),
            ),
        )
        with mock.patch.object(store_catalog.CATALOG, "get", return_value=(assistant,)) as get:
            page = assets.catalog_page("pt")

        get.assert_called_once_with("pt")
        self.assertEqual(
            page,
            {
                "version": 1,
                "locale": "pt",
                "next": None,
                "assistants": [
                    {
                        "assistant_id": "shimpz-cloudflare",
                        "name": "Shimpz Cloudflare",
                        "summary": "Manage Cloudflare DNS.",
                        "description": "Lê seus domínios.",
                        "assistant_version": "0.4.5",
                        "creators": ["@shimpz"],
                        "links": {"github": "https://github.com/shimpz"},
                        "source_digest": "sha256:" + "a" * 64,
                        "icon_digest": "sha256:" + "b" * 64,
                        "actions": [{"id": "list-zones", "effect": "read_only", "description": "Ver seus domínios."}],
                        "integrations": [{"id": "cloudflare", "provider": "cloudflare"}],
                        "stored_inputs": [
                            {
                                "id": "token",
                                "label": "Chave",
                                "description": "Crie uma chave no painel e copie-a.",
                                "help_url": "https://dashboard.exa.ai/api-keys",
                            }
                        ],
                    }
                ],
            },
        )

    def test_a_catalog_entry_without_its_page_copy_fails_closed(self) -> None:
        assistant = store_catalog.CatalogAssistant(
            assistant_id="shimpz-cloudflare",
            name="Shimpz Cloudflare",
            summary="Manage Cloudflare DNS.",
            source_digest="sha256:" + ("a" * 64),
            icon_digest="sha256:" + ("b" * 64),
            integrations=(),
            actions=("list-zones",),
        )
        with _catalog(assistant), self.assertRaises(assets.HTTPException) as caught:
            assets.catalog_page("en")
        self.assertEqual(caught.exception.status_code, 502)

    def test_refuses_a_catalog_locale_outside_the_closed_set_before_any_work(self) -> None:
        with mock.patch.object(store_catalog.CATALOG, "get") as get:
            for locale in ("", "it", "PT", "pt-BR"):
                with self.subTest(locale=locale), self.assertRaises(assets.HTTPException) as caught:
                    assets.catalog_page(locale)
                self.assertEqual(caught.exception.status_code, 422)
        get.assert_not_called()

    def test_pages_join_into_the_whole_catalog_and_each_result_frame_fits_the_outbound_bound(self) -> None:
        # Seven Assistants of about 300 KB each: no page holds more than three, and every page is a whole frame.
        catalog = tuple(_assistant(f"assistant-{index}", "é" * 150_000) for index in range(7))
        joined, pages, cursor = [], 0, None
        with _catalog(*catalog):
            while True:
                page = assets.catalog_page("en", cursor)
                frame = frames.result("c" * 64, 200, page)
                self.assertLessEqual(len(frames.encode(frame).encode()), frames.MAX_OUTBOUND_BYTES)
                joined.extend(item["assistant_id"] for item in page["assistants"])
                pages += 1
                if (cursor := page["next"]) is None:
                    break
        self.assertEqual(joined, [assistant.assistant_id for assistant in catalog])
        self.assertGreater(pages, 2)

    def test_a_catalog_that_changed_between_pages_is_read_again_from_the_first(self) -> None:
        big = tuple(_assistant(f"assistant-{index}", "x" * 400_000) for index in range(3))
        with _catalog(*big):
            cursor = assets.catalog_page("en")["next"]
        with _catalog(*big[:2], _assistant("assistant-new", "x" * 400_000)):
            self.assertEqual(
                assets.catalog_page("en", cursor),
                (409, {"code": "catalog-changed", "detail": "The Assistant catalog changed; read it again"}),
            )

    def test_a_cursor_outside_its_grammar_or_its_catalog_is_refused(self) -> None:
        catalog = (_assistant("one"), _assistant("two"))
        with _catalog(*catalog):
            digest = assets._catalog("en")[0]
            for cursor in ("", "0." + digest, "2." + digest, "01." + digest, "1." + digest.upper(), "1"):
                with self.subTest(cursor=cursor), self.assertRaises(assets.HTTPException) as caught:
                    assets.catalog_page("en", cursor)
                self.assertEqual(caught.exception.status_code, 400)
            self.assertEqual(assets.catalog_page("en", "1." + digest)["assistants"][0]["assistant_id"], "two")

    def test_an_empty_catalog_is_one_last_page_and_an_entry_larger_than_a_page_fails_closed(self) -> None:
        with _catalog():
            self.assertEqual(assets.catalog_page("en"), {"version": 1, "locale": "en", "assistants": [], "next": None})
        with _catalog(_assistant("huge", "x" * assets.PAGE_BYTES)), self.assertRaises(assets.HTTPException) as caught:
            assets.catalog_page("en")
        self.assertEqual(caught.exception.status_code, 502)


class ChatAssetTests(unittest.TestCase):
    def test_projects_one_verified_png_with_closed_browser_headers(self) -> None:
        with mock.patch.object(assets, "submit_in_context", return_value=_future(result=b"png")) as submit:
            response = asyncio.run(assets.assistant_icon("shimpz-cloudflare"))

        submit.assert_called_once_with(
            assets._ICON_EXECUTOR,
            store_catalog.fetch_assistant_icon,
            "shimpz-cloudflare",
        )
        self.assertEqual(response.body, b"png")
        self.assertEqual(response.media_type, "image/png")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_maps_bounded_admission_and_catalog_failures_without_details(self) -> None:
        failures = (
            (assets.ExecutorSaturatedError("full"), 503, True),
            (store_catalog.CatalogAssistantNotFoundError("missing secret"), 404, False),
            (store_catalog.CatalogUnavailableError("upstream secret"), 502, False),
        )
        for error, status, submit_failure in failures:
            with self.subTest(status=status):
                replacement = (
                    mock.patch.object(assets, "submit_in_context", side_effect=error)
                    if submit_failure
                    else mock.patch.object(assets, "submit_in_context", return_value=_future(error=error))
                )
                with replacement, self.assertRaises(assets.HTTPException) as caught:
                    asyncio.run(assets.assistant_icon("shimpz-cloudflare"))
                self.assertEqual(caught.exception.status_code, status)
                self.assertEqual(caught.exception.detail, "Assistant icon is unavailable")

    def test_an_unavailable_store_catalog_answers_without_details(self) -> None:
        unavailable = store_catalog.CatalogUnavailableError("upstream secret")
        with (
            mock.patch.object(store_catalog.CATALOG, "get", side_effect=unavailable),
            self.assertRaises(assets.HTTPException) as caught,
        ):
            assets.catalog_page("en")
        self.assertEqual(
            (caught.exception.status_code, caught.exception.detail), (502, "Assistant catalog is unavailable")
        )


if __name__ == "__main__":
    unittest.main()
