"""Automatic composed Assistant planning and lifecycle tests."""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assistant_install, assistant_plan, store_catalog


def _candidate(
    assistant_id: str,
    name: str,
    provider: str,
    action: str,
) -> store_catalog.CatalogAssistant:
    return store_catalog.CatalogAssistant(
        assistant_id=assistant_id,
        name=name,
        summary=f"Provides reviewed {name} automation.",
        source_digest="sha256:" + (assistant_id[0] * 64),
        icon_digest="sha256:" + (assistant_id[-1] * 64),
        integrations=(store_catalog.CatalogIntegration(provider, ("messages.write",)),),
        actions=(action,),
    )


CLOUDFLARE = _candidate("cloudflare", "Cloudflare", "cloudflare", "configure-domain")
WHATSAPP = _candidate("whatsapp", "WhatsApp", "whatsapp", "send-message")
DOMAIN_HELPER = _candidate("domain-helper", "Domain Helper", "cloudflare", "inspect-domain")


def _installed(*items: tuple[str, str]):
    return assistant_plan.team.TeamResponse(
        200,
        {
            "assistants": [
                {"assistant": assistant_id, "assistant_version": "1.0.0", "status": status}
                for assistant_id, status in items
            ]
        },
    )


def _registry(*items: tuple[str, tuple[str, ...]]):
    return assistant_plan.team.TeamResponse(
        200,
        {
            "assistants": [
                {
                    "id": assistant_id,
                    "title": assistant_id.replace("-", " ").title(),
                    "summary": "Provides unrelated reviewed operations.",
                    "actions": list(actions),
                }
                for assistant_id, actions in items
            ]
        },
    )


def _payload(message: str, assistant_ids: tuple[str, ...] = ()) -> dict[str, object]:
    return {"message": message, "files": [], "assistant_ids": list(assistant_ids)}


