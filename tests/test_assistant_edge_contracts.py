"""Fail-closed edge coverage for composed Assistant Admin projections."""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import transport

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
        (provider,),
        ("send-message",),
        assistant_version="1.0.0",
        creators=("@shimpz",),
    )


class StoredInputProjectionEdges(unittest.TestCase):
    def test_inventory_rejects_invalid_authority_and_envelopes(self) -> None:
        with self.assertRaises(transport.TeamRequestError):
            stored_input.list_assistant_stored_inputs("Bad")

        upstream = transport.TeamResponse(503, {"secret": "must-not-project"})
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
                    stored_input._project_inventory(transport.TeamResponse(200, body), "team_1").status,
                    502,
                )

    def test_clear_preserves_errors_and_rejects_malformed_success(self) -> None:
        upstream = transport.TeamResponse(409, {"code": "conflict"})
        with mock.patch.object(stored_input.transport, "call", return_value=upstream):
            self.assertIs(stored_input.clear_assistant_stored_input("team_1", "whatsapp", "token"), upstream)

        malformed = transport.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "assistant_id": "whatsapp",
                "stored_input_id": "token",
                "cleared": "yes",
                "trace_id": "a" * 32,
            },
        )
        with mock.patch.object(stored_input.transport, "call", return_value=malformed):
            result = stored_input.clear_assistant_stored_input("team_1", "whatsapp", "token")
        self.assertEqual(
            result,
            transport.TeamResponse(502, {"detail": "Assistant Stored Input clear response is invalid."}),
        )


