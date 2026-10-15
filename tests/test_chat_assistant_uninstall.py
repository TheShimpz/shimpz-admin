"""Strict contracts for the installed Assistant directory and uninstall execution."""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import transport

from chat import assistant_proposal, assistant_uninstall


def _installed(*items: tuple[str, str]):
    return transport.TeamResponse(
        200,
        {
            "assistants": [
                {
                    "assistant": assistant_id,
                    "assistant_version": version,
                    "provenance": "published",
                    "status": "running",
                }
                for assistant_id, version in items
            ],
            "trace_id": "a" * 32,
        },
    )


def _inventory(*items: tuple[str, str]):
    """Patch Team's installed inventory to answer these (Assistant, version) pairs."""
    return mock.patch.object(assistant_uninstall.team, "list_installed_assistants", return_value=_installed(*items))


def _registry(*assistant_ids: str):
    return transport.TeamResponse(
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
        "published",
    )
    return assistant_proposal.create_uninstall_proposal(
        "team_1",
        assistant_proposal.UninstallTarget(candidate, "@shimpz"),
        locale="pt",
        now=1.0,
    )


class AssistantUninstallDirectoryTests(unittest.TestCase):
    def test_returns_only_installed_team_identities(self) -> None:
        with (
            _inventory(("shimpz-cloudflare", "0.4.4")),
            mock.patch.object(
                assistant_uninstall.team,
                "team_assistant_registry",
                return_value=_registry("shimpz-cloudflare"),
            ),
        ):
            directory = assistant_uninstall.candidates("team_1")

        self.assertEqual(len(directory.candidates), 1)
        self.assertEqual(directory.refused, frozenset())
        candidate = directory.candidates[0]
        self.assertEqual(candidate.assistant.assistant_id, "shimpz-cloudflare")
        self.assertEqual(candidate.version, "0.4.4")

    def test_registry_drift_fails_closed(self) -> None:
        with (
            _inventory(("shimpz-cloudflare", "0.4.4")),
            mock.patch.object(assistant_uninstall.team, "team_assistant_registry", return_value=_registry()),
            self.assertRaises(ValueError),
        ):
            assistant_uninstall.candidates("team_1")

    def test_an_assistant_needing_replacement_stays_nameable_but_marked_refused(self) -> None:
        installed = _installed(("drifted", "2.0.0"), ("shimpz-cloudflare", "0.4.4"), ("stale", "1.0.0"))
        # A binding admitted with egress drift is invalid too, but it is in the registry and stays uninstallable.
        installed.body["assistants"][0]["status"] = "invalid"
        installed.body["assistants"][2]["status"] = "invalid"
        with (
            mock.patch.object(assistant_uninstall.team, "list_installed_assistants", return_value=installed),
            mock.patch.object(
                assistant_uninstall.team,
                "team_assistant_registry",
                return_value=_registry("drifted", "shimpz-cloudflare"),
            ),
        ):
            directory = assistant_uninstall.candidates("team_1")

        self.assertEqual(
            [candidate.assistant.assistant_id for candidate in directory.candidates],
            ["drifted", "shimpz-cloudflare", "stale"],
        )
        self.assertEqual(directory.refused, frozenset({"stale"}))
        self.assertEqual(directory.candidates[2].assistant.name, "stale")


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
        response = transport.TeamResponse(
            200,
            {"assistant": "shimpz-cloudflare", "uninstalled": True, "trace_id": "c" * 32},
        )
        with (
            _inventory(("shimpz-cloudflare", "0.4.4")),
            mock.patch.object(
                assistant_uninstall.team,
                "uninstall_assistant",
                return_value=response,
            ) as uninstall,
        ):
            result = assistant_uninstall.uninstall(_proposal())

        self.assertEqual(result, assistant_uninstall.UninstallResult(200, True))
        uninstall.assert_called_once_with("team_1", "shimpz-cloudflare")

    def test_team_confirmed_absence_race_is_idempotent_success_and_a_404_is_not(self) -> None:
        absent = transport.TeamResponse(
            200,
            {"assistant": "shimpz-cloudflare", "uninstalled": False, "trace_id": "c" * 32},
        )
        refused = transport.TeamResponse(
            404,
            {
                "code": "assistant-not-allowlisted",
                "error": "Assistant is not allowlisted",
                "trace_id": "c" * 32,
            },
        )
        for response, expected in (
            (absent, assistant_uninstall.UninstallResult(200, False)),
            (refused, assistant_uninstall.UninstallResult(404)),
        ):
            with (
                self.subTest(status=response.status),
                _inventory(("shimpz-cloudflare", "0.4.4")),
                mock.patch.object(assistant_uninstall.team, "uninstall_assistant", return_value=response),
            ):
                self.assertEqual(assistant_uninstall.uninstall(_proposal()), expected)

    def test_local_uninstall_rejects_an_unknown_field(self) -> None:
        valid = transport.TeamResponse(
            200,
            {"assistant": "shimpz-cloudflare", "uninstalled": True},
        )
        extra = transport.TeamResponse(
            200,
            {"assistant": "shimpz-cloudflare", "uninstalled": True, "unexpected": True},
        )
        self.assertTrue(assistant_uninstall._uninstall_body(valid, "shimpz-cloudflare"))
        self.assertEqual(
            assistant_uninstall._project_result(valid, "shimpz-cloudflare"),
            assistant_uninstall.UninstallResult(200, True),
        )
        with self.assertRaises(ValueError):
            assistant_uninstall._uninstall_body(extra, "shimpz-cloudflare")
        self.assertEqual(
            assistant_uninstall._project_result(extra, "shimpz-cloudflare"),
            assistant_uninstall.UninstallResult(502),
        )

    def test_malformed_absence_or_success_never_claims_removal(self) -> None:
        responses = (
            transport.TeamResponse(404, {"code": "assistant-not-allowlisted"}),
            transport.TeamResponse(
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
                _inventory(("shimpz-cloudflare", "0.4.4")),
                mock.patch.object(assistant_uninstall.team, "uninstall_assistant", return_value=response),
            ):
                self.assertEqual(assistant_uninstall.uninstall(_proposal()), result)


if __name__ == "__main__":
    unittest.main()