class AssistantPlanPreparationTests(unittest.TestCase):
    def _prepare(
        self,
        message: str,
        catalog: tuple[store_catalog.CatalogAssistant, ...],
        planner: assistant_plan.team.TeamResponse,
        *,
        installed=None,
        registry=None,
        assistant_ids: tuple[str, ...] = (),
    ) -> tuple[assistant_plan.Preparation, mock.Mock]:
        store = mock.Mock()
        store.get.return_value = catalog
        with (
            mock.patch.object(
                assistant_plan.team,
                "list_installed_assistants",
                return_value=installed if installed is not None else _installed(),
            ),
            mock.patch.object(
                assistant_plan.team,
                "list_assistants",
                return_value=registry if registry is not None else _registry(),
            ),
            mock.patch.object(assistant_plan.local, "capability_plan", return_value=planner) as plan,
            mock.patch.object(assistant_plan.secrets, "token_hex", return_value="a" * 32),
        ):
            result = assistant_plan.prepare(
                "team_1",
                _payload(message, assistant_ids),
                store,
            )
        return result, plan

    def test_weak_signal_runs_directly_without_calling_the_planner(self) -> None:
        result, planner = self._prepare(
            "Olá, tudo bem?",
            (CLOUDFLARE,),
            assistant_plan.team.TeamResponse(500, {}),
        )

        self.assertEqual(result, assistant_plan.Preparation())
        planner.assert_not_called()

    def test_public_enabled_provider_suppresses_redundant_installation(self) -> None:
        enabled = _candidate("enabled", "Installed Helper", "cloudflare", "inspect-resource")
        result, planner = self._prepare(
            "Use Cloudflare",
            (DOMAIN_HELPER, enabled),
            assistant_plan.team.TeamResponse(500, {}),
            installed=_installed(("enabled", "running")),
            registry=_registry(("enabled", ("inspect-resource",))),
            assistant_ids=("enabled",),
        )

        self.assertEqual(result, assistant_plan.Preparation())
        planner.assert_not_called()

    def test_composed_selection_is_an_exact_sorted_subset_and_dispatch_union(self) -> None:
        objective = "Configure meu domínio Cloudflare e envie uma mensagem no WhatsApp"
        result, planner = self._prepare(
            objective,
            (CLOUDFLARE, WHATSAPP),
            assistant_plan.team.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "status": "install-required",
                    "assistant_ids": ["cloudflare", "whatsapp"],
                },
            ),
        )

        self.assertIsNotNone(result.plan)
        assert result.plan is not None
        self.assertEqual(result.plan.plan_id, "a" * 32)
        self.assertEqual(
            tuple(item.assistant_id for item in result.plan.assistants),
            ("cloudflare", "whatsapp"),
        )
        self.assertEqual(result.plan.dispatch_ids, ("cloudflare", "whatsapp"))
        request = planner.call_args.args
        self.assertEqual(request[:2], ("team_1", objective))
        self.assertEqual([item["id"] for item in request[2]], ["cloudflare", "whatsapp"])
        self.assertNotIn("source_digest", repr(request[2]))

    def test_nonrunning_explicit_scope_never_reaches_the_planner(self) -> None:
        result, planner = self._prepare(
            "Configure Cloudflare",
            (CLOUDFLARE,),
            assistant_plan.team.TeamResponse(500, {}),
            installed=_installed(("enabled", "stopped")),
            registry=_registry(("enabled", ("other-action",))),
            assistant_ids=("enabled",),
        )

        self.assertEqual(result, assistant_plan.Preparation())
        planner.assert_not_called()

    def test_unknown_duplicate_or_inconsistent_planner_selection_fails_closed(self) -> None:
        bodies = (
            {"team_id": "team_1", "status": "install-required", "assistant_ids": ["unknown"]},
            {
                "team_id": "team_1",
                "status": "install-required",
                "assistant_ids": ["cloudflare", "cloudflare"],
            },
            {"team_id": "team_1", "status": "sufficient", "assistant_ids": ["cloudflare"]},
        )
        for body in bodies:
            with self.subTest(body=body):
                result, _planner = self._prepare(
                    "Configure Cloudflare",
                    (CLOUDFLARE,),
                    assistant_plan.team.TeamResponse(200, body),
                )
                self.assertEqual(result, assistant_plan.Preparation(error_status=502))

    def test_scope_overflow_fails_before_any_installation(self) -> None:
        enabled_ids = tuple(f"enabled-{index}" for index in range(15))
        result, _planner = self._prepare(
            "Configure Cloudflare e envie WhatsApp",
            (CLOUDFLARE, WHATSAPP),
            assistant_plan.team.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "status": "install-required",
                    "assistant_ids": ["cloudflare", "whatsapp"],
                },
            ),
            installed=_installed(*((assistant_id, "running") for assistant_id in enabled_ids)),
            registry=_registry(*((assistant_id, ("unrelated",)) for assistant_id in enabled_ids)),
            assistant_ids=enabled_ids,
        )

        self.assertEqual(result, assistant_plan.Preparation(error_status=409))


