"""Structured fresh-turn routing without semantic fallbacks."""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


from history import context as conversation_context

from chat import (
    assistant_inventory,
    assistant_plan,
    assistant_proposal,
    assistant_route,
    local,
    store_catalog,
)

DIGEST = "sha256:" + ("a" * 64)


def payload(message: str) -> dict[str, object]:
    return {"message": message, "files": [], "assistant_ids": []}


def response(
    intent: str,
    query: str = "",
    assistant_ids: list[str] | None = None,
    reply: str | None = None,
) -> local.PublicResponse:
    if reply is None:
        reply = (
            "Qual Assistant você quer usar?"
            if intent == "unresolved" or ("assistant-" in intent and not query and not assistant_ids)
            else ""
        )
    return local.PublicResponse(
        200,
        {
            "task_follows": False,
            "team_id": "team_1",
            "intent": intent,
            "query": query,
            "assistant_ids": assistant_ids or [],
            "reply": reply,
        },
    )


def cloudflare() -> store_catalog.CatalogAssistant:
    return store_catalog.CatalogAssistant(
        "shimpz-cloudflare",
        "Shimpz Cloudflare",
        "Manage reviewed Cloudflare zones and DNS records.",
        DIGEST,
        DIGEST,
        (),
        ("list-zones",),
    )


class AssistantRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        speculative = mock.patch.object(
            assistant_route.assistant_plan,
            "prepare_capability",
            return_value=assistant_plan.Preparation(),
        )
        speculative.start()
        self.addCleanup(speculative.stop)

    def test_guidance_accepts_unicode_spacing_but_rejects_layout_separators(self) -> None:
        reply = "Quel Assistant voulez-vous désinstaller\u00a0?"
        with mock.patch.object(
            assistant_route.local,
            "intent_route",
            return_value=response("assistant-uninstall", reply=reply),
        ):
            routed = assistant_route._route("team_1", "désinstalle", None, [])
        self.assertEqual(routed.reply, reply)

        for separator in ("\u2028", "\u2029"):
            with (
                self.subTest(separator=separator),
                mock.patch.object(
                    assistant_route.local,
                    "intent_route",
                    return_value=response("assistant-uninstall", reply=f"Question{separator}suivante"),
                ),
                self.assertRaises(assistant_route.RouteError),
            ):
                assistant_route._route("team_1", "désinstalle", None, [])

    def test_route_rejects_invalid_structured_responses(self) -> None:
        invalid = (
            local.PublicResponse(200, {"team_id": "team_1"}),
            local.PublicResponse(
                200,
                {
                    "team_id": "team_2",
                    "intent": "ordinary-task",
                    "query": "",
                    "assistant_ids": [],
                },
            ),
        )
        for routed in invalid:
            with (
                self.subTest(routed=routed),
                mock.patch.object(assistant_route.local, "intent_route", return_value=routed),
                self.assertRaises(assistant_route.RouteError),
            ):
                assistant_route.prepare("team_1", payload("hello"), mock.sentinel.catalog, False)

        def with_continuation(routed: local.PublicResponse, value: object) -> local.PublicResponse:
            return local.PublicResponse(routed.status, {**routed.body, "task_follows": value})

        continuing = with_continuation(response("assistant-install", "exa"), True)
        with mock.patch.object(assistant_route.local, "intent_route", return_value=continuing):
            self.assertTrue(assistant_route._route("team_1", "instala o exa e pesquisa", None, []).task_follows)
        selected = with_continuation(response("assistant-install", assistant_ids=["shimpz-exa"]), True)
        non_boolean = with_continuation(response("assistant-install", "exa"), 1)
        invalid_reply_rules = (
            (None, response("ordinary-task", reply="Unexpected guidance")),
            ("assistant-uninstall", response("unresolved", reply="")),
            ("assistant-install", selected),
            (None, non_boolean),
        )
        for expected_intent, routed in invalid_reply_rules:
            with (
                self.subTest(expected_intent=expected_intent),
                mock.patch.object(assistant_route.local, "intent_route", return_value=routed),
                self.assertRaises(assistant_route.RouteError),
            ):
                assistant_route._route("team_1", "hello", expected_intent, [])

    def test_catalog_state_reads_inventory_and_directory_concurrently(self) -> None:
        installed = {"cloudflare": mock.sentinel.installed}
        available = (cloudflare(),)
        both_started = threading.Barrier(2)

        def inventory(_team_id):
            both_started.wait(timeout=5)
            return installed

        def directory(_catalog, _include_local):
            both_started.wait(timeout=5)
            return available

        with (
            mock.patch.object(assistant_route.assistant_plan, "installed_inventory", side_effect=inventory),
            mock.patch.object(assistant_route.assistant_plan, "planning_catalog", side_effect=directory),
        ):
            self.assertEqual(
                assistant_route._catalog_state("team_1", mock.sentinel.catalog, True),
                (installed, available),
            )

    def test_install_directory_does_not_read_the_unused_global_registry(self) -> None:
        assistant = cloudflare()
        catalog = mock.Mock()
        catalog.get.return_value = (assistant,)
        with (
            mock.patch.object(
                assistant_plan.team,
                "list_installed_assistants",
                return_value=assistant_plan.team.TeamResponse(200, {"assistants": []}),
            ) as installed,
            mock.patch.object(assistant_plan.team, "list_assistants") as registry,
        ):
            result = assistant_route._catalog_state("team_1", catalog, False)

        self.assertEqual(result, ({}, (assistant,)))
        installed.assert_called_once_with("team_1")
        registry.assert_not_called()

    def test_ordinary_task_uses_the_capability_plan(self) -> None:
        prepared = assistant_plan.Preparation()
        with (
            mock.patch.object(assistant_route.local, "intent_route", return_value=response("ordinary-task")) as route,
            mock.patch.object(assistant_route.assistant_plan, "prepare_capability", return_value=prepared) as gate,
        ):
            result = assistant_route.prepare("team_1", payload("liste minhas zonas"), mock.sentinel.catalog, False)

        self.assertEqual(result, assistant_route.Result("ordinary-task", preparation=prepared))
        route.assert_called_once_with(
            "team_1",
            "liste minhas zonas",
            None,
            [],
            local.IntentRouteContext(),
        )
        gate.assert_called_once_with("team_1", payload("liste minhas zonas"), mock.sentinel.catalog, False)

    def test_capability_planning_overlaps_classification(self) -> None:
        planning_started = threading.Event()
        prepared = assistant_plan.Preparation(error_status=409)

        def plan(*_args):
            planning_started.set()
            return prepared

        def classify(*_args):
            self.assertTrue(planning_started.wait(2), "capability planning did not start beside classification")
            return response("ordinary-task")

        with (
            mock.patch.object(assistant_route.local, "intent_route", side_effect=classify),
            mock.patch.object(assistant_route.assistant_plan, "prepare_capability", side_effect=plan),
        ):
            result = assistant_route.prepare("team_1", payload("pesquise na web"), mock.sentinel.catalog, True)

        self.assertEqual(result, assistant_route.Result("ordinary-task", preparation=prepared))

    def test_lifecycle_route_discards_the_speculative_capability_plan(self) -> None:
        speculative = assistant_plan.Preparation(error_status=409)
        with (
            mock.patch.object(assistant_route.local, "intent_route", return_value=response("unresolved")),
            mock.patch.object(assistant_route.assistant_plan, "prepare_capability", return_value=speculative),
        ):
            result = assistant_route.prepare("team_1", payload("faça isso"), mock.sentinel.catalog, False)

        self.assertEqual(result.intent, "unresolved")
        self.assertIsNone(result.preparation)

    def test_saturated_capability_planning_falls_back_to_serial(self) -> None:
        prepared = assistant_plan.Preparation()
        with (
            mock.patch.object(
                assistant_route._CAPABILITY_PLANNING,
                "submit",
                side_effect=assistant_route.ExecutorSaturatedError("full"),
            ),
            mock.patch.object(assistant_route.local, "intent_route", return_value=response("ordinary-task")),
            mock.patch.object(assistant_route.assistant_plan, "prepare_capability", return_value=prepared) as gate,
        ):
            result = assistant_route.prepare("team_1", payload("liste minhas zonas"), mock.sentinel.catalog, False)

        self.assertEqual(result, assistant_route.Result("ordinary-task", preparation=prepared))
        gate.assert_called_once_with("team_1", payload("liste minhas zonas"), mock.sentinel.catalog, False)

    def test_saturated_planning_is_skipped_for_lifecycle_or_failed_routes(self) -> None:
        saturated = mock.patch.object(
            assistant_route._CAPABILITY_PLANNING,
            "submit",
            side_effect=assistant_route.ExecutorSaturatedError("full"),
        )
        with (
            saturated,
            mock.patch.object(assistant_route.local, "intent_route", return_value=response("unresolved")),
            mock.patch.object(assistant_route.assistant_plan, "prepare_capability") as gate,
        ):
            result = assistant_route.prepare("team_1", payload("faça isso"), mock.sentinel.catalog, False)
        self.assertEqual(result.intent, "unresolved")
        gate.assert_not_called()

        with (
            saturated,
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                return_value=local.PublicResponse(503, {"code": "intent-route-unavailable"}),
            ),
            mock.patch.object(assistant_route.assistant_plan, "prepare_capability") as gate,
            self.assertRaises(assistant_route.RouteError),
        ):
            assistant_route.prepare("team_1", payload("hello"), mock.sentinel.catalog, False)
        gate.assert_not_called()

    def test_install_opens_only_the_catalog_directory_and_is_terminal(self) -> None:
        assistant = cloudflare()
        installed: dict[str, assistant_inventory.InstalledAssistant] = {}
        with (
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                side_effect=(
                    response("assistant-install", "cloudflare"),
                    response("assistant-install", assistant_ids=[assistant.assistant_id]),
                ),
            ) as route,
            mock.patch.object(
                assistant_route,
                "_catalog_state",
                return_value=(installed, (assistant,)),
            ),
        ):
            reference = assistant_proposal.AssistantReference("prior-assistant", "Prior Assistant")
            result = assistant_route.prepare(
                "team_1",
                payload("instale o cloudflare"),
                mock.sentinel.catalog,
                False,
                assistant_route.Context(reference=reference),
            )

        self.assertEqual(result.intent, "assistant-install")
        self.assertIsNotNone(result.preparation)
        self.assertTrue(result.preparation.plan.terminal)
        self.assertEqual(
            tuple(item.assistant_id for item in result.preparation.plan.assistants),
            (assistant.assistant_id,),
        )
        self.assertEqual(result.preparation.plan.lifecycle_ids, (assistant.assistant_id,))
        self.assertEqual(route.call_count, 2)
        self.assertIs(route.call_args_list[0].args[4].reference, reference)
        self.assertEqual(route.call_args_list[1].args[1], "cloudflare")
        self.assertEqual(route.call_args_list[1].args[2], "assistant-install")
        self.assertEqual(
            route.call_args_list[1].args[4],
            local.IntentRouteContext(language_exemplar="instale o cloudflare"),
        )

    def test_repeated_install_returns_the_current_state_without_install_work(self) -> None:
        assistant = cloudflare()
        installed = {
            assistant.assistant_id: assistant_inventory.InstalledAssistant(
                assistant.assistant_id,
                "0.4.5",
                "local",
                "running",
            )
        }
        with (
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                side_effect=(
                    response("assistant-install", "cloudflare"),
                    response("assistant-install", assistant_ids=[assistant.assistant_id]),
                ),
            ),
            mock.patch.object(assistant_route, "_catalog_state", return_value=(installed, (assistant,))),
        ):
            result = assistant_route.prepare("team_1", payload("instale o cloudflare"), mock.sentinel.catalog, False)

        self.assertIsNone(result.preparation.plan)
        self.assertEqual(result.preparation.already_installed.assistants[0]["status"], "installed")

    def test_install_without_a_resolved_target_returns_guidance(self) -> None:
        with (
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                return_value=response("assistant-install"),
            ),
            mock.patch.object(assistant_route, "_catalog_state") as catalog_state,
        ):
            result = assistant_route.prepare(
                "team_1",
                payload("instale um Assistant"),
                mock.sentinel.catalog,
                False,
            )

        self.assertEqual(
            result,
            assistant_route.Result(
                "assistant-install",
                guidance=assistant_route.Guidance(
                    "assistant-install-target-required",
                    "Qual Assistant você quer usar?",
                ),
            ),
        )
        catalog_state.assert_not_called()

    def test_install_unknown_or_unresolved_target_returns_guidance(self) -> None:
        assistant = cloudflare()
        cases = (
            ("unknown", response("unresolved")),
            ("cloudflare", response("unresolved")),
        )
        for query, selection in cases:
            with (
                self.subTest(query=query),
                mock.patch.object(
                    assistant_route.local,
                    "intent_route",
                    side_effect=(response("assistant-install", query), selection),
                ),
                mock.patch.object(assistant_route, "_catalog_state", return_value=({}, (assistant,))),
            ):
                result = assistant_route.prepare(
                    "team_1",
                    payload(f"instale {query}"),
                    mock.sentinel.catalog,
                    False,
                )
            self.assertEqual(result.guidance.code, "assistant-install-target-required")

    def test_uninstall_opens_only_the_installed_name_directory(self) -> None:
        candidate = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability(
                "shimpz-cloudflare",
                "Shimpz Cloudflare",
                "must not cross",
                ("must-not-cross",),
            ),
            "0.4.5",
        )
        with (
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                side_effect=(
                    response("assistant-uninstall", "cloudflare"),
                    response("assistant-uninstall", assistant_ids=[candidate.assistant.assistant_id]),
                ),
            ) as route,
            mock.patch.object(assistant_route.assistant_uninstall, "candidates", return_value=(candidate,)),
        ):
            result = assistant_route.prepare("team_1", payload("retire o cloudflare"), mock.sentinel.catalog, False)

        self.assertEqual(result.uninstall, candidate)
        self.assertEqual(route.call_args_list[1].args[1], "cloudflare")
        self.assertEqual(
            route.call_args_list[1].args[3],
            [{"id": "shimpz-cloudflare", "name": "Shimpz Cloudflare", "summary": ""}],
        )

    def test_conversation_reference_stays_in_the_specialized_route(self) -> None:
        candidate = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability("shimpz-cloudflare", "Shimpz Cloudflare", "", ()),
            "0.4.5",
        )
        context = assistant_route.Context(
            conversation=(
                conversation_context.Entry("user", "quais temos?", False),
                conversation_context.Entry("assistant", "Temos apenas Cloudflare/DNS.", False),
            ),
            selection_language_exemplar="quais temos?",
        )
        with (
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                side_effect=(
                    response("assistant-uninstall", "cloudflare"),
                    response("assistant-uninstall", assistant_ids=["shimpz-cloudflare"]),
                ),
            ) as route,
            mock.patch.object(assistant_route.assistant_uninstall, "candidates", return_value=(candidate,)),
        ):
            result = assistant_route.prepare(
                "team_1",
                payload("desinstala esse então"),
                mock.sentinel.catalog,
                False,
                context,
            )

        self.assertEqual(result.uninstall, candidate)
        self.assertEqual(route.call_args_list[0].args[1], "desinstala esse então")
        self.assertEqual(route.call_args_list[0].args[4].conversation, context.conversation)
        self.assertIsNone(route.call_args_list[0].args[4].language_exemplar)
        self.assertEqual(route.call_args_list[1].args[1], "cloudflare")
        self.assertNotEqual(route.call_args_list[1].args[1], "desinstala esse então")
        self.assertEqual(route.call_args_list[1].args[4].conversation, ())
        self.assertEqual(route.call_args_list[1].args[4].language_exemplar, "quais temos?")

    def test_uninstall_missing_unknown_or_unresolved_target_returns_guidance(self) -> None:
        candidate = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability("shimpz-cloudflare", "Shimpz Cloudflare", "", ()),
            "0.4.5",
        )
        cases = (
            (response("assistant-uninstall"), (candidate,), None),
            (response("assistant-uninstall", "unknown"), (candidate,), response("unresolved")),
            (response("assistant-uninstall", "cloudflare"), (candidate,), response("unresolved")),
        )
        for initial, candidates, selection in cases:
            route = (
                mock.patch.object(assistant_route.local, "intent_route", return_value=initial)
                if selection is None
                else mock.patch.object(
                    assistant_route.local,
                    "intent_route",
                    side_effect=(initial, selection),
                )
            )
            with (
                self.subTest(initial=initial),
                route,
                mock.patch.object(assistant_route.assistant_uninstall, "candidates", return_value=candidates),
            ):
                result = assistant_route.prepare(
                    "team_1",
                    payload("desinstale"),
                    mock.sentinel.catalog,
                    False,
                )
            self.assertEqual(result.guidance.code, "assistant-uninstall-target-required")

    def test_uninstall_selection_must_resolve_to_exactly_one_current_candidate(self) -> None:
        candidate = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability("shimpz-cloudflare", "Shimpz Cloudflare", "", ()),
            "0.4.5",
        )
        with (
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                side_effect=(
                    response("assistant-uninstall", "cloudflare"),
                    response("assistant-uninstall", assistant_ids=["different"]),
                ),
            ),
            mock.patch.object(assistant_route.assistant_uninstall, "candidates", return_value=(candidate,)),
            self.assertRaises(assistant_route.RouteError),
        ):
            assistant_route.prepare("team_1", payload("desinstale cloudflare"), mock.sentinel.catalog, False)

    def test_lifecycle_request_with_files_is_rejected_before_directories_open(self) -> None:
        attached = payload("instale o cloudflare")
        attached["files"] = ["a" * 32]
        with mock.patch.object(
            assistant_route.local,
            "intent_route",
            return_value=response("assistant-install", "cloudflare"),
        ):
            result = assistant_route.prepare("team_1", attached, mock.sentinel.catalog, False)
        self.assertEqual(result, assistant_route.Result("unresolved", error_status=422))

    def test_unresolved_or_failed_route_never_becomes_an_ordinary_task(self) -> None:
        with mock.patch.object(
            assistant_route.local,
            "intent_route",
            return_value=response("unresolved"),
        ):
            result = assistant_route.prepare("team_1", payload("faça isso"), mock.sentinel.catalog, False)
        self.assertEqual(
            result,
            assistant_route.Result(
                "unresolved",
                guidance=assistant_route.Guidance(
                    "assistant-lifecycle-ambiguous",
                    "Qual Assistant você quer usar?",
                ),
            ),
        )

        with (
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                return_value=local.PublicResponse(503, {"code": "intent-route-unavailable"}),
            ),
            self.assertRaisesRegex(assistant_route.RouteError, "structured Assistant routing failed"),
        ):
            assistant_route.prepare("team_1", payload("hello"), mock.sentinel.catalog, False)

    def test_resume_rejects_uninstall_and_preserves_install_language(self) -> None:
        with (
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                return_value=response("assistant-uninstall", "cloudflare"),
            ),
            mock.patch.object(assistant_route.assistant_uninstall, "candidates") as directory,
        ):
            result = assistant_route.prepare_resume(
                "team_1",
                payload("desinstale o cloudflare"),
                mock.sentinel.catalog,
                False,
            )

        self.assertEqual(result, assistant_route.Result("unresolved", error_status=422))
        directory.assert_not_called()

        long_install_message = "Instale o Cloudflare " + ("agora " * 400)
        with (
            mock.patch.object(
                assistant_route.local,
                "intent_route",
                side_effect=(
                    response("assistant-install", "cloudflare"),
                    response("unresolved"),
                ),
            ) as route,
            mock.patch.object(assistant_route, "_catalog_state", return_value=({}, (cloudflare(),))),
        ):
            result = assistant_route.prepare_resume(
                "team_1",
                payload(long_install_message),
                mock.sentinel.catalog,
                False,
            )

        self.assertEqual(result.guidance.code, "assistant-install-target-required")
        self.assertEqual(route.call_args_list[1].args[1], "cloudflare")
        self.assertEqual(
            route.call_args_list[1].args[4],
            local.IntentRouteContext(
                language_exemplar=assistant_route.team_contract.canonical_language_exemplar(
                    long_install_message[: assistant_route.team_contract.MAX_LANGUAGE_EXEMPLAR_CHARS]
                )
            ),
        )


if __name__ == "__main__":
    unittest.main()
