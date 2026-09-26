"""Pure matching and authority tests for conversational Assistant installation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assistant_proposal, local, store_catalog

DIGEST = "sha256:" + ("a" * 64)


def _candidate(
    assistant_id: str = "shimpz-cloudflare",
    *,
    name: str = "Shimpz Cloudflare",
    summary: str = "Manages reviewed Cloudflare zones and DNS records.",
    provider: str = "cloudflare",
    actions: tuple[str, ...] = ("list-zones", "list-dns-records"),
) -> store_catalog.CatalogAssistant:
    integrations = () if not provider else (store_catalog.CatalogIntegration(provider, ("zone.read",)),)
    return store_catalog.CatalogAssistant(assistant_id, name, summary, DIGEST, DIGEST, integrations, actions)


class AssistantProposalTests(unittest.TestCase):
    def test_reference_projection_accepts_only_an_exact_string_identity(self) -> None:
        self.assertIsNone(assistant_proposal.reference_from_item(None))
        self.assertIsNone(assistant_proposal.reference_from_item({"id": "cloudflare"}))
        self.assertEqual(
            assistant_proposal.reference_from_item({"id": "cloudflare", "name": "Cloudflare"}),
            assistant_proposal.AssistantReference("cloudflare", "Cloudflare"),
        )

    def test_install_directory_orders_every_candidate_for_intent_selection(self) -> None:
        cloudflare = _candidate()
        whatsapp = _candidate("whatsapp", name="WhatsApp", provider="whatsapp")
        self.assertEqual(
            assistant_proposal.install_shortlist("cloudflare", (whatsapp, cloudflare)),
            (cloudflare, whatsapp),
        )
        self.assertEqual(
            assistant_proposal.install_shortlist("algo pra mandar mensagens", (whatsapp, cloudflare)),
            (cloudflare, whatsapp),
        )
        self.assertEqual(assistant_proposal.install_shortlist("...", (cloudflare,)), ())
        self.assertEqual(
            assistant_proposal.install_shortlist("Shimpz Cloudflare", (whatsapp, cloudflare)),
            (cloudflare, whatsapp),
        )

    def test_lexically_ranked_directories_satisfy_the_team_selection_contract(self) -> None:
        exa = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability("shimpz-exa", "Exa", "Search the web.", ("search-web",)), "0.1.1"
        )
        cloudflare = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability("shimpz-cloudflare", "Shimpz Cloudflare", "Manage DNS.", ("list-zones",)),
            "0.4.1",
        )
        uninstall = assistant_proposal.uninstall_shortlist("desinstala o exa", (exa, cloudflare))
        directory = [
            {"id": item.assistant.assistant_id, "name": item.assistant.name, "summary": ""} for item in uninstall
        ]
        self.assertEqual(
            local._intent_route_directory("assistant-uninstall", directory)[2],
            ["shimpz-cloudflare", "shimpz-exa"],
        )
        install = assistant_proposal.install_shortlist(
            "instala o whatsapp", (_candidate(), _candidate("whatsapp", name="WhatsApp", provider="whatsapp"))
        )
        directory = [{"id": item.assistant_id, "name": item.name, "summary": item.summary} for item in install]
        self.assertEqual(
            local._intent_route_directory("assistant-install", directory)[2],
            sorted(item.assistant_id for item in install),
        )

    def test_install_directory_is_bounded_and_never_displaces_a_cutoff_tie(self) -> None:
        cloudflares = tuple(
            _candidate(
                f"cloudflare-{index}",
                name=f"Cloudflare {index}",
                summary="Provides reviewed Cloudflare automation.",
            )
            for index in range(assistant_proposal.MAX_CAPABILITY_SHORTLIST)
        )
        whatsapp = _candidate("whatsapp", name="WhatsApp", provider="whatsapp")

        self.assertEqual(assistant_proposal.install_shortlist("cloudflare", (whatsapp, *cloudflares)), cloudflares)
        tied = (*cloudflares, _candidate("cloudflare-x", name="Cloudflare X"))
        self.assertEqual(assistant_proposal.install_shortlist("cloudflare", tied), ())

    def test_capability_continuation_is_a_closed_whole_message_classifier(self) -> None:
        accepted = (
            "Você mesmo consegue habilitar?",
            "pode instalar",
            "Can you enable it!",
        )
        rejected = (
            "como faço para habilitar o modo escuro",
            "pode instalar o malware também",
            "sim",
            "",
        )
        for message in accepted:
            with self.subTest(message=message):
                self.assertTrue(assistant_proposal.capability_continuation(message))
        for message in rejected:
            with self.subTest(message=message):
                self.assertFalse(assistant_proposal.capability_continuation(message))

        self.assertEqual(
            assistant_proposal.classify_uninstall_confirmation("pode instalar"),
            "ambiguous",
        )
        self.assertFalse(assistant_proposal.capability_continuation("agora pode instalar"))

    def test_intent_candidates_do_not_require_shared_keywords(self) -> None:
        exa = _candidate(
            "shimpz-exa",
            name="Exa",
            summary="Official Shimpz integration for Exa: search the web and read pages.",
            provider="",
            actions=("read-pages", "search-web"),
        )
        cloudflare = _candidate()

        self.assertEqual(
            assistant_proposal.capability_candidates(
                "quero fazer websearch, pesquisa pra mim as noticias de IA mais hypadas da semana",
                (exa, cloudflare),
                installed_ids=frozenset(),
                enabled=(),
            ),
            ((), (cloudflare, exa)),
        )

    def test_enabled_capabilities_accompany_installable_candidates(self) -> None:
        cloudflare = _candidate()
        whatsapp = _candidate(
            "whatsapp",
            name="WhatsApp",
            summary="Sends reviewed WhatsApp messages.",
            provider="whatsapp",
            actions=("send-message",),
        )
        enabled = assistant_proposal.Capability(
            cloudflare.assistant_id, cloudflare.name, cloudflare.summary, cloudflare.actions, ("cloudflare",)
        )

        self.assertEqual(
            assistant_proposal.capability_candidates(
                "Configure Cloudflare e envie uma mensagem no WhatsApp",
                (cloudflare, whatsapp),
                installed_ids=frozenset({cloudflare.assistant_id}),
                enabled=(enabled,),
            ),
            ((enabled,), (whatsapp,)),
        )

    def test_no_installable_candidate_or_search_text_means_no_planning(self) -> None:
        cloudflare = _candidate()
        enabled = assistant_proposal.Capability(cloudflare.assistant_id, cloudflare.name, cloudflare.summary, ())
        cases = (
            ("Cloudflare zones", frozenset({cloudflare.assistant_id}), (enabled,)),
            ("...", frozenset(), ()),
            ("", frozenset(), ()),
        )
        for message, installed, current in cases:
            with self.subTest(message=message):
                self.assertEqual(
                    assistant_proposal.capability_candidates(
                        message,
                        (cloudflare,),
                        installed_ids=installed,
                        enabled=current,
                    ),
                    ((), ()),
                )

    def test_overflowing_pool_keeps_the_strongest_signals_within_the_bound(self) -> None:
        senders = tuple(
            _candidate(
                f"sender-{index}",
                name=f"Sender {index}",
                summary="Send WhatsApp messages.",
                provider="",
                actions=("send-message",),
            )
            for index in range(assistant_proposal.MAX_CAPABILITY_SHORTLIST - 1)
        )
        whatsapp = _candidate("whatsapp", name="WhatsApp", provider="whatsapp", actions=("send-message",))
        unrelated = _candidate("helper", name="Helper", summary="Reviewed helper.", provider="", actions=("run",))
        enabled = assistant_proposal.Capability("enabled", "Enabled", "Unrelated operations.", ("inspect",))

        kept_enabled, kept = assistant_proposal.capability_candidates(
            "send a WhatsApp message",
            (*senders, whatsapp, unrelated),
            installed_ids=frozenset({enabled.assistant_id}),
            enabled=(enabled,),
        )

        self.assertEqual(kept_enabled, ())
        self.assertEqual(kept, (*senders, whatsapp))

    def test_installable_cutoff_tie_means_no_planning_and_enabled_fills_the_rest(self) -> None:
        helpers = tuple(
            _candidate(f"helper-{index}", name=f"Helper {index}", summary="Reviewed helper.", provider="")
            for index in range(assistant_proposal.MAX_CAPABILITY_SHORTLIST + 1)
        )
        self.assertEqual(
            assistant_proposal.capability_candidates(
                "anything at all",
                helpers,
                installed_ids=frozenset(),
                enabled=(),
            ),
            ((), ()),
        )

        senders = tuple(
            assistant_proposal.Capability(
                f"send-{index}", "WhatsApp sender", "Send WhatsApp messages.", ("send-message",)
            )
            for index in range(assistant_proposal.MAX_CAPABILITY_SHORTLIST)
        )
        kept_enabled, kept = assistant_proposal.capability_candidates(
            "send a WhatsApp message",
            (helpers[0],),
            installed_ids=frozenset(item.assistant_id for item in senders),
            enabled=senders,
        )
        self.assertEqual(kept, (helpers[0],))
        self.assertEqual(kept_enabled, senders[: assistant_proposal.MAX_CAPABILITY_SHORTLIST - 1])

    def test_uninstall_confirmation_never_accepts_install_language(self) -> None:
        cases = {
            "sim": "confirm",
            "Pode desinstalar!": "confirm",
            "remove it": "confirm",
            "YES": "confirm",
            "não": "cancel",
            "nao remova": "cancel",
            "do not uninstall": "cancel",
            "agora desinstale": "ambiguous",
            "now uninstall": "ambiguous",
            "install it": "ambiguous",
            "pode instalar": "ambiguous",
            "uninstall it and continue": "ambiguous",
        }
        for message, expected in cases.items():
            with self.subTest(message=message):
                self.assertEqual(assistant_proposal.classify_uninstall_confirmation(message), expected)

    def test_uninstall_directory_shortlist_uses_only_installed_id_and_name(self) -> None:
        cloudflare = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability(
                "shimpz-cloudflare",
                "Shimpz Cloudflare",
                "Manage DNS records.",
                ("remove-dns-record",),
            ),
            "0.4.4",
        )
        other = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability(
                "cloudflare-audit",
                "Cloudflare Audit",
                "Audit DNS records.",
                ("list-dns-records",),
            ),
            "1.0.0",
        )
        self.assertEqual(
            assistant_proposal.uninstall_shortlist("shimpz cloudflare", (other, cloudflare)),
            (other, cloudflare),
        )
        self.assertEqual(
            assistant_proposal.uninstall_shortlist("o de DNS", (cloudflare, other)),
            (other, cloudflare),
        )
        self.assertEqual(assistant_proposal.uninstall_shortlist("...", (cloudflare, other)), ())

    def test_uninstall_proposal_is_version_bound_and_short_lived(self) -> None:
        candidate = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability(
                "shimpz-cloudflare",
                "Shimpz Cloudflare",
                "Manage DNS records.",
                ("list-zones",),
            ),
            "0.4.4",
        )
        proposal = assistant_proposal.create_uninstall_proposal(
            "team_1",
            candidate,
            language_exemplar="Desinstale o Assistant do Cloudflare",
            now=10.0,
            proposal_id_factory=lambda: "c" * 32,
        )

        self.assertEqual(proposal.assistant_version, "0.4.4")
        self.assertTrue(proposal.valid_for("team_1", 129.999))
        self.assertFalse(proposal.valid_for("team_1", 130.0))
        self.assertNotIn("Desinstale", repr(proposal))

    def test_uninstall_proposal_rejects_invalid_authority(self) -> None:
        candidate = assistant_proposal.UninstallCandidate(
            assistant_proposal.Capability(
                "shimpz-cloudflare",
                "Shimpz Cloudflare",
                "Manage DNS records.",
                ("list-zones",),
            ),
            "0.4.4",
        )
        with self.assertRaises(ValueError):
            assistant_proposal.create_uninstall_proposal(
                "Bad",
                candidate,
                language_exemplar="Desinstale o Assistant",
                now=10.0,
                proposal_id_factory=lambda: "b" * 32,
            )


if __name__ == "__main__":
    unittest.main()