class AssistantPlanExecutionTests(unittest.TestCase):
    def _plan(self, *assistants: store_catalog.CatalogAssistant) -> assistant_plan.Plan:
        ids = tuple(item.assistant_id for item in assistants)
        return assistant_plan.Plan("b" * 32, "team_1", assistants, ids)

    def test_installs_sequentially_and_rechecks_running_inventory_after_each_item(self) -> None:
        progress = []
        with (
            mock.patch.object(
                assistant_plan.assistant_install,
                "install_publication",
                side_effect=(
                    assistant_install.InstallResult(200, True),
                    assistant_install.InstallResult(200, True),
                ),
            ) as install,
            mock.patch.object(
                assistant_plan.team,
                "list_installed_assistants",
                side_effect=(
                    _installed(("cloudflare", "running")),
                    _installed(("cloudflare", "running"), ("whatsapp", "running")),
                ),
            ) as inventory,
        ):
            result = assistant_plan.execute(
                self._plan(CLOUDFLARE, WHATSAPP),
                threading.Event(),
                progress.append,
            )

        self.assertEqual(result.state, "installed")
        self.assertEqual([item["status"] for item in result.assistants], ["installed", "installed"])
        self.assertEqual(
            [call.args[1].assistant_id for call in install.call_args_list],
            ["cloudflare", "whatsapp"],
        )
        self.assertEqual(inventory.call_count, 2)
        self.assertEqual(
            [[item["status"] for item in update] for update in progress],
            [
                ["installing", "pending"],
                ["installed", "pending"],
                ["installed", "installing"],
                ["installed", "installed"],
            ],
        )

    def test_partial_failure_keeps_success_and_never_starts_remaining_items(self) -> None:
        third = _candidate("later", "Later", "later", "later-action")
        with (
            mock.patch.object(
                assistant_plan.assistant_install,
                "install_publication",
                side_effect=(
                    assistant_install.InstallResult(200, True),
                    assistant_install.InstallResult(503),
                ),
            ) as install,
            mock.patch.object(
                assistant_plan.team,
                "list_installed_assistants",
                return_value=_installed(("cloudflare", "running")),
            ),
        ):
            result = assistant_plan.execute(
                self._plan(CLOUDFLARE, WHATSAPP, third),
                threading.Event(),
                lambda _items: None,
            )

        self.assertEqual(result.state, "failed")
        self.assertEqual(result.status, 503)
        self.assertEqual(
            [item["status"] for item in result.assistants],
            ["installed", "failed", "pending"],
        )
        self.assertEqual(install.call_count, 2)

    def test_stop_is_cooperative_between_items(self) -> None:
        stopped = threading.Event()

        def progress(items) -> None:
            if items[0]["status"] == "installed":
                stopped.set()

        with (
            mock.patch.object(
                assistant_plan.assistant_install,
                "install_publication",
                return_value=assistant_install.InstallResult(200, True),
            ) as install,
            mock.patch.object(
                assistant_plan.team,
                "list_installed_assistants",
                return_value=_installed(("cloudflare", "running")),
            ),
        ):
            result = assistant_plan.execute(
                self._plan(CLOUDFLARE, WHATSAPP),
                stopped,
                progress,
            )

        self.assertEqual(result.state, "stopped")
        self.assertEqual([item["status"] for item in result.assistants], ["installed", "pending"])
        install.assert_called_once_with("team_1", CLOUDFLARE)

    def test_install_success_without_fresh_running_inventory_fails_closed(self) -> None:
        with (
            mock.patch.object(
                assistant_plan.assistant_install,
                "install_publication",
                return_value=assistant_install.InstallResult(200, True),
            ),
            mock.patch.object(
                assistant_plan.team,
                "list_installed_assistants",
                return_value=_installed(("cloudflare", "stopped")),
            ),
        ):
            result = assistant_plan.execute(
                self._plan(CLOUDFLARE),
                threading.Event(),
                lambda _items: None,
            )

        self.assertEqual(result.state, "failed")
        self.assertEqual(result.status, 502)

    def test_team_request_exception_marks_the_current_item_failed(self) -> None:
        with mock.patch.object(
            assistant_plan.assistant_install,
            "install_publication",
            side_effect=assistant_plan.team.TeamRequestError("private failure"),
        ):
            result = assistant_plan.execute(
                self._plan(CLOUDFLARE, WHATSAPP),
                threading.Event(),
                lambda _items: None,
            )

        self.assertEqual(result.state, "failed")
        self.assertEqual(result.status, 502)
        self.assertEqual([item["status"] for item in result.assistants], ["failed", "pending"])

    def test_public_event_omits_objective_and_publication_authority(self) -> None:
        plan = self._plan(CLOUDFLARE)
        event = assistant_plan.event(plan, "planned", assistant_plan.initial_items(plan))

        self.assertEqual(set(event), {"type", "state", "plan_id", "team_id", "assistants"})
        self.assertNotIn("digest", repr(event))
        self.assertNotIn("objective", repr(event))


if __name__ == "__main__":
    unittest.main()
