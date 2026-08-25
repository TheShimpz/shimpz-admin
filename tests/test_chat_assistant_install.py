"""Contracts for strict conversational Assistant discovery and installation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assistant_install, assistant_proposal, store_catalog


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


def _installed(*assistant_ids: str):
    return assistant_install.team.TeamResponse(
        200,
        {
            "assistants": [
                {"assistant": assistant_id, "assistant_version": "1.0.0", "status": "running"}
                for assistant_id in assistant_ids
            ],
            "trace_id": "a" * 32,
        },
    )


def _registry(*assistants: tuple[str, tuple[str, ...]]):
    return assistant_install.team.TeamResponse(
        200,
        {
            "assistants": [
                {
                    "id": assistant_id,
                    "title": assistant_id.replace("-", " ").title(),
                    "summary": "Provides reviewed DNS operations.",
                    "actions": list(actions),
                }
                for assistant_id, actions in assistants
            ]
        },
    )


class AssistantDiscoveryTests(unittest.TestCase):
    def test_selects_from_store_only_after_strict_team_state(self) -> None:
        catalog = mock.Mock()
        catalog.get.return_value = (_candidate(),)
        with (
            mock.patch.object(assistant_install.team, "list_installed_assistants", return_value=_installed()),
            mock.patch.object(assistant_install.team, "list_assistants", return_value=_registry()),
        ):
            selected = assistant_install.discover(
                "team_1",
                "Quero listar minhas zonas DNS da Cloudflare",
                (),
                catalog,
            )

        self.assertEqual(selected, _candidate())
        catalog.get.assert_called_once_with()

    def test_installed_candidate_and_enabled_equivalent_are_suppressed(self) -> None:
        catalog = mock.Mock()
        catalog.get.return_value = (_candidate(),)
        cases = (
            (
                _installed("shimpz-cloudflare"),
                _registry(("shimpz-cloudflare", ("list-zones",))),
                (),
            ),
            (
                _installed("dns-helper"),
                _registry(("dns-helper", ("list-zones",))),
                ("dns-helper",),
            ),
        )
        for inventory, registry, enabled in cases:
            with (
                self.subTest(enabled=enabled),
                mock.patch.object(
                    assistant_install.team,
                    "list_installed_assistants",
                    return_value=inventory,
                ),
                mock.patch.object(assistant_install.team, "list_assistants", return_value=registry),
            ):
                self.assertIsNone(assistant_install.discover("team_1", "list-zones", enabled, catalog))

    def test_malformed_team_authority_rejects_discovery(self) -> None:
        malformed = assistant_install.team.TeamResponse(200, {"assistants": [], "extra": True})
        with (
            mock.patch.object(
                assistant_install.team,
                "list_installed_assistants",
                return_value=malformed,
            ),
            mock.patch.object(assistant_install.team, "list_assistants") as registry,
            self.assertRaises(ValueError),
        ):
            assistant_install.discover("team_1", "cloudflare", (), mock.Mock())
        registry.assert_not_called()

    def test_team_inventory_rejects_each_malformed_projection(self) -> None:
        responses = (
            assistant_install.team.TeamResponse(200, {"assistants": [], "trace_id": "bad"}),
            assistant_install.team.TeamResponse(200, {"assistants": {}}),
            assistant_install.team.TeamResponse(200, {"assistants": [{}]}),
            assistant_install.team.TeamResponse(
                200,
                {"assistants": [{"assistant": "valid", "assistant_version": "bad", "status": "running"}]},
            ),
            assistant_install.team.TeamResponse(
                200,
                {
                    "assistants": [
                        {"assistant": "valid", "assistant_version": "1.0.0", "status": "running"},
                        {"assistant": "valid", "assistant_version": "1.0.0", "status": "running"},
                    ]
                },
            ),
        )
        for response in responses:
            with self.subTest(response=response), self.assertRaises(ValueError):
                assistant_install._installed(response)

    def test_registry_rejects_malformed_projection_and_text(self) -> None:
        responses = (
            assistant_install.team.TeamResponse(200, {"assistants": {}}),
            assistant_install.team.TeamResponse(200, {"assistants": [{}]}),
            assistant_install.team.TeamResponse(
                200,
                {"assistants": [{"id": "valid", "title": "Valid", "summary": "Valid", "actions": []}]},
            ),
        )
        for response in responses:
            with self.subTest(response=response), self.assertRaises(ValueError):
                assistant_install._registry(response)
        with self.assertRaises(ValueError):
            assistant_install._text(" invalid", 80)

    def test_enabled_scope_must_be_bounded_and_authoritative(self) -> None:
        with self.assertRaises(ValueError):
            assistant_install.discover("team_1", "dns", ("duplicate", "duplicate"), mock.Mock())
        with (
            mock.patch.object(assistant_install.team, "list_installed_assistants", return_value=_installed()),
            mock.patch.object(
                assistant_install.team,
                "list_assistants",
                return_value=_registry(("dns-helper", ("list-zones",))),
            ),
            self.assertRaises(ValueError),
        ):
            assistant_install.discover("team_1", "dns", ("dns-helper",), mock.Mock())


class AssistantInstallTests(unittest.TestCase):
    def setUp(self) -> None:
        self.proposal = assistant_proposal.create_proposal(
            "team_1",
            _candidate(),
            language_exemplar="Liste minhas zonas DNS",
            now=1,
            proposal_id_factory=lambda: "b" * 32,
        )

    def test_submits_exact_hidden_resolution_and_projects_success(self) -> None:
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
            result = assistant_install.install(self.proposal)

        self.assertEqual(result, assistant_install.InstallResult(200, True))
        install.assert_called_once_with(
            "team_1",
            {
                "assistant_id": "shimpz-cloudflare",
                "source_digest": "sha256:" + ("a" * 64),
            },
        )

    def test_rejects_malformed_success_and_preserves_only_failure_status(self) -> None:
        cases = (
            (
                assistant_install.team.TeamResponse(
                    200,
                    {"assistant": "other", "installed": True},
                ),
                assistant_install.InstallResult(502),
            ),
            (
                assistant_install.team.TeamResponse(409, {"detail": "/private/path"}),
                assistant_install.InstallResult(409),
            ),
        )
        for response, expected in cases:
            with (
                self.subTest(response=response),
                mock.patch.object(
                    assistant_install.team,
                    "install_assistant",
                    return_value=response,
                ),
            ):
                self.assertEqual(assistant_install.install(self.proposal), expected)

    def test_rejects_invalid_team_response_authority(self) -> None:
        with mock.patch.object(assistant_install.team, "install_assistant", return_value=object()):
            self.assertEqual(assistant_install.install(self.proposal), assistant_install.InstallResult(502))

        malformed = (
            assistant_install.team.TeamResponse(200, []),
            assistant_install.team.TeamResponse(
                200,
                {"assistant": "shimpz-cloudflare", "installed": True, "trace_id": "bad"},
            ),
        )
        for response in malformed:
            with self.subTest(response=response), self.assertRaises(ValueError):
                assistant_install._install_body(response, "shimpz-cloudflare")

    def test_admits_only_exact_action_labels_bound_to_the_proposal(self) -> None:
        response = assistant_install.team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "assistant": "shimpz-cloudflare",
                "assistant_version": "0.4.4",
                "actions": [
                    {"id": "list-zones", "label": "Listar zonas DNS"},
                    {"id": "records.read", "label": "Consultar registros DNS"},
                ],
            },
        )

        self.assertEqual(
            assistant_install.action_labels(response, self.proposal),
            assistant_install.ActionLabels(
                "0.4.4",
                (
                    assistant_install.ActionLabel("list-zones", "Listar zonas DNS"),
                    assistant_install.ActionLabel("records.read", "Consultar registros DNS"),
                ),
            ),
        )

        for body in (
            {**response.body, "team_id": "team_2"},
            {**response.body, "assistant": "other"},
            {**response.body, "actions": []},
            {**response.body, "actions": list(reversed(response.body["actions"]))},
            {**response.body, "actions": [{"id": "list-zones", "label": "\u202eDNS"}]},
            {**response.body, "extra": True},
        ):
            with self.subTest(body=body):
                self.assertIsNone(
                    assistant_install.action_labels(
                        assistant_install.team.TeamResponse(200, body),
                        self.proposal,
                    )
                )


if __name__ == "__main__":
    unittest.main()
