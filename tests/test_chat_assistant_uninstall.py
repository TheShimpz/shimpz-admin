"""Strict contracts for conversational Assistant uninstall discovery and execution."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assistant_proposal, assistant_uninstall


def _installed(*items: tuple[str, str]):
    return assistant_uninstall.team.TeamResponse(
        200,
        {
            "assistants": [
                {"assistant": assistant_id, "assistant_version": version, "status": "running"}
                for assistant_id, version in items
            ],
            "trace_id": "a" * 32,
        },
    )


def _registry(*assistant_ids: str):
    return assistant_uninstall.team.TeamResponse(
        200,
        {
            "assistants": [
                {
                    "id": assistant_id,
                    "title": "Shimpz Cloudflare" if assistant_id == "shimpz-cloudflare" else "DNS Audit",
                    "summary": "Provides reviewed DNS operations.",
                    "actions": ["list-zones"],
                }
                for assistant_id in assistant_ids
            ]
        },
    )


def _proposal(version: str = "0.4.4") -> assistant_proposal.UninstallProposal:
    candidate = assistant_proposal.UninstallCandidate(
        assistant_proposal.Capability(
            "shimpz-cloudflare",
            "Shimpz Cloudflare",
            "Provides reviewed DNS operations.",
            ("list-zones",),
        ),
        version,
    )
    return assistant_proposal.create_uninstall_proposal(
        "team_1",
        candidate,
        language_exemplar="Desinstale o Assistant do Cloudflare",
        now=1.0,
        proposal_id_factory=lambda: "b" * 32,
    )


class AssistantUninstallDiscoveryTests(unittest.TestCase):
    def test_action_removal_text_cannot_select_the_installed_assistant(self) -> None:
        with (
            mock.patch.object(
                assistant_uninstall.team,
                "list_installed_assistants",
                return_value=_installed(("shimpz-cloudflare", "0.4.4")),
            ),
            mock.patch.object(
                assistant_uninstall.team,
                "list_assistants",
                return_value=_registry("shimpz-cloudflare"),
            ),
        ):
            self.assertIsNone(
                assistant_uninstall.discover("team_1", "Remova um registro DNS da Cloudflare"),
            )

    def test_selects_only_one_installed_team_identity(self) -> None:
        with (
            mock.patch.object(
                assistant_uninstall.team,
                "list_installed_assistants",
                return_value=_installed(("shimpz-cloudflare", "0.4.4")),
            ),
            mock.patch.object(
                assistant_uninstall.team,
                "list_assistants",
                return_value=_registry("shimpz-cloudflare"),
            ),
        ):
            candidate = assistant_uninstall.discover(
                "team_1",
                "Desinstale o assistant do Cloudflare",
            )

        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.assistant.assistant_id, "shimpz-cloudflare")
        self.assertEqual(candidate.version, "0.4.4")

    def test_registry_drift_fails_closed(self) -> None:
        with (
            mock.patch.object(
                assistant_uninstall.team,
                "list_installed_assistants",
                return_value=_installed(("shimpz-cloudflare", "0.4.4")),
            ),
            mock.patch.object(assistant_uninstall.team, "list_assistants", return_value=_registry()),
            self.assertRaises(ValueError),
        ):
            assistant_uninstall.discover("team_1", "Desinstale o Shimpz Cloudflare")


class AssistantUninstallExecutionTests(unittest.TestCase):
    def test_absent_and_version_changed_targets_never_reach_delete(self) -> None:
        cases = (
            (_installed(), assistant_uninstall.UninstallResult(200, False)),
            (
                _installed(("shimpz-cloudflare", "0.5.0")),
                assistant_uninstall.UninstallResult(409),
            ),
        )
        for inventory, expected in cases:
            with (
                self.subTest(expected=expected),
                mock.patch.object(
                    assistant_uninstall.team,
                    "list_installed_assistants",
                    return_value=inventory,
                ),
                mock.patch.object(assistant_uninstall.team, "uninstall_assistant") as uninstall,
            ):
                self.assertEqual(assistant_uninstall.uninstall(_proposal()), expected)
                uninstall.assert_not_called()

    def test_revalidated_target_uses_only_the_team_delete_route(self) -> None:
        response = assistant_uninstall.team.TeamResponse(
            200,
            {"assistant": "shimpz-cloudflare", "uninstalled": True, "trace_id": "c" * 32},
        )
        with (
            mock.patch.object(
                assistant_uninstall.team,
                "list_installed_assistants",
                return_value=_installed(("shimpz-cloudflare", "0.4.4")),
            ),
            mock.patch.object(
                assistant_uninstall.team,
                "uninstall_assistant",
                return_value=response,
            ) as uninstall,
        ):
            result = assistant_uninstall.uninstall(_proposal())

        self.assertEqual(result, assistant_uninstall.UninstallResult(200, True))
        uninstall.assert_called_once_with("team_1", "shimpz-cloudflare")

    def test_exact_team_absence_race_is_idempotent_success(self) -> None:
        response = assistant_uninstall.team.TeamResponse(
            404,
            {
                "code": "assistant-not-allowlisted",
                "error": "Assistant is not allowlisted",
                "trace_id": "c" * 32,
            },
        )
        with (
            mock.patch.object(
                assistant_uninstall.team,
                "list_installed_assistants",
                return_value=_installed(("shimpz-cloudflare", "0.4.4")),
            ),
            mock.patch.object(assistant_uninstall.team, "uninstall_assistant", return_value=response),
        ):
            self.assertEqual(
                assistant_uninstall.uninstall(_proposal()),
                assistant_uninstall.UninstallResult(200, False),
            )

    def test_local_uninstall_accepts_only_the_exact_retained_image_command(self) -> None:
        image_id = "sha256:" + ("d" * 64)
        valid = assistant_uninstall.team.TeamResponse(
            200,
            {
                "assistant": "shimpz-cloudflare",
                "uninstalled": True,
                "staged_image_retained": image_id,
                "remove_command": f"docker image rm {image_id}",
            },
        )
        invalid = assistant_uninstall.team.TeamResponse(
            200,
            {
                **valid.body,
                "remove_command": "docker image prune",
            },
        )

        self.assertEqual(
            assistant_uninstall._uninstall_body(valid, "shimpz-cloudflare"),
            (True, image_id, f"docker image rm {image_id}"),
        )
        self.assertEqual(
            assistant_uninstall._project_result(valid, "shimpz-cloudflare"),
            assistant_uninstall.UninstallResult(
                200,
                True,
                image_id,
                f"docker image rm {image_id}",
            ),
        )
        with self.assertRaises(ValueError):
            assistant_uninstall._uninstall_body(invalid, "shimpz-cloudflare")

    def test_malformed_absence_or_success_never_claims_removal(self) -> None:
        responses = (
            assistant_uninstall.team.TeamResponse(404, {"code": "assistant-not-allowlisted"}),
            assistant_uninstall.team.TeamResponse(
                200,
                {"assistant": "other", "uninstalled": True},
            ),
            object(),
        )
        expected = (
            assistant_uninstall.UninstallResult(404),
            assistant_uninstall.UninstallResult(502),
            assistant_uninstall.UninstallResult(502),
        )
        for response, result in zip(responses, expected, strict=True):
            with (
                self.subTest(response=response),
                mock.patch.object(
                    assistant_uninstall.team,
                    "list_installed_assistants",
                    return_value=_installed(("shimpz-cloudflare", "0.4.4")),
                ),
                mock.patch.object(assistant_uninstall.team, "uninstall_assistant", return_value=response),
            ):
                self.assertEqual(assistant_uninstall.uninstall(_proposal()), result)


if __name__ == "__main__":
    unittest.main()
