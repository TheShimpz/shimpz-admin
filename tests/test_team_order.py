"""Local Team list order: the private order file, its projection, reorder, and lifecycle serialization."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi import FastAPI, HTTPException
from team import bridge as team
from team import names as team_names
from team import order as team_order
from test_app_route_edges import _request
from test_team_bridge_assistants import _LiveTeamCase, _probe_session, _TeamHandler

ORIGIN = "https://admin.example.test"


def _teams(*team_ids: str) -> list[dict[str, str]]:
    return [{"team_id": team_id, "team_name": team_id.title(), "status": "running"} for team_id in team_ids]


def _inventory(*team_ids: str, **extra: object) -> team.TeamResponse:
    return team.TeamResponse(200, {"teams": _teams(*team_ids), **extra})


class OrderCase(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.path = self.root / "team-order.json"
        patcher = mock.patch.object(team_order, "ORDER_PATH", self.path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, raw: bytes, mode: int = 0o600) -> None:
        self.path.write_bytes(raw)
        self.path.chmod(mode)

    def saved(self, *team_ids: str) -> None:
        self.write(json.dumps({"team_ids": list(team_ids)}).encode())

    def listed(self, response: team.TeamResponse) -> list[str]:
        return [item["team_id"] for item in response.body["teams"]]


class OrderFileTests(OrderCase):
    def test_ids_are_bounded_unique_and_canonical(self) -> None:
        self.assertEqual(team_order.canonical_ids([]), [])
        self.assertEqual(team_order.canonical_ids(["b", "a_1"]), ["b", "a_1"])
        for value in (
            None,
            "team_a",
            [None],
            [1],
            ["Team"],
            [" team_a"],
            ["x" * 41],
            ["team_a", "team_a"],
            [f"team_{index}" for index in range(129)],
        ):
            with self.subTest(value=str(value)[:40]):
                self.assertIsNone(team_order.canonical_ids(value))

    def test_a_saved_order_is_private_durable_and_read_back_exactly(self) -> None:
        self.assertIsNone(team_order.load())
        with mock.patch.object(team_order.os, "fsync", wraps=os.fsync) as fsync:
            team_order._save(["team_b", "team_a"])
        # The temporary file and then its directory reach the disk before the save returns.
        self.assertEqual(fsync.call_count, 2)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.path.read_bytes()), {"team_ids": ["team_b", "team_a"]})
        self.assertEqual(team_order.load(), ["team_b", "team_a"])
        self.assertEqual([path.name for path in self.root.iterdir()], ["team-order.json"])

    def test_an_unsafe_or_malformed_file_is_invalid(self) -> None:
        cases = (
            (b"not json", 0o600),
            (b"[]", 0o600),
            (b'{"team_ids":["a"],"extra":1}', 0o600),
            (b'{"team_ids":["a"],"team_ids":["b"]}', 0o600),
            (b'{"team_ids":[NaN]}', 0o600),
            (b'{"team_ids":["A"]}', 0o600),
            (b'{"team_ids":["a"]}' + b" " * team_order.MAX_ORDER_BYTES, 0o600),
            (b'{"team_ids":["a"]}', 0o644),
        )
        for raw, mode in cases:
            with self.subTest(raw=raw[:40], mode=oct(mode)), self.assertRaises(team_order.OrderInvalidError):
                self.write(raw, mode)
                team_order.load()
        self.saved("a")
        link = self.root / "second-link"
        os.link(self.path, link)
        with self.assertRaises(team_order.OrderInvalidError):
            team_order.load()
        link.unlink()
        with (
            mock.patch.object(team_order.os, "geteuid", return_value=os.geteuid() + 1),
            self.assertRaises(team_order.OrderInvalidError),
        ):
            team_order.load()
        self.path.unlink()
        os.mkfifo(self.path, 0o600)
        with self.assertRaises(team_order.OrderInvalidError):
            team_order.load()

    def test_an_unreadable_file_is_unavailable_and_not_merely_invalid(self) -> None:
        self.path.symlink_to(self.root / "elsewhere.json")
        with self.assertRaises(team_order.OrderUnavailableError) as caught:
            team_order.load()
        self.assertNotIsInstance(caught.exception, team_order.OrderInvalidError)
        self.path.unlink()
        self.saved("a")
        with (
            mock.patch.object(team_order.os, "read", side_effect=OSError("EIO")),
            self.assertRaises(team_order.OrderUnavailableError) as caught,
        ):
            team_order.load()
        self.assertNotIsInstance(caught.exception, team_order.OrderInvalidError)

    def test_a_failed_write_leaves_the_previous_order_and_no_temporary_file(self) -> None:
        self.saved("a", "b")
        with (
            mock.patch.object(team_order.os, "write", side_effect=OSError("ENOSPC")),
            self.assertRaises(team_order.OrderUnavailableError),
        ):
            team_order._save(["b", "a"])
        self.assertEqual(team_order.load(), ["a", "b"])
        self.assertEqual([path.name for path in self.root.iterdir()], ["team-order.json"])
        with (
            mock.patch.object(team_order, "ORDER_PATH", self.root / "missing" / "team-order.json"),
            self.assertRaises(team_order.OrderUnavailableError),
        ):
            team_order._save(["a"])

    def test_forget_removes_only_one_id_and_never_rewrites_an_unchanged_order(self) -> None:
        team_order.forget("a")
        self.assertFalse(self.path.exists())
        self.saved("a", "b", "c")
        team_order.forget("b")
        self.assertEqual(team_order.load(), ["a", "c"])
        with mock.patch.object(team_order, "_save") as saved:
            team_order.forget("b")
        saved.assert_not_called()

    def test_a_mutation_removes_admins_own_invalid_order_so_no_position_can_return(self) -> None:
        for raw, mode in ((b"garbage", 0o600), (b'{"team_ids":["a","b"]}', 0o644)):
            with self.subTest(raw=raw, mode=oct(mode)):
                self.write(raw, mode)
                with self.assertLogs("shimpz-admin", "WARNING"):
                    team_order.forget("b")
                self.assertFalse(self.path.exists())
        # Another name for the same inode survives; only the order's own entry is removed.
        self.saved("a")
        link = self.root / "second-link"
        os.link(self.path, link)
        with self.assertLogs("shimpz-admin", "WARNING"):
            team_order.forget("b")
        self.assertEqual((self.path.exists(), link.exists()), (False, True))

    def test_a_mutation_refuses_an_invalid_order_it_cannot_safely_remove(self) -> None:
        self.saved("a")
        with (
            mock.patch.object(team_order.os, "geteuid", return_value=os.geteuid() + 1),
            self.assertLogs("shimpz-admin", "WARNING"),
            self.assertRaises(team_order.OrderUnavailableError),
        ):
            team_order.forget("a")
        self.path.chmod(0o644)
        with (
            mock.patch.object(Path, "unlink", side_effect=PermissionError("denied")),
            self.assertLogs("shimpz-admin", "WARNING"),
            self.assertRaises(team_order.OrderUnavailableError),
        ):
            team_order.forget("a")
        self.assertTrue(self.path.exists())
        self.path.unlink()
        os.mkfifo(self.path, 0o600)
        with self.assertLogs("shimpz-admin", "WARNING"), self.assertRaises(team_order.OrderUnavailableError):
            team_order.forget("a")
        self.path.unlink()
        self.path.symlink_to(self.root / "elsewhere.json")
        with self.assertRaises(team_order.OrderUnavailableError):
            team_order.forget("a")
        self.assertTrue(self.path.is_symlink())

    def test_a_retry_completes_the_directory_barrier_an_earlier_attempt_missed(self) -> None:
        self.saved("a", "b")
        # The rename lands, then the directory fsync fails: the removal is not yet durable.
        with (
            mock.patch.object(team_order.os, "fsync", side_effect=[None, OSError("EIO")]),
            self.assertRaises(team_order.OrderUnavailableError),
        ):
            team_order.forget("a")
        self.assertEqual(team_order.load(), ["b"])
        with mock.patch.object(team_order.os, "fsync", wraps=os.fsync) as fsync:
            team_order.forget("a")
        fsync.assert_called_once()
        # An unlink that landed before its barrier failed is made durable by the retry, too.
        with (
            mock.patch.object(team_order.os, "fsync", side_effect=OSError("EIO")),
            self.assertRaises(team_order.OrderUnavailableError),
        ):
            team_order.clear()
        self.assertFalse(self.path.exists())
        with mock.patch.object(team_order.os, "fsync", wraps=os.fsync) as fsync:
            team_order.clear()
        fsync.assert_called_once()

    def test_the_barrier_has_nothing_to_sync_without_a_directory_and_fails_on_an_unusable_one(self) -> None:
        with mock.patch.object(team_order, "ORDER_PATH", self.root / "missing" / "team-order.json"):
            team_order.forget("a")
            team_order.clear()
        parent = self.root / "file"
        parent.write_bytes(b"")
        with (
            mock.patch.object(team_order, "ORDER_PATH", parent / "team-order.json"),
            self.assertRaises(team_order.OrderUnavailableError),
        ):
            team_order._sync_parent()

    def test_clear_removes_the_order_and_interrupted_writes_but_nothing_else(self) -> None:
        team_order.clear()
        self.saved("a")
        leftover = self.root / ".team-order.json.abcd1234.tmp"
        unrelated = self.root / "admin.json"
        leftover.write_bytes(b"{}")
        unrelated.write_bytes(b"{}")
        team_order.clear()
        self.assertEqual([path.name for path in self.root.iterdir()], ["admin.json"])
        self.path.mkdir()
        with self.assertRaises(team_order.OrderUnavailableError):
            team_order.clear()

    def test_unsaved_teams_lead_newest_first_and_saved_survivors_follow_in_saved_order(self) -> None:
        teams = _teams("new", "c", "b", "a")
        arranged = team_order.arrange(teams, ["a", "gone", "c", "b"])
        self.assertEqual([item["team_id"] for item in arranged], ["new", "a", "c", "b"])
        self.assertEqual(team_order.arrange(teams, None), teams)


class ListingTests(OrderCase):
    def listing(self, response: team.TeamResponse) -> team.TeamResponse:
        with mock.patch.object(team, "list_teams", return_value=response):
            return team_order._listing()

    def test_the_list_follows_the_saved_order_and_a_read_never_rewrites_it(self) -> None:
        self.assertEqual(self.listed(self.listing(_inventory("c", "b", "a"))), ["c", "b", "a"])
        self.saved("a", "gone", "b")
        before = (self.path.read_bytes(), self.path.stat().st_mtime_ns)
        response = self.listing(_inventory("c", "b", "a", trace_id="f" * 32))
        self.assertEqual(response, team.TeamResponse(200, {"teams": _teams("c", "a", "b"), "trace_id": "f" * 32}))
        self.assertEqual((self.path.read_bytes(), self.path.stat().st_mtime_ns), before)

    def test_an_unusable_order_falls_back_to_newest_first_with_a_sanitized_diagnostic(self) -> None:
        self.write(b'{"team_ids":["secret_marker"]')
        with self.assertLogs("shimpz-admin", "WARNING") as logs:
            response = self.listing(_inventory("b", "a"))
        self.assertEqual(self.listed(response), ["b", "a"])
        self.assertNotIn("secret_marker", "\n".join(logs.output))
        self.assertNotIn(str(self.root), "\n".join(logs.output))
        self.assertEqual(self.path.read_bytes(), b'{"team_ids":["secret_marker"]')

    def test_a_failed_or_invalid_inventory_is_never_replaced_by_the_saved_order(self) -> None:
        self.saved("a")
        with mock.patch.object(team_order, "load") as load:
            refused = team.TeamResponse(403, {"detail": "Supervisor authority is required"})
            self.assertIs(self.listing(refused), refused)
            invalid = team.TeamResponse(200, {"teams": [{"team_id": "a"}]})
            with self.assertLogs("shimpz-admin", "WARNING"):
                self.assertEqual(self.listing(invalid).status, 502)
            duplicate = team.TeamResponse(200, {"teams": _teams("a", "a")})
            with self.assertLogs("shimpz-admin", "WARNING"):
                self.assertEqual(self.listing(duplicate).status, 502)
        load.assert_not_called()

    def test_the_list_route_is_never_cached(self) -> None:
        with mock.patch.object(team, "list_teams", return_value=_inventory("a")):
            response = team_order.listing()
        self.assertEqual((response.status_code, response.headers["Cache-Control"]), (200, "no-store"))
        with mock.patch.object(team, "list_teams", return_value=team.TeamResponse(502, {"detail": "unavailable"})):
            response = team_order.listing()
        self.assertEqual((response.status_code, response.headers["Cache-Control"]), (502, "no-store"))


class ReorderTests(OrderCase):
    def reorder(self, team_ids: list[str], inventory: team.TeamResponse) -> team.TeamResponse:
        with mock.patch.object(team, "list_teams", return_value=inventory) as listed:
            response = team_order.reorder(team_ids)
        listed.assert_called_once_with()
        return response

    def test_an_exact_permutation_of_the_fresh_inventory_is_saved(self) -> None:
        response = self.reorder(["a", "c", "b"], _inventory("c", "b", "a"))
        self.assertEqual(response, team.TeamResponse(200, {"teams": _teams("a", "c", "b")}))
        self.assertEqual(team_order.load(), ["a", "c", "b"])
        # Every reorder reads a new inventory: a Team created since then makes the same request stale.
        response = self.reorder(["a", "c", "b"], _inventory("d", "c", "b", "a"))
        self.assertEqual((response.status, response.body["code"]), (409, "team-order-stale"))

    def test_a_stale_membership_is_a_conflict_that_saves_nothing(self) -> None:
        self.saved("b", "a")
        for team_ids in (["a"], ["a", "b", "c"], ["a", "c"], []):
            with self.subTest(team_ids=team_ids):
                response = self.reorder(team_ids, _inventory("b", "a"))
                self.assertEqual((response.status, response.body["code"]), (409, "team-order-stale"))
        self.assertEqual(team_order.load(), ["b", "a"])

    def test_an_unavailable_inventory_or_store_saves_nothing(self) -> None:
        self.saved("b", "a")
        for inventory in (
            team.TeamResponse(502, {"detail": "team unavailable"}),
            team.TeamResponse(500, {"detail": "failed"}),
        ):
            with self.subTest(inventory=inventory):
                response = self.reorder(["a", "b"], inventory)
                self.assertEqual((response.status, response.body["code"]), (503, "team-inventory-unavailable"))
        with self.assertLogs("shimpz-admin", "WARNING"):
            response = self.reorder(["a", "b"], team.TeamResponse(200, {"teams": "invalid"}))
        self.assertEqual((response.status, response.body["code"]), (503, "team-inventory-unavailable"))
        refused = team.TeamResponse(401, {"detail": "unauthenticated"})
        self.assertIs(self.reorder(["a", "b"], refused), refused)
        with (
            mock.patch.object(team_order, "_save", side_effect=team_order.OrderUnavailableError("full")),
            self.assertLogs("shimpz-admin", "ERROR"),
        ):
            response = self.reorder(["a", "b"], _inventory("b", "a"))
        self.assertEqual((response.status, response.body["code"]), (503, "team-order-unavailable"))
        self.assertEqual(team_order.load(), ["b", "a"])


class ReorderRouteTests(OrderCase):
    def endpoint(self):
        app = FastAPI()
        team_order.register(app, lambda: frozenset({ORIGIN}))
        (route,) = [route for route in app.routes if getattr(route, "methods", None) == {"PUT"}]
        self.assertEqual(route.path, "/api/teams/order")
        return route.endpoint

    def send(self, body: bytes, origin: bytes | None = ORIGIN.encode()):
        headers = [(b"content-type", b"application/json")] + ([] if origin is None else [(b"origin", origin)])
        return asyncio.run(self.endpoint()(_request("/api/teams/order", body=body, headers=headers)))

    def refused(self, body: bytes, origin: bytes | None = ORIGIN.encode()) -> int:
        with self.assertRaises(HTTPException) as caught:
            self.send(body, origin)
        self.assertEqual(caught.exception.headers, {"Cache-Control": "no-store"})
        return caught.exception.status_code

    def test_only_an_exact_admitted_origin_may_reorder(self) -> None:
        with mock.patch.object(team, "list_teams") as listed:
            for origin in (None, b"HTTPS://ADMIN.EXAMPLE.TEST", b" https://admin.example.test", b"https://other.test"):
                with self.subTest(origin=origin):
                    self.assertEqual(self.refused(b'{"team_ids":[]}', origin), 403)
        listed.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_only_exactly_one_bounded_list_of_canonical_ids_is_admitted(self) -> None:
        too_many = json.dumps({"team_ids": [f"t{index}" for index in range(129)]}).encode()
        with mock.patch.object(team, "list_teams") as listed:
            for body in (
                b'{"team_ids":["a"],"extra":1}',
                b'{"order":["a"]}',
                b'{"team_ids":"a"}',
                b'{"team_ids":["a","a"]}',
                b'{"team_ids":["A"]}',
                b"[]",
                b"not json",
                too_many,
            ):
                with self.subTest(body=body[:40]):
                    self.assertEqual(self.refused(body), 400)
            self.assertEqual(self.refused(b'{"team_ids":["' + b"a" * 9000 + b'"]}'), 413)
        listed.assert_not_called()

    def test_every_answer_is_never_cached(self) -> None:
        for inventory, expected in (
            (_inventory("b", "a"), 200),
            (_inventory("c"), 409),
            (team.TeamResponse(502, {"detail": "team unavailable"}), 503),
        ):
            with self.subTest(expected=expected), mock.patch.object(team, "list_teams", return_value=inventory):
                response = self.send(b'{"team_ids":["a","b"]}')
            self.assertEqual((response.status_code, response.headers["Cache-Control"]), (expected, "no-store"))
        self.assertEqual(team_order.load(), ["a", "b"])


class CreationTests(OrderCase):
    def create(self, inventory: team.TeamResponse, created: team.TeamResponse | None = None):
        created = created or team.TeamResponse(
            200, {"team_id": "old", "team_name": "Old", "status": "running", "created": True}
        )
        with (
            mock.patch.object(team, "list_teams", return_value=inventory) as listed,
            mock.patch.object(team, "create", return_value=created) as create,
            mock.patch.object(team_names.chat_history_http, "team_created", side_effect=lambda _id, result: result),
        ):
            response = team_names.create({"team_name": "Old"})
        return response, listed, create

    def test_a_reused_id_drops_its_stale_position_before_creation_and_then_leads(self) -> None:
        self.saved("b", "old", "a")
        events: list[str] = []
        real_save = team_order._save

        def save(team_ids: list[str]) -> None:
            real_save(team_ids)
            events.append("released")

        with (
            mock.patch.object(team_order, "_save", side_effect=save),
            mock.patch.object(team, "list_teams", return_value=_inventory("b", "a")),
            mock.patch.object(
                team,
                "create",
                side_effect=lambda *_args: (
                    events.append("created") or team.TeamResponse(200, {"team_id": "old", "created": True})
                ),
            ),
            mock.patch.object(team_names.chat_history_http, "team_created", side_effect=lambda _id, result: result),
        ):
            self.assertEqual(team_names.create({"team_name": "Old"}).status_code, 200)
        self.assertEqual(events, ["released", "created"])
        self.assertEqual(team_order.load(), ["b", "a"])
        with mock.patch.object(team, "list_teams", return_value=_inventory("old", "b", "a")):
            self.assertEqual(self.listed(team_order._listing()), ["old", "b", "a"])

    def test_an_id_a_live_team_still_holds_keeps_its_position(self) -> None:
        self.saved("old", "a")
        existing = team.TeamResponse(200, {"team_id": "old", "team_name": "Old", "status": "running", "created": False})
        response, listed, create = self.create(_inventory("a", "old"), existing)
        self.assertEqual(response.status_code, 200)
        listed.assert_called_once_with()
        create.assert_called_once_with("old", "Old")
        self.assertEqual(team_order.load(), ["old", "a"])

    def test_creation_needs_no_inventory_when_no_position_is_saved_for_the_id(self) -> None:
        for raw in (None, b'{"team_ids":["a"]}'):
            with self.subTest(raw=raw):
                if raw is not None:
                    self.write(raw)
                with self.assertLogs("shimpz-admin", "INFO"):
                    response, listed, create = self.create(_inventory())
                self.assertEqual(response.status_code, 200)
                listed.assert_not_called()
                create.assert_called_once_with("old", "Old")
        self.assertEqual(team_order.load(), ["a"])

    def test_creation_removes_an_invalid_order_so_a_stale_position_cannot_return(self) -> None:
        # A valid order with unsafe permissions still names the old id; it must not survive to be repaired later.
        for raw, mode in ((b"garbage", 0o600), (b'{"team_ids":["old","a"]}', 0o644)):
            with self.subTest(raw=raw, mode=oct(mode)):
                self.write(raw, mode)
                with self.assertLogs("shimpz-admin", "WARNING"):
                    response, listed, create = self.create(_inventory())
                self.assertEqual(response.status_code, 200)
                listed.assert_not_called()
                create.assert_called_once_with("old", "Old")
                self.assertFalse(self.path.exists())

    def test_creation_waits_for_the_barrier_a_failed_release_left_incomplete(self) -> None:
        self.saved("old", "a")
        with (
            mock.patch.object(team_order.os, "fsync", side_effect=[None, OSError("EIO")]),
            self.assertLogs("shimpz-admin", "ERROR"),
        ):
            response, _listed, create = self.create(_inventory("a"))
        self.assertEqual((response.status_code, json.loads(response.body)["code"]), (503, "team-order-unavailable"))
        create.assert_not_called()
        self.assertEqual(team_order.load(), ["a"])
        events: list[str] = []
        created = team.TeamResponse(200, {"team_id": "old", "created": True})
        with (
            mock.patch.object(team_order.os, "fsync", side_effect=lambda _fd: events.append("fsync")),
            mock.patch.object(team, "create", side_effect=lambda *_args: events.append("created") or created),
            mock.patch.object(team_names.chat_history_http, "team_created", side_effect=lambda _id, result: result),
        ):
            self.assertEqual(team_names.create({"team_name": "Old"}).status_code, 200)
        self.assertEqual(events, ["fsync", "created"])

    def test_nothing_is_created_when_the_stale_position_cannot_be_released(self) -> None:
        self.saved("old")
        response, _listed, create = self.create(team.TeamResponse(502, {"detail": "team unavailable"}))
        self.assertEqual((response.status_code, json.loads(response.body)["code"]), (503, "team-inventory-unavailable"))
        create.assert_not_called()
        with (
            mock.patch.object(team_order, "_save", side_effect=team_order.OrderUnavailableError("full")),
            self.assertLogs("shimpz-admin", "ERROR"),
        ):
            response, _listed, create = self.create(_inventory())
        self.assertEqual((response.status_code, json.loads(response.body)["code"]), (503, "team-order-unavailable"))
        create.assert_not_called()
        for unsafe in ("symlink", "foreign"):
            with self.subTest(unsafe=unsafe):
                self.path.unlink()
                if unsafe == "symlink":
                    self.path.symlink_to(self.root / "elsewhere.json")
                    owner = os.geteuid()
                else:
                    self.saved("old")
                    owner = os.geteuid() + 1
                with (
                    mock.patch.object(team_order.os, "geteuid", return_value=owner),
                    self.assertLogs("shimpz-admin", "WARNING"),
                ):
                    response, listed, create = self.create(_inventory())
                self.assertEqual(response.status_code, 503)
                listed.assert_not_called()
                create.assert_not_called()
                self.assertTrue(self.path.is_symlink() or self.path.exists())


class SerializationTests(OrderCase):
    def test_a_reorder_waits_for_a_creation_in_progress(self) -> None:
        events: list[str] = []
        creating = threading.Event()
        release = threading.Event()

        def create(*_args) -> team.TeamResponse:
            events.append("create-start")
            creating.set()
            release.wait(5)
            events.append("create-end")
            return team.TeamResponse(200, {"team_id": "new", "created": True})

        def inventory() -> team.TeamResponse:
            events.append("inventory")
            return _inventory("new")

        outcomes: list[team.TeamResponse] = []
        with (
            mock.patch.object(team, "create", side_effect=create),
            mock.patch.object(team, "list_teams", side_effect=inventory),
            mock.patch.object(team_names.chat_history_http, "team_created", side_effect=lambda _id, result: result),
        ):
            creator = threading.Thread(target=team_names.create, args=({"team_name": "New"},))
            creator.start()
            self.assertTrue(creating.wait(5))
            reorderer = threading.Thread(target=lambda: outcomes.append(team_order.reorder(["new"])))
            reorderer.start()
            time.sleep(0.05)
            self.assertEqual(events, ["create-start"])
            release.set()
            creator.join(5)
            reorderer.join(5)
        self.assertEqual(events, ["create-start", "create-end", "inventory"])
        self.assertEqual(outcomes[0].status, 200)
        self.assertEqual(team_order.load(), ["new"])


class LifecycleCleanupTests(OrderCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(root),
                "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
                "SHIMPZ_ADMIN_PROFILE": "local",
            },
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")
        previous_history_store = cls.admin_app.chat_history.STORE_PATH
        cls.admin_app.chat_history.STORE_PATH = root / "chat-history.sqlite3"
        cls.addClassCleanup(setattr, cls.admin_app.chat_history, "STORE_PATH", previous_history_store)

    def test_a_deleted_or_absent_team_loses_its_saved_position(self) -> None:
        self.saved("a", "b")
        deleted = team.TeamResponse(200, {"deleted": True})
        self.assertIs(self.admin_app._team_delete_with_history("a", lambda: deleted), deleted)
        self.assertEqual(team_order.load(), ["b"])
        absent = team.TeamResponse(404, {"detail": "Team not found"})
        self.assertEqual(
            self.admin_app._team_delete_with_history("b", lambda: absent), team.TeamResponse(200, {"deleted": False})
        )
        self.assertEqual(team_order.load(), [])

    def test_a_failed_deletion_keeps_the_position(self) -> None:
        self.saved("a")
        failed = team.TeamResponse(409, {"detail": "Team name does not match"})
        self.assertIs(self.admin_app._team_delete_with_history("a", lambda: failed), failed)
        self.assertEqual(team_order.load(), ["a"])

    def test_a_cleanup_failure_after_deletion_reports_partial_completion_and_retry(self) -> None:
        self.saved("a")
        deleted = team.TeamResponse(200, {"deleted": True})
        with (
            mock.patch.object(team_order, "_save", side_effect=team_order.OrderUnavailableError("full")),
            self.assertLogs("shimpz-admin", "ERROR"),
        ):
            response = self.admin_app._team_delete_with_history("a", lambda: deleted)
        self.assertEqual((response.status, response.body["code"]), (503, "team-order-cleanup-incomplete"))
        self.assertIn("was deleted", response.body["detail"])
        self.assertIn("retry the deletion", response.body["detail"])
        # The retry finds the Team absent and completes the cleanup.
        absent = team.TeamResponse(404, {"detail": "Team not found"})
        self.assertEqual(self.admin_app._team_delete_with_history("a", lambda: absent).status, 200)
        self.assertEqual(team_order.load(), [])

    def test_a_deletion_whose_invalid_order_cannot_be_removed_reports_partial_completion(self) -> None:
        self.saved("a")
        deleted = team.TeamResponse(200, {"deleted": True})
        with (
            mock.patch.object(team_order.os, "geteuid", return_value=os.geteuid() + 1),
            self.assertLogs("shimpz-admin", "WARNING"),
        ):
            response = self.admin_app._team_delete_with_history("a", lambda: deleted)
        self.assertEqual((response.status, response.body["code"]), (503, "team-order-cleanup-incomplete"))
        self.assertTrue(self.path.exists())

    def test_space_reset_removes_the_saved_order_and_reports_a_failed_removal(self) -> None:
        reset = team.TeamResponse(200, {"reset": True})
        failed = team.TeamResponse(502, {"detail": "Team returned an invalid Space reset response"})
        self.saved("a")
        self.assertIs(self.admin_app._space_reset_with_history(lambda: failed), failed)
        self.assertTrue(self.path.exists())
        self.assertIs(self.admin_app._space_reset_with_history(lambda: reset), reset)
        self.assertFalse(self.path.exists())
        self.path.mkdir()
        with self.assertLogs("shimpz-admin", "ERROR"):
            response = self.admin_app._space_reset_with_history(lambda: reset)
        self.assertEqual((response.status, response.body["code"]), (503, "team-order-cleanup-incomplete"))
        self.assertIn("run the Space reset again", response.body["detail"])

    def assert_waits_for_a_reorder(self, name: str, run, outcome: team.TeamResponse) -> None:
        listing = threading.Event()
        release = threading.Event()
        events: list[str] = []

        def inventory() -> team.TeamResponse:
            events.append("inventory")
            listing.set()
            release.wait(5)
            return _inventory("a")

        def action() -> team.TeamResponse:
            events.append(name)
            return outcome

        with mock.patch.object(team, "list_teams", side_effect=inventory):
            reorderer = threading.Thread(target=team_order.reorder, args=(["a"],))
            reorderer.start()
            self.assertTrue(listing.wait(5))
            mutator = threading.Thread(target=run, args=(action,))
            mutator.start()
            time.sleep(0.05)
            self.assertEqual(events, ["inventory"])
            release.set()
            reorderer.join(5)
            mutator.join(5)
        self.assertEqual(events, ["inventory", name])

    def reset_refused(self, owner: int) -> None:
        reset = team.TeamResponse(200, {"reset": True})
        with (
            mock.patch.object(team_order.os, "geteuid", return_value=owner),
            self.assertLogs("shimpz-admin", "ERROR"),
        ):
            response = self.admin_app._space_reset_with_history(lambda: reset)
        self.assertEqual((response.status, response.body["code"]), (503, "team-order-cleanup-incomplete"))

    def test_space_reset_preserves_a_foreign_order_and_temporary_file(self) -> None:
        leftover = self.root / ".team-order.json.abcd1234.tmp"
        self.saved("a")
        leftover.write_bytes(b"{}")
        self.reset_refused(os.geteuid() + 1)
        self.assertEqual((team_order.load(), leftover.read_bytes()), (["a"], b"{}"))

    def test_space_reset_preserves_a_fifo_or_symlink_and_still_removes_its_own_files(self) -> None:
        leftover = self.root / ".team-order.json.abcd1234.tmp"
        target = self.root / "elsewhere.json"
        target.write_bytes(b'{"team_ids":["a"]}')
        for unsafe in ("fifo", "symlink"):
            with self.subTest(unsafe=unsafe):
                if unsafe == "fifo":
                    os.mkfifo(self.path, 0o600)
                else:
                    self.path.symlink_to(target)
                leftover.write_bytes(b"{}")
                self.reset_refused(os.geteuid())
                self.assertEqual(self.path.is_symlink(), unsafe == "symlink")
                self.assertTrue(os.path.lexists(self.path))
                self.assertFalse(leftover.exists())
                self.path.unlink()
        self.assertEqual(target.read_bytes(), b'{"team_ids":["a"]}')

    def test_an_entry_that_cannot_be_inspected_is_never_removed(self) -> None:
        parent = self.root / "file"
        parent.write_bytes(b"")
        with self.assertRaises(team_order.OrderUnavailableError):
            team_order._unlink_owned(parent / "team-order.json")
        self.assertTrue(parent.exists())

    def test_deletion_waits_for_a_reorder_in_progress(self) -> None:
        deleted = team.TeamResponse(200, {"deleted": True})
        self.assert_waits_for_a_reorder(
            "delete", lambda action: self.admin_app._team_delete_with_history("a", action), deleted
        )
        # The deletion ran after the save, so the deleted Team's position does not survive it.
        self.assertEqual(team_order.load(), [])

    def test_reset_waits_for_a_reorder_in_progress(self) -> None:
        self.assert_waits_for_a_reorder(
            "reset", self.admin_app._space_reset_with_history, team.TeamResponse(200, {"reset": True})
        )
        # The reset ran after the save, so no saved order survives it.
        self.assertFalse(self.path.exists())

    def test_the_local_list_route_projects_and_the_hosted_one_passes_through(self) -> None:
        self.saved("a")
        with mock.patch.object(team, "list_teams", return_value=_inventory("b", "a")):
            response = self.admin_app.teams_list()
        self.assertEqual(json.loads(response.body)["teams"], _teams("b", "a"))
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        passthrough = team.TeamResponse(200, {"teams": [], "owner": "account"})
        with (
            mock.patch.object(self.admin_app, "ADMIN_PROFILE", "hosted"),
            mock.patch.object(team, "list_teams", return_value=passthrough),
        ):
            response = self.admin_app.teams_list()
        self.assertEqual(json.loads(response.body), passthrough.body)


def _team(method: str, path: str, _body: bytes) -> tuple[int, bytes]:
    """A Local Team with two Teams, newest first."""
    if (method, path) != ("GET", "/v1/teams"):
        return 404, b'{"detail":"unexpected"}'
    return 200, json.dumps({"teams": _teams("b", "a")}).encode()


class TeamOrderStackTests(_LiveTeamCase):
    """The real ASGI stack: the Supervisor session gate, the Origin check, and the Team bridge."""

    def test_reorder_requires_a_session_and_an_admitted_origin_and_every_answer_is_no_store(self) -> None:
        _TeamHandler.responder = staticmethod(_team)
        order_path = self.root / "team-order.json"
        with mock.patch.dict(os.environ, {"SHIMPZ_TEAM_ORDER_STORE": str(order_path)}):
            document = self._run_asgi_probe("team-order", Path(__file__).resolve())
        self.assertEqual(document["anonymous_list"], [401, "no-store"])
        self.assertEqual(document["anonymous_reorder"], [401, "no-store"])
        self.assertEqual(document["no_origin"], [403, "no-store"])
        self.assertEqual(document["newest_first"], [200, "no-store", ["b", "a"]])
        self.assertEqual(document["reordered"], [200, "no-store", ["a", "b"]])
        self.assertEqual(document["saved_order"], [200, "no-store", ["a", "b"]])
        self.assertEqual(document["stale"], [409, "no-store", None])
        self.assertEqual(json.loads(order_path.read_bytes()), {"team_ids": ["a", "b"]})
        self.assertEqual(order_path.stat().st_mode & 0o777, 0o600)


def _run_asgi_probe() -> None:
    admin_app, token = _probe_session()
    origin = sorted(admin_app._allowed_browser_origins())[0]

    async def send(method: str, path: str, body: bytes = b"", *, session: bool = True, sent_origin: bool = True):
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
        if session:
            headers.append((b"cookie", f"{admin_app.COOKIE}={token}".encode()))
        if sent_origin:
            headers.append((b"origin", origin.encode()))
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.5"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        }
        delivered = False

        async def receive():
            nonlocal delivered
            if delivered:
                await asyncio.Event().wait()
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        messages = []

        async def respond(message):
            messages.append(message)

        await asyncio.wait_for(admin_app.app(scope, receive, respond), timeout=5)
        start = next(message for message in messages if message["type"] == "http.response.start")
        response_headers = {name.decode().lower(): value.decode() for name, value in start["headers"]}
        payload = json.loads(b"".join(message.get("body", b"") for message in messages) or b"{}")
        teams = [item["team_id"] for item in payload["teams"]] if "teams" in payload else None
        return [start["status"], response_headers.get("cache-control"), teams]

    async def scenario() -> dict[str, object]:
        reorder = b'{"team_ids":["a","b"]}'
        return {
            "anonymous_list": (await send("GET", "/api/teams", session=False))[:2],
            "anonymous_reorder": (await send("PUT", "/api/teams/order", reorder, session=False))[:2],
            "no_origin": (await send("PUT", "/api/teams/order", reorder, sent_origin=False))[:2],
            "newest_first": await send("GET", "/api/teams"),
            "reordered": await send("PUT", "/api/teams/order", reorder),
            "saved_order": await send("GET", "/api/teams"),
            "stale": await send("PUT", "/api/teams/order", b'{"team_ids":["a"]}'),
        }

    print(json.dumps(asyncio.run(scenario())))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--asgi-probe":
        _run_asgi_probe()
    else:
        unittest.main()
