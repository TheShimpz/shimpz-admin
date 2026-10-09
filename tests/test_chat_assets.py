"""Bounded same-origin chat asset projection contracts."""

import asyncio
import concurrent.futures
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assets, store_catalog


def _future(*, result: object = None, error: Exception | None = None):
    future = concurrent.futures.Future()
    if error is not None:
        future.set_exception(error)
    else:
        future.set_result(result)
    return future


class ChatAssetTests(unittest.TestCase):
    def test_projects_the_bounded_catalog_with_no_store_headers(self) -> None:
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
        with mock.patch.object(assets, "submit_in_context", return_value=_future(result=(assistant,))) as submit:
            response = asyncio.run(assets.assistant_catalog("pt"))

        submit.assert_called_once_with(assets._CATALOG_EXECUTOR, store_catalog.CATALOG.get, "pt")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(
            json.loads(response.body),
            {
                "version": 1,
                "locale": "pt",
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
        with (
            mock.patch.object(assets, "submit_in_context", return_value=_future(result=(assistant,))),
            self.assertRaises(assets.HTTPException) as caught,
        ):
            asyncio.run(assets.assistant_catalog("en"))
        self.assertEqual(caught.exception.status_code, 502)

    def test_refuses_a_catalog_locale_outside_the_closed_set_before_any_work(self) -> None:
        with mock.patch.object(assets, "submit_in_context") as submit:
            for locale in ("", "it", "PT", "pt-BR"):
                with self.subTest(locale=locale), self.assertRaises(assets.HTTPException) as caught:
                    asyncio.run(assets.assistant_catalog(locale))
                self.assertEqual(caught.exception.status_code, 422)
        submit.assert_not_called()

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

    def test_maps_catalog_capacity_and_upstream_failures_without_details(self) -> None:
        for error, submit_failure, status in (
            (assets.ExecutorSaturatedError("full"), True, 503),
            (store_catalog.CatalogUnavailableError("upstream secret"), False, 502),
        ):
            replacement = (
                mock.patch.object(assets, "submit_in_context", side_effect=error)
                if submit_failure
                else mock.patch.object(assets, "submit_in_context", return_value=_future(error=error))
            )
            with replacement, self.assertRaises(assets.HTTPException) as caught:
                asyncio.run(assets.assistant_catalog("en"))
            self.assertEqual(caught.exception.status_code, status)
            self.assertEqual(caught.exception.detail, "Assistant catalog is unavailable")


if __name__ == "__main__":
    unittest.main()
