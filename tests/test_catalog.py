"""Behavioral contracts for the Admin integration catalog."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import catalog
import keyset


class CatalogTests(unittest.TestCase):
    def test_catalog_covers_every_configuration_group_exactly(self) -> None:
        self.assertEqual(set(catalog.CATALOG), {field["group"] for field in keyset.SCHEMA})
        self.assertEqual(set(catalog.CATALOG), {"internal", "advanced"})

    def test_keys_for_preserves_schema_order(self) -> None:
        for group in catalog.CATALOG:
            expected = [field["key"] for field in keyset.SCHEMA if field["group"] == group]
            with self.subTest(group=group):
                self.assertEqual(catalog.keys_for(group), expected)

    def test_entry_rejects_unknown_groups(self) -> None:
        self.assertEqual(catalog.entry("internal")["category"], catalog.INFRA)
        with self.assertRaises(ValueError):
            catalog.entry("unknown")

    def test_entries_are_well_formed_and_emit_no_unused_environment(self) -> None:
        values = {field["key"]: "configured" for field in keyset.SCHEMA}
        for group, entry in catalog.CATALOG.items():
            with self.subTest(group=group):
                self.assertIn(entry["category"], catalog.CATEGORIES)
                self.assertTrue(entry["public_name"])
                self.assertTrue(entry["blurb"])
                self.assertIsInstance(entry["reconfigurable"], bool)
                self.assertIsNone(entry["recreate_target"])
                self.assertEqual(catalog.container_env_for(group, values), {})


if __name__ == "__main__":
    unittest.main()
