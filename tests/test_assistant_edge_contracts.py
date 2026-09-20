"""Fail-closed edge coverage for composed Assistant Admin projections."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team

from action import stored_input
from chat import (
    assistant_install,
    assistant_inventory,
    assistant_plan,
    assistant_proposal,
    assistant_uninstall,
    local,
    store_catalog,
)


def _catalog_assistant(assistant_id: str, *, provider: str = "provider") -> store_catalog.CatalogAssistant:
    digest = "sha256:" + ("a" * 64)
    return store_catalog.CatalogAssistant(
        assistant_id,
        assistant_id.title(),
        "Provides reviewed automation.",
        digest,
        digest,
        (store_catalog.CatalogIntegration(provider, ("scope",)),),
        ("send-message",),
    )


class StoredInputProjectionEdges(unittest.TestCase):
    def test_inventory_rejects_invalid_authority_and_envelopes(self) -> None:
        with self.assertRaises(team.TeamRequestError):
            stored_input.list_assistant_stored_inputs("Bad")

        upstream = team.TeamResponse(503, {"secret": "must-not-project"})
        self.assertIs(stored_input._project_inventory(upstream, "team_1"), upstream)

        invalid_bodies = (
            {"team_id": "other", "stored_inputs": [], "trace_id": "a" * 32},
            {"team_id": "team_1", "stored_inputs": None, "trace_id": "a" * 32},
            {
                "team_id": "team_1",
                "stored_inputs": [
                    {"assistant_id": "whatsapp", "stored_input_id": "token", "status": "stored"},
                    {"assistant_id": "whatsapp", "stored_input_id": "token", "status": "missing"},
                ],
                "trace_id": "a" * 32,
            },
            {
                "team_id": "team_1",
                "stored_inputs": [
                    {"assistant_id": "whatsapp", "stored_input_id": "z-token", "status": "stored"},
                    {"assistant_id": "whatsapp", "stored_input_id": "a-token", "status": "stored"},
                ],
                "trace_id": "a" * 32,
            },
        )
        for body in invalid_bodies:
            with self.subTest(body=body):
                self.assertEqual(
                    stored_input._project_inventory(team.TeamResponse(200, body), "team_1").status,
                    502,
                )

    def test_clear_preserves_errors_and_rejects_malformed_success(self) -> None:
        upstream = team.TeamResponse(409, {"code": "conflict"})
        with mock.patch.object(stored_input.transport, "_call", return_value=upstream):
            self.assertIs(stored_input.clear_assistant_stored_input("team_1", "whatsapp", "token"), upstream)

        malformed = team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "assistant_id": "whatsapp",
                "stored_input_id": "token",
                "cleared": "yes",
                "trace_id": "a" * 32,
            },
        )
        with mock.patch.object(stored_input.transport, "_call", return_value=malformed):
            result = stored_input.clear_assistant_stored_input("team_1", "whatsapp", "token")
        self.assertEqual(
            result,
            team.TeamResponse(502, {"detail": "Assistant Stored Input clear response is invalid."}),
        )


class AssistantInventoryEdges(unittest.TestCase):
    def test_installed_inventory_rejects_each_closed_shape(self) -> None:
        responses = (
            object(),
            team.TeamResponse(200, {"assistants": [], "trace_id": "bad"}),
            team.TeamResponse(200, {"assistants": [], "extra": True}),
            team.TeamResponse(200, {"assistants": None}),
            team.TeamResponse(200, {"assistants": [None]}),
            team.TeamResponse(
                200,
                {
                    "assistants": [
                        {
                            "assistant": "valid",
                            "assistant_version": "invalid",
                            "provenance": "published",
                            "status": "running",
                        }
                    ]
                },
            ),
        )
        for response in responses:
            with self.subTest(response=response), self.assertRaises(ValueError):
                assistant_inventory.installed(response)

    def test_installed_inventory_retains_closed_provenance(self) -> None:
        response = team.TeamResponse(
            200,
            {
                "assistants": [
                    {
                        "assistant": "valid",
                        "assistant_version": "1.0.0",
                        "provenance": "local",
                        "status": "running",
                    }
                ]
            },
        )

        installed = assistant_inventory.installed(response)

        self.assertEqual(installed["valid"].provenance, "local")

    def test_registry_rejects_each_closed_shape_and_text(self) -> None:
        responses = (
            team.TeamResponse(200, {"assistants": None}),
            team.TeamResponse(200, {"assistants": [None]}),
            team.TeamResponse(
                200,
                {"assistants": [{"id": "valid", "title": "Title", "summary": "Summary", "actions": []}]},
            ),
        )
        for response in responses:
            with self.subTest(response=response), self.assertRaises(ValueError):
                assistant_inventory.registry(response)
        with self.assertRaises(ValueError):
            assistant_inventory._text(" invalid ", 80)


class AssistantPlanEdges(unittest.TestCase):
    def test_selection_and_empty_plan_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            assistant_plan._selected_ids(team.TeamResponse(200, {}), "team_1", frozenset())
        self.assertEqual(assistant_plan._prepared_plan("team_1", (), (), ()), assistant_plan.Preparation())

    def test_planner_preserves_safe_errors_and_normalizes_invalid_responses(self) -> None:
        candidate = _catalog_assistant("whatsapp", provider="whatsapp")
        catalog = mock.Mock()
        catalog.get.return_value = (candidate,)
        responses: tuple[object, ...] = (team.TeamResponse(409, {}), object())
        expected = (409, 502)
        for response, status in zip(responses, expected, strict=True):
            with (
                self.subTest(response=response),
                mock.patch.object(assistant_plan, "team_inventory", return_value=({}, {})),
                mock.patch.object(assistant_plan, "planning_catalog", return_value=(candidate,)),
                mock.patch.object(assistant_proposal, "capability_shortlist", return_value=(candidate,)),
                mock.patch.object(assistant_plan.local, "capability_plan", return_value=response),
            ):
                result = assistant_plan.prepare_capability(
                    "team_1",
                    {"message": "send", "assistant_ids": []},
                    catalog,
                )
            self.assertEqual(result, assistant_plan.Preparation(error_status=status))

    def test_install_and_runtime_recheck_exceptions_become_bad_gateway(self) -> None:
        candidate = _catalog_assistant("whatsapp", provider="whatsapp")
        with mock.patch.object(assistant_plan.assistant_install, "install_publication", side_effect=OSError):
            self.assertEqual(assistant_plan._install_and_prove_running("team_1", candidate), 502)
        with (
            mock.patch.object(
                assistant_plan.assistant_install,
                "install_publication",
                return_value=assistant_install.InstallResult(200, True),
            ),
            mock.patch.object(assistant_plan.team, "list_installed_assistants", side_effect=ValueError),
        ):
            self.assertEqual(assistant_plan._install_and_prove_running("team_1", candidate), 502)


class AssistantProposalEdges(unittest.TestCase):
    def test_invalid_confirmation_action_phrase_and_tied_overflow_are_closed(self) -> None:
        for value in (None, "", "x" * 161):
            self.assertEqual(assistant_proposal.classify_uninstall_confirmation(value), "ambiguous")

        self.assertEqual(
            assistant_proposal._score_fields(
                "send message",
                frozenset({"send", "message"}),
                assistant_id="unrelated",
                name="Unrelated",
                summary="Other operation",
                integrations=(),
                actions=("send-message",),
            ),
            70,
        )

        catalog = tuple(
            _catalog_assistant(f"helper-{index}", provider="shared")
            for index in range(assistant_proposal.MAX_CAPABILITY_SHORTLIST + 1)
        )
        self.assertEqual(
            assistant_proposal.capability_shortlist(
                "shared",
                catalog,
                installed_ids=frozenset(),
                enabled=(),
            ),
            (),
        )
        self.assertEqual(
            assistant_proposal.uninstall_shortlist(
                "",
                (
                    assistant_proposal.UninstallCandidate(
                        assistant_proposal.Capability("whatsapp", "WhatsApp", "", ()),
                        "1.0.0",
                    ),
                ),
            ),
            (),
        )


class AssistantUninstallEdges(unittest.TestCase):
    def test_body_validation_is_closed(self) -> None:
        responses = (
            team.TeamResponse(200, []),
            team.TeamResponse(200, {"assistant": "whatsapp", "uninstalled": True, "trace_id": "bad"}),
            team.TeamResponse(
                200,
                {
                    "assistant": "whatsapp",
                    "uninstalled": True,
                    "staged_image_retained": "bad",
                    "remove_command": "docker image rm bad",
                },
            ),
        )
        for response in responses:
            with self.subTest(response=response), self.assertRaises(ValueError):
                assistant_uninstall._uninstall_body(response, "whatsapp")


class LocalPlannerEdges(unittest.TestCase):
    def test_credential_failures_short_circuit_label_and_plan_calls(self) -> None:
        unavailable = team.TeamResponse(409, {"code": "model-credential-missing"})
        with (
            mock.patch.object(local, "_model_credential", return_value=unavailable),
            mock.patch.object(local.team, "assistant_action_labels") as labels,
            mock.patch.object(local.team, "capability_plan") as planner,
        ):
            self.assertIs(local.installed_action_labels("team_1", "whatsapp", "send"), unavailable)
            self.assertIs(local.capability_plan("team_1", "send", []), unavailable)
        labels.assert_not_called()
        planner.assert_not_called()

    def test_planner_error_is_reduced_to_a_safe_machine_code(self) -> None:
        upstream = team.TeamResponse(503, {"code": "safe-code", "secret": "must-not-cross"})
        with (
            mock.patch.object(local, "_model_credential", return_value=("openai", "secret")),
            mock.patch.object(local.team, "capability_plan", return_value=upstream),
        ):
            result = local.capability_plan("team_1", "send", [])
        self.assertEqual(result, team.TeamResponse(503, {"code": "safe-code"}))
        self.assertNotIn("secret", repr(result))


if __name__ == "__main__":
    unittest.main()
