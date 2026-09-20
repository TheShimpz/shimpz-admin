"""Pure matching and authority tests for conversational Assistant installation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assistant_proposal, store_catalog

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
    def test_install_directory_shortlist_is_bounded_and_semantic(self) -> None:
        cloudflare = _candidate()
        whatsapp = _candidate("whatsapp", name="WhatsApp", provider="whatsapp")
        self.assertEqual(
            assistant_proposal.install_shortlist("cloudflare", (whatsapp, cloudflare)),
            (cloudflare,),
        )
        self.assertEqual(
            assistant_proposal.install_shortlist("unknown", (whatsapp, cloudflare)),
            (),
        )

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

    def test_shortlists_explicit_and_composed_intent_without_a_baked_mapping(self) -> None:
        cloudflare = _candidate()
        whatsapp = _candidate(
            "whatsapp",
            name="WhatsApp",
            summary="Sends reviewed WhatsApp messages.",
            provider="whatsapp",
            actions=("send-message",),
        )

        self.assertEqual(
            assistant_proposal.capability_shortlist(
                "Configure Cloudflare e envie uma mensagem no WhatsApp",
                (cloudflare, whatsapp),
                installed_ids=frozenset(),
                enabled=(),
            ),
            (whatsapp, cloudflare),
        )

    def test_rejects_weak_ambiguous_installed_or_already_enabled_matches(self) -> None:
        cloudflare = _candidate()
        cases = (
            ("Olá", (cloudflare,), frozenset(), (), ()),
            ("Cloudflare zones", (cloudflare,), frozenset({cloudflare.assistant_id}), (), ()),
            (
                "Cloudflare zones",
                (cloudflare,),
                frozenset(),
                (
                    assistant_proposal.Capability(
                        "enabled-cloudflare",
                        "Cloudflare",
                        cloudflare.summary,
                        cloudflare.actions,
                    ),
                ),
                (),
            ),
        )
        for message, catalog, installed, enabled, expected in cases:
            with self.subTest(message=message, installed=installed, enabled=enabled):
                self.assertEqual(
                    assistant_proposal.capability_shortlist(
                        message,
                        catalog,
                        installed_ids=installed,
                        enabled=enabled,
                    ),
                    expected,
                )

        ambiguous_a = _candidate(
            "domain-a",
            name="Domain Alpha",
            summary="Reviewed domain automation helper.",
            provider="alpha",
            actions=("alpha-action",),
        )
        ambiguous_b = _candidate(
            "domain-b",
            name="Domain Beta",
            summary="Reviewed domain automation helper.",
            provider="beta",
            actions=("beta-action",),
        )
        self.assertEqual(
            assistant_proposal.capability_shortlist(
                "Preciso de domain automation",
                (ambiguous_a, ambiguous_b),
                installed_ids=frozenset(),
                enabled=(),
            ),
            (),
        )

    def test_empty_search_cannot_create_a_shortlist(self) -> None:
        self.assertEqual(
            assistant_proposal.capability_shortlist(
                "...",
                (_candidate(),),
                installed_ids=frozenset(),
                enabled=(),
            ),
            (),
        )

    def test_public_enabled_provider_suppresses_an_equally_strong_candidate(self) -> None:
        candidate = _candidate(
            "domain-helper",
            name="Domain Helper",
            summary="Provides reviewed domain operations.",
            provider="cloudflare",
            actions=("inspect-domain",),
        )
        enabled = assistant_proposal.Capability(
            "installed-helper",
            "Installed Helper",
            "Provides reviewed operations.",
            ("inspect-resource",),
            ("cloudflare",),
        )

        self.assertEqual(
            assistant_proposal.capability_shortlist(
                "Use Cloudflare",
                (candidate,),
                installed_ids=frozenset({enabled.assistant_id}),
                enabled=(enabled,),
            ),
            (),
        )

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
            assistant_proposal.uninstall_shortlist("cloudflare", (other, cloudflare)),
            (other, cloudflare),
        )
        self.assertEqual(assistant_proposal.uninstall_shortlist("DNS records", (cloudflare, other)), ())
        self.assertEqual(assistant_proposal.uninstall_shortlist("unknown", (cloudflare, other)), ())

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
