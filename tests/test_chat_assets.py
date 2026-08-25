"""Bounded same-origin chat asset projection contracts."""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assets, store_catalog


def _future(*, result: bytes | None = None, error: Exception | None = None):
    future = concurrent.futures.Future()
    if error is not None:
        future.set_exception(error)
    else:
        future.set_result(result)
    return future


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


if __name__ == "__main__":
    unittest.main()
