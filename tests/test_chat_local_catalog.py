"""Strict Local snapshot planning projection tests."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import transport

from chat import local_catalog


def _snapshot(
    image_character: str,
    created_at: str,
    *,
    assistant_id: str = "shimpz-cloudflare",
    admission: str = "admissible",
    reason: str | None = None,
) -> dict[str, object]:
    return {
        "assistant_id": assistant_id,
        "assistant_version": "0.4.5",
        "name": "Shimpz Cloudflare",
        "summary": "Inspect Cloudflare zones and manage DNS records.",
        "declared_creators": ["@shimpz"],
        "actions": ["list-zones"],
        "integrations": ["cloudflare"],
        "image_id": "sha256:" + (image_character * 64),
        "platform": "linux/amd64",
        "created_at": created_at,
        "provenance": "local",
        "unpublished": True,
        "admission": admission,
        "reason": reason,
    }


class LocalCatalogTests(unittest.TestCase):
    def test_selects_one_newest_exact_snapshot_per_identity(self) -> None:
        response = transport.TeamResponse(
            200,
            {
                "assistants": [
                    _snapshot("a", "2026-09-15T08:30:00Z"),
                    _snapshot("b", "2026-09-15T02:00:00-07:00"),
                    _snapshot("d", "2026-09-15T08:00:00Z"),
                    _snapshot("c", "2026-09-15T09:00:00Z", assistant_id="whatsapp"),
                ],
                "trace_id": "d" * 32,
            },
        )

        candidates = local_catalog.primary(response).offerable

        self.assertEqual([candidate.assistant_id for candidate in candidates], ["shimpz-cloudflare", "whatsapp"])
        self.assertEqual(candidates[0].image_id, "sha256:" + ("b" * 64))
        self.assertEqual(candidates[0].actions, ("list-zones",))
        self.assertEqual(tuple(item.provider for item in candidates[0].integrations), ("cloudflare",))
        # A card names the snapshot's first declared Creator beside its version.
        self.assertEqual((candidates[0].creator, candidates[0].assistant_version), ("@shimpz", "0.4.5"))

    def test_equal_creation_time_uses_image_id_as_the_tie_breaker(self) -> None:
        response = transport.TeamResponse(
            200,
            {
                "assistants": [
                    _snapshot("a", "2026-09-15T09:00:00Z"),
                    _snapshot("b", "2026-09-15T09:00:00Z"),
                ]
            },
        )

        candidates = local_catalog.primary(response).offerable

        self.assertEqual(candidates[0].image_id, "sha256:" + ("b" * 64))

    def test_only_an_admitted_identity_is_offerable_and_every_staged_identity_shadows(self) -> None:
        response = transport.TeamResponse(
            200,
            {
                "assistants": [
                    _snapshot("a", "2026-09-15T09:00:00Z", assistant_id="admitted"),
                    _snapshot(
                        "b",
                        "2026-09-15T09:00:00Z",
                        assistant_id="refused",
                        admission="inadmissible",
                        reason="declaration-invalid",
                    ),
                    _snapshot("c", "2026-09-15T09:00:00Z", assistant_id="unanswered", admission="unavailable"),
                    # The newest image of an identity decides it, even when an older one was admitted.
                    _snapshot("d", "2026-09-15T08:00:00Z", assistant_id="restaged"),
                    _snapshot(
                        "e",
                        "2026-09-15T09:00:00Z",
                        assistant_id="restaged",
                        admission="inadmissible",
                        reason="image-inconsistent",
                    ),
                ]
            },
        )

        inventory = local_catalog.primary(response)

        self.assertEqual([assistant.assistant_id for assistant in inventory.offerable], ["admitted"])
        self.assertEqual(inventory.staged_ids, {"admitted", "refused", "unanswered", "restaged"})

    def test_a_staged_identity_whose_labels_team_refused_shadows_without_being_offered(self) -> None:
        unlabeled = {
            **_snapshot("c", "2026-09-15T09:00:00Z", assistant_id="broken-labels"),
            **dict.fromkeys(
                ("assistant_version", "name", "summary", "declared_creators", "actions", "integrations", "created_at")
            ),
            "admission": "inadmissible",
            "reason": "labels-invalid",
        }
        response = transport.TeamResponse(
            200,
            {
                "assistants": [
                    _snapshot("a", "2026-09-15T09:00:00Z", assistant_id="admitted"),
                    unlabeled,
                    # A labeled admissible image of the same identity is still not offered beside the refused one.
                    _snapshot("d", "2026-09-15T10:00:00Z", assistant_id="broken-labels"),
                ]
            },
        )

        inventory = local_catalog.primary(response)

        self.assertEqual([assistant.assistant_id for assistant in inventory.offerable], ["admitted"])
        self.assertEqual(inventory.staged_ids, {"admitted", "broken-labels"})
        unlabeled_only = transport.TeamResponse(200, {"assistants": [unlabeled]})
        self.assertEqual(
            local_catalog.primary(unlabeled_only), local_catalog.LocalInventory((), frozenset({"broken-labels"}))
        )

    def test_rejects_widened_duplicate_or_malformed_inventory(self) -> None:
        valid = _snapshot("a", "2026-09-15T09:00:00Z")
        cases = (
            transport.TeamResponse(200, {"assistants": [{**valid, "source_digest": "sha256:" + ("f" * 64)}]}),
            transport.TeamResponse(200, {"assistants": [valid, valid]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "actions": ["List-Zones"]}]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "actions": []}]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "actions": ["z-action", "a-action"]}]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "name": " Shimpz Cloudflare"}]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "assistant_version": "01.2.3"}]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "created_at": "tomorrow"}]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "created_at": "2026-99-15T09:00:00Z"}]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "created_at": "2026-09-15T09:00:00.0"}]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "admission": "inadmissible"}]}),
            transport.TeamResponse(200, {"assistants": [{**valid, "reason": "declaration-invalid"}]}),
            transport.TeamResponse(
                200, {"assistants": [{key: item for key, item in valid.items() if key != "admission"}]}
            ),
            transport.TeamResponse(200, {"assistants": [{**valid, "name": "Shimpz\tCloudflare"}]}),
            transport.TeamResponse(200, {"assistants": [], "trace_id": "bad"}),
            transport.TeamResponse(200, {"assistants": [], "extra": True}),
            transport.TeamResponse(503, {"detail": "private"}),
        )
        for response in cases:
            with self.subTest(response=response), self.assertRaises(ValueError):
                local_catalog.primary(response)


if __name__ == "__main__":
    unittest.main()
