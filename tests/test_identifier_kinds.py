"""Admin admits every Team and Store identifier by its own kind, as the producing protocol defines it."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from history import store as history_store
from team import bridge as team

from chat import assistant_inventory, human, payloads, store_catalog

ACTIONS = ("dns.read", "zone_get", "a" * 128)
IDENTIFIERS = ("api-token", "a" * 64)


class TeamIdentifierKindTests(unittest.TestCase):
    def test_the_bridge_admits_each_kind_and_refuses_the_others(self) -> None:
        for admit, valid, invalid in (
            (team.canonical_assistant_id, ("a" * 40,), ("a" * 41, "dns.read", "a--b")),
            (team.canonical_identifier, IDENTIFIERS, ("a" * 65, "api.token", "api_token", 7)),
            (team.canonical_action_id, ACTIONS, ("a" * 129, "dns..read", "Lookup", None)),
        ):
            for value in valid:
                with self.subTest(admit=admit.__name__, value=value):
                    self.assertEqual(admit(value), value)
            for value in invalid:
                with self.subTest(admit=admit.__name__, value=value), self.assertRaises(payloads.TeamRequestError):
                    admit(value)

    def test_a_human_challenge_names_a_canonical_action_and_stored_input(self) -> None:
        for action in ACTIONS:
            with self.subTest(action=action):
                self.assertEqual(human._action({"id": action, "summary": "Read"})["id"], action)
        with self.assertRaises(human.HumanChallengeError):
            human._action({"id": "a" * 129, "summary": "Read"})
        self.assertTrue(all(human._stored_input(value) for value in IDENTIFIERS))
        self.assertFalse(any(human._stored_input(value) for value in ("a" * 65, "api.token", None)))

    def test_the_team_assistant_registry_names_canonical_actions(self) -> None:
        def registry(actions: list[str]):
            body = {"assistants": [{"id": "helper", "title": "Helper", "summary": "Helps.", "actions": actions}]}
            return assistant_inventory.registry(team.TeamResponse(200, body))

        self.assertIn("helper", registry(list(ACTIONS)))
        for actions in (["a" * 129], ["dns..read"]):
            with self.subTest(actions=actions), self.assertRaises(ValueError):
                registry(actions)

    def test_the_chat_history_keeps_providers_as_developers_identifiers(self) -> None:
        item = {
            "id": "helper",
            "name": "Helper",
            "summary": "Helps.",
            "providers": ["p" * 64],
            "provenance": "published",
            "status": "installed",
        }
        self.assertEqual(history_store._install_assistant(item)["providers"], ["p" * 64])
        with self.assertRaises(ValueError):
            history_store._install_assistant({**item, "providers": ["p" * 65]})


class StoreCatalogIdentifierKindTests(unittest.TestCase):
    """The public Store catalog projects Developers manifests, so its Action ids are Developers identifiers."""

    def test_catalog_actions_and_integrations_are_developers_identifiers(self) -> None:
        action = {"id": "a" * 64, "integrations": ["i" * 64], "human_requests": []}
        self.assertEqual(store_catalog._actions([action]), ("a" * 64,))
        for invalid in ({"id": "a" * 65}, {"id": "dns.read"}, {"integrations": ["i" * 65]}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                store_catalog._actions([{**action, **invalid}])
        integration = {"id": "p" * 64, "provider": "p" * 64, "scopes": ["read"]}
        self.assertEqual(len(store_catalog._integrations([integration])), 1)
        with self.assertRaises(ValueError):
            store_catalog._integrations([{**integration, "id": "p" * 65, "provider": "p" * 65}])


if __name__ == "__main__":
    unittest.main()
