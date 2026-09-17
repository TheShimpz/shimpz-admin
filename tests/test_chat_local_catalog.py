"""Strict Local snapshot planning projection tests."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team

from chat import local_catalog


def _snapshot(image_character: str, created_at: str, *, assistant_id: str = "shimpz-cloudflare") -> dict[str, object]:
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
    }


class LocalCatalogTests(unittest.TestCase):
    def test_selects_one_newest_exact_snapshot_per_identity(self) -> None:
        response = team.TeamResponse(
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

        candidates = local_catalog.primary(response)

        self.assertEqual([candidate.assistant_id for candidate in candidates], ["shimpz-cloudflare", "whatsapp"])
        self.assertEqual(candidates[0].image_id, "sha256:" + ("b" * 64))
        self.assertEqual(candidates[0].actions, ("list-zones",))
        self.assertEqual(tuple(item.provider for item in candidates[0].integrations), ("cloudflare",))

    def test_equal_creation_time_uses_image_id_as_the_tie_breaker(self) -> None:
        response = team.TeamResponse(
            200,
            {
                "assistants": [
                    _snapshot("a", "2026-09-15T09:00:00Z"),
                    _snapshot("b", "2026-09-15T09:00:00Z"),
                ]
            },
        )

        candidates = local_catalog.primary(response)

        self.assertEqual(candidates[0].image_id, "sha256:" + ("b" * 64))

    def test_rejects_widened_duplicate_or_malformed_inventory(self) -> None:
        valid = _snapshot("a", "2026-09-15T09:00:00Z")
        cases = (
            team.TeamResponse(200, {"assistants": [{**valid, "source_digest": "sha256:" + ("f" * 64)}]}),
            team.TeamResponse(200, {"assistants": [valid, valid]}),
            team.TeamResponse(200, {"assistants": [{**valid, "actions": ["List-Zones"]}]}),
            team.TeamResponse(200, {"assistants": [{**valid, "actions": []}]}),
            team.TeamResponse(200, {"assistants": [{**valid, "actions": ["z-action", "a-action"]}]}),
            team.TeamResponse(200, {"assistants": [{**valid, "name": " Shimpz Cloudflare"}]}),
            team.TeamResponse(200, {"assistants": [{**valid, "assistant_version": "01.2.3"}]}),
            team.TeamResponse(200, {"assistants": [{**valid, "created_at": "tomorrow"}]}),
            team.TeamResponse(200, {"assistants": [{**valid, "created_at": "2026-99-15T09:00:00Z"}]}),
            team.TeamResponse(200, {"assistants": [{**valid, "created_at": "2026-09-15T09:00:00.0"}]}),
            team.TeamResponse(200, {"assistants": [], "trace_id": "bad"}),
            team.TeamResponse(200, {"assistants": [], "extra": True}),
            team.TeamResponse(503, {"detail": "private"}),
        )
        for response in cases:
            with self.subTest(response=response), self.assertRaises(ValueError):
                local_catalog.primary(response)


if __name__ == "__main__":
    unittest.main()
