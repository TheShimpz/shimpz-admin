"""Structured fresh-turn routing without semantic fallbacks."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


from chat import assistant_inventory, assistant_plan, assistant_proposal, assistant_route, local, store_catalog

DIGEST = "sha256:" + ("a" * 64)


def payload(message: str) -> dict[str, object]:
    return {"message": message, "files": [], "assistant_ids": []}


def response(intent: str, query: str = "", assistant_ids: list[str] | None = None) -> local.PublicResponse:
    return local.PublicResponse(
        200,
        {
            "team_id": "team_1",
            "intent": intent,
            "query": query,
            "assistant_ids": assistant_ids or [],
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
    def test_ordinary_task_runs_the_existing_capability_gate(self) -> None:
        prepared = assistant_plan.Preparation()
        with (
            mock.patch.object(assistant_route.local, "intent_route", return_value=response("ordinary-task")) as route,
            mock.patch.object(assistant_route.assistant_plan, "prepare_capability", return_value=prepared) as gate,
        ):
            result = assistant_route.prepare("team_1", payload("liste minhas zonas"), mock.sentinel.catalog, False)

        self.assertEqual(result, assistant_route.Result("ordinary-task", preparation=prepared))
        route.assert_called_once_with("team_1", "liste minhas zonas", None, [])
        gate.assert_called_once_with("team_1", payload("liste minhas zonas"), mock.sentinel.catalog, False)

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
            result = assistant_route.prepare("team_1", payload("instale o cloudflare"), mock.sentinel.catalog, False)

        self.assertEqual(result.intent, "assistant-install")
        self.assertIsNotNone(result.preparation)
        self.assertTrue(result.preparation.plan.terminal)
        self.assertEqual(
            tuple(item.assistant_id for item in result.preparation.plan.assistants),
            (assistant.assistant_id,),
        )
        self.assertEqual(route.call_count, 2)
        self.assertEqual(route.call_args_list[1].args[2], "assistant-install")

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
                guidance="assistant-install-target-required",
            ),
        )
        catalog_state.assert_not_called()

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
        self.assertEqual(
            route.call_args_list[1].args[3],
            [{"id": "shimpz-cloudflare", "name": "Shimpz Cloudflare", "summary": ""}],
        )

    def test_unresolved_or_failed_route_never_becomes_an_ordinary_task(self) -> None:
        with mock.patch.object(
            assistant_route.local,
            "intent_route",
            return_value=response("unresolved"),
        ):
            result = assistant_route.prepare("team_1", payload("faça isso"), mock.sentinel.catalog, False)
        self.assertEqual(
            result,
            assistant_route.Result("unresolved", guidance="assistant-lifecycle-ambiguous"),
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

    def test_resume_rejects_uninstall_before_opening_the_installed_directory(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
