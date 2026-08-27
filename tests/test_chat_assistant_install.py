"""Exact Team projection tests for automatic Assistant installation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assistant_install, store_catalog


def _candidate() -> store_catalog.CatalogAssistant:
    return store_catalog.CatalogAssistant(
        assistant_id="shimpz-cloudflare",
        name="Shimpz Cloudflare",
        summary="Manage Cloudflare zones and DNS records.",
        source_digest="sha256:" + ("a" * 64),
        icon_digest="sha256:" + ("b" * 64),
        integrations=(store_catalog.CatalogIntegration("cloudflare", ("zone.read",)),),
        actions=("list-zones",),
    )


class AssistantInstallTests(unittest.TestCase):
    def test_submits_only_the_exact_store_publication(self) -> None:
        response = assistant_install.team.TeamResponse(
            200,
            {
                "assistant": "shimpz-cloudflare",
                "installed": True,
                "trace_id": "c" * 32,
            },
        )
        with mock.patch.object(
            assistant_install.team,
            "install_assistant",
            return_value=response,
        ) as install:
            result = assistant_install.install_publication("team_1", _candidate())

        self.assertEqual(result, assistant_install.InstallResult(200, True))
        install.assert_called_once_with(
            "team_1",
            {
                "assistant_id": "shimpz-cloudflare",
                "source_digest": "sha256:" + ("a" * 64),
            },
        )

    def test_rejects_malformed_success_and_redacts_failure_body(self) -> None:
        cases = (
            (
                assistant_install.team.TeamResponse(200, {"assistant": "other", "installed": True}),
                assistant_install.InstallResult(502),
            ),
            (
                assistant_install.team.TeamResponse(409, {"detail": "/private/path"}),
                assistant_install.InstallResult(409),
            ),
            (object(), assistant_install.InstallResult(502)),
        )
        for response, expected in cases:
            with (
                self.subTest(response=response),
                mock.patch.object(assistant_install.team, "install_assistant", return_value=response),
            ):
                self.assertEqual(
                    assistant_install.install_publication("team_1", _candidate()),
                    expected,
                )

    def test_success_projection_requires_exact_identity_boolean_and_trace(self) -> None:
        malformed = (
            assistant_install.team.TeamResponse(200, []),
            assistant_install.team.TeamResponse(
                200,
                {"assistant": "shimpz-cloudflare", "installed": True, "trace_id": "bad"},
            ),
            assistant_install.team.TeamResponse(
                200,
                {"assistant": "shimpz-cloudflare", "installed": 1},
            ),
        )
        for response in malformed:
            with self.subTest(response=response), self.assertRaises(ValueError):
                assistant_install._install_body(response, "shimpz-cloudflare")


if __name__ == "__main__":
    unittest.main()