class AssistantInventoryEdges(unittest.TestCase):
    def test_installed_inventory_rejects_each_closed_shape(self) -> None:
        responses = (
            object(),
            transport.TeamResponse(200, {"assistants": [], "trace_id": "bad"}),
            transport.TeamResponse(200, {"assistants": [], "extra": True}),
            transport.TeamResponse(200, {"assistants": None}),
            transport.TeamResponse(200, {"assistants": [None]}),
            transport.TeamResponse(
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
        response = transport.TeamResponse(
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

    def test_a_binding_creator_is_the_first_one_teams_exact_binding_declares(self) -> None:
        page = {
            "locale": "en",
            "assistant_id": "shimpz-cloudflare",
            "assistant_version": "1.4.0",
            "name": "Shimpz Cloudflare",
            "creators": ["@builder", "@shimpz"],
            "summary": "Publishes DNS changes safely.",
            "description": "Reviews Cloudflare zones and publishes records only after approval.",
            "links": {},
            "actions": [{"id": "list-zones", "effect": "read_only", "description": "Lists the zones."}],
            "integrations": [],
            "stored_inputs": [],
            "trace_id": "a" * 32,
        }
        with mock.patch.object(
            assistant_inventory.team, "assistant_details", return_value=transport.TeamResponse(200, page)
        ) as details:
            creator = assistant_inventory.binding_creator("team_1", "shimpz-cloudflare", "1.4.0")
        self.assertEqual(creator, "@builder")
        details.assert_called_once_with("team_1", "shimpz-cloudflare", "en")
        # Another binding, version, language, or shape than the one installed, or a Team failure, is refused.
        refused = (
            transport.TeamResponse(503, {"detail": "unavailable"}),
            transport.TeamResponse(200, ["not", "an", "object"]),
            transport.TeamResponse(200, {**page, "assistant_id": "other"}),
            transport.TeamResponse(200, {**page, "assistant_version": "1.4.1"}),
            transport.TeamResponse(200, {**page, "locale": "pt"}),
            transport.TeamResponse(200, {**page, "creators": ["builder"]}),
            mock.sentinel.not_a_response,
        )
        for response in refused:
            with (
                self.subTest(response=response),
                mock.patch.object(assistant_inventory.team, "assistant_details", return_value=response),
                self.assertRaises(ValueError),
            ):
                assistant_inventory.binding_creator("team_1", "shimpz-cloudflare", "1.4.0")

    def test_registry_admits_the_producer_action_count_and_no_more(self) -> None:
        # Developers' install protocol and Team admit up to 128 Actions per Assistant.
        def response(count: int) -> transport.TeamResponse:
            actions = [f"action-{index:03d}" for index in range(count)]
            return transport.TeamResponse(
                200,
                {"assistants": [{"id": "valid", "title": "Title", "summary": "Summary", "actions": actions}]},
            )

        self.assertEqual(len(assistant_inventory.registry(response(128))["valid"].actions), 128)
        with self.assertRaisesRegex(ValueError, "Assistant catalog identity is invalid"):
            assistant_inventory.registry(response(129))

    def test_registry_rejects_each_closed_shape_and_text(self) -> None:
        responses = (
            transport.TeamResponse(200, {"assistants": None}),
            transport.TeamResponse(200, {"assistants": [None]}),
            transport.TeamResponse(
                200,
                {"assistants": [{"id": "valid", "title": "Title", "summary": "Summary", "actions": []}]},
            ),
        )
        for response in responses:
            with self.subTest(response=response), self.assertRaises(ValueError):
                assistant_inventory.registry(response)
        with self.assertRaises(ValueError):
            store_catalog.catalog_text(" invalid ", 80)

    def test_a_teams_registry_holds_at_most_its_assistants(self) -> None:
        entry = {"title": "Title", "summary": "Summary", "actions": ["act"]}
        entries = [{"id": f"assistant-{index:02d}", **entry} for index in range(17)]
        self.assertEqual(
            len(assistant_inventory.registry(transport.TeamResponse(200, {"assistants": entries[:16]}))), 16
        )
        with self.assertRaisesRegex(ValueError, "Assistant catalog is invalid"):
            assistant_inventory.registry(transport.TeamResponse(200, {"assistants": entries}))

    def test_names_admit_each_identity_once_with_its_name_only(self) -> None:
        named = assistant_inventory.names(
            transport.TeamResponse(200, {"assistants": [{"id": "hello-pulse", "title": "Hello Pulse"}]})
        )
        self.assertEqual(named, {"hello-pulse": "Hello Pulse"})
        refused = (
            ({"assistants": None}, "Assistant names are invalid"),
            ({"assistants": [{"id": "x"}] * 129}, "Assistant names are invalid"),
            ({"assistants": [{"id": "hello-pulse", "title": "Hello", "unexpected": "S"}]}, "name fields are invalid"),
            ({"assistants": [None]}, "name fields are invalid"),
            ({"assistants": [{"id": "Hello", "title": "Hello"}]}, "canonical"),
            ({"assistants": [{"id": "hello-pulse", "title": "A"}, {"id": "hello-pulse", "title": "B"}]}, "identity"),
        )
        for body, message in refused:
            with self.subTest(body=str(body)[:60]), self.assertRaisesRegex(ValueError, message):
                assistant_inventory.names(transport.TeamResponse(200, body))


class AssistantPlanEdges(unittest.TestCase):
    def test_selection_and_empty_plan_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            assistant_plan._selected_ids(transport.TeamResponse(200, {}), "team_1", frozenset())
        self.assertEqual(assistant_plan._prepared_plan("team_1", (), (), ()), assistant_plan.Preparation())

    def test_unavailable_or_invalid_planner_installs_nothing(self) -> None:
        candidate = _catalog_assistant("whatsapp", provider="whatsapp")
        catalog = mock.Mock()
        catalog.get.return_value = (candidate,)
        responses: tuple[object, ...] = (transport.TeamResponse(409, {}), object())
        for response in responses:
            with (
                self.subTest(response=response),
                mock.patch.object(assistant_plan, "installed_inventory", return_value={}),
                mock.patch.object(assistant_plan, "planning_catalog", return_value=(candidate,)),
                mock.patch.object(assistant_proposal, "capability_candidates", return_value=((), (candidate,))),
                mock.patch.object(assistant_plan.local, "capability_plan", return_value=response),
            ):
                result = assistant_plan.prepare_capability(
                    "team_1",
                    {"message": "send", "assistant_ids": [], "locale": "en", "timezone": None, "refine": None},
                    catalog,
                )
            self.assertEqual(result, assistant_plan.Preparation())

    def test_install_and_runtime_recheck_exceptions_become_bad_gateway(self) -> None:
        candidate = _catalog_assistant("whatsapp", provider="whatsapp")
        with mock.patch.object(assistant_plan.assistant_install, "install_publication", side_effect=OSError):
            self.assertEqual(assistant_plan._install_and_prove_running("team_1", candidate), (502, None))
        with (
            mock.patch.object(
                assistant_plan.assistant_install,
                "install_publication",
                return_value=assistant_install.InstallResult(200, True),
            ),
            mock.patch.object(assistant_plan.team, "list_installed_assistants", side_effect=ValueError),
        ):
            self.assertEqual(assistant_plan._install_and_prove_running("team_1", candidate), (502, None))


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

        self.assertFalse(assistant_proposal._contains_phrase("anything", "..."))
        self.assertEqual(assistant_proposal._tokens("猫。a"), frozenset({"猫"}))

        catalog = tuple(
            _catalog_assistant(f"helper-{index}", provider="shared")
            for index in range(assistant_proposal.MAX_CAPABILITY_SHORTLIST + 1)
        )
        self.assertEqual(
            assistant_proposal.capability_candidates(
                "shared",
                catalog,
                installed_ids=frozenset(),
                enabled=(),
            ),
            ((), ()),
        )
        self.assertEqual(
            assistant_proposal.uninstall_shortlist(
                "",
                (
                    assistant_proposal.UninstallCandidate(
                        assistant_proposal.Capability("whatsapp", "WhatsApp", "", ()),
                        "1.0.0",
                        "published",
                    ),
                ),
            ),
            (),
        )


class AssistantUninstallEdges(unittest.TestCase):
    def test_body_validation_is_closed(self) -> None:
        responses = (
            transport.TeamResponse(200, []),
            transport.TeamResponse(200, {"assistant": "whatsapp", "uninstalled": True, "trace_id": "bad"}),
        )
        for response in responses:
            with self.subTest(response=response), self.assertRaises(ValueError):
                assistant_uninstall._uninstall_body(response, "whatsapp")


class LocalPlannerEdges(unittest.TestCase):
    def test_credential_failures_short_circuit_plan_calls(self) -> None:
        unavailable = transport.TeamResponse(409, {"code": "model-credential-missing"})
        with (
            mock.patch.object(local, "model_credential", return_value=unavailable),
            mock.patch.object(local.team, "capability_plan") as planner,
        ):
            self.assertIs(local.capability_plan("team_1", "send", []), unavailable)
        planner.assert_not_called()

    def test_planner_error_is_reduced_to_a_safe_machine_code(self) -> None:
        upstream = transport.TeamResponse(503, {"code": "safe-code", "secret": "must-not-cross"})
        with (
            mock.patch.object(local, "model_credential", return_value=("openai", "secret")),
            mock.patch.object(local.team, "capability_plan", return_value=upstream),
        ):
            result = local.capability_plan("team_1", "send", [])
        self.assertEqual(result, transport.TeamResponse(503, {"code": "safe-code"}))
        self.assertNotIn("secret", repr(result))


if __name__ == "__main__":
    unittest.main()
