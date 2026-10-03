"""Admin runs Team Routines as its own machine identity and delivers their outcomes (ADR-0086)."""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import models
import state
import supervisor
from history import store as history
from team import bridge as team_bridge
from team import transport

from protocol.http.v1 import supervisor as contract
from routine import delivery, scheduler, team

VECTORS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())["routine_views"]
# Team's exact healthy-rollup delivery sequences and the transcript rows Admin must end with (ADR-0092 section 9).
ROLLUPS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())["routine_rollup_delivery"]
BATCH = VECTORS["notice_batch"]["valid"][0]
CLAIM = VECTORS["claim"]["valid"][1]["run"]
CLAIMED = {"run": CLAIM, "next_due_at": None}
IDLE = {"run": None, "next_due_at": None}
TRACE = "a" * 32


def _decode(encoded: str) -> bytes:
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))


def answer(body: dict[str, object], status: int = 200) -> team_bridge.TeamResponse:
    return team_bridge.TeamResponse(status, {**body, "trace_id": TRACE})


class RoutineIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        keys = Path(temporary.name) / "keys"
        keys.mkdir(mode=0o2770)
        keys.chmod(0o2770)
        self.routine_key = keys / "routine.pem"
        for patch in (
            mock.patch.object(supervisor, "PUBLIC_KEY_FILE", keys / "public.pem"),
            mock.patch.object(supervisor, "ROUTINE_PUBLIC_KEY_FILE", self.routine_key),
            mock.patch.object(supervisor.grp, "getgrnam", return_value=types.SimpleNamespace(gr_gid=os.getgid())),
            mock.patch.object(state, "STORE_PATH", Path(temporary.name) / "admin.json"),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def test_the_routine_identity_exists_only_beside_the_supervisor_and_stays_stable(self) -> None:
        with self.assertRaises(supervisor.SupervisorAuthorityError):
            state.local_routine_identity()
        identity = supervisor.new_identity()
        state._write({"supervisor_id": identity.supervisor_id, "supervisor_signing_key": identity.private_key_hex})
        routine = state.local_routine_identity()
        self.assertNotEqual(routine.private_key_hex, identity.private_key_hex)
        self.assertEqual(state.local_routine_identity(), routine)
        self.assertEqual(state.local_supervisor(), identity)
        supervisor.materialize_routine_key(routine)
        self.assertEqual(self.routine_key.stat().st_mode & 0o777, 0o440)
        self.assertNotIn(routine.private_key_hex.encode(), self.routine_key.read_bytes())
        self.assertFalse((self.routine_key.parent / "public.pem").exists())

    def test_a_routine_assertion_is_bound_to_its_lease_and_request_and_never_to_a_person(self) -> None:
        identity = supervisor.new_identity()
        request = supervisor.RequestBinding(
            method="POST",
            path="/v1/teams/team_1/routines/runs/" + "b" * 32 + "/segment",
            body=supervisor.json_body(b"{}"),
            model=supervisor.model_binding(("openai", "sk-test-0123456789")),
        )
        token = supervisor.sign_routine_request(identity, "lease-token", request=request, now=2_200_000_000)
        header, payload, signature = token.split(".")
        self.assertEqual(json.loads(_decode(header)), contract.ROUTINE_JWT_HEADER)
        claims = json.loads(_decode(payload))
        self.assertEqual(contract.canonical_claims(claims, audience=contract.ROUTINE_AUDIENCE), claims)
        self.assertEqual((claims["aud"], claims["authority"]), (contract.ROUTINE_AUDIENCE, contract.ROUTINE_AUTHORITY))
        self.assertEqual(claims["authority_sha256"], __import__("hashlib").sha256(b"lease-token").hexdigest())
        public = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(identity.private_key_hex)).public_key()
        public.verify(_decode(signature), f"{header}.{payload}".encode("ascii"))
        with self.assertRaises(supervisor.SupervisorAuthorityError):
            supervisor.sign_routine_request(
                identity,
                "lease-token",
                request=supervisor.RequestBinding(
                    "POST", "/x", supervisor.empty_body(), None, {"kind": "auth:password"}
                ),
            )

    def test_the_run_segment_carries_only_the_routine_assertion_even_inside_a_session(self) -> None:
        identity = supervisor.new_identity()
        session = "v1:9999999999:0123456789abcdef:" + "a" * 64
        bindings = transport._RequestBindings(
            model_credential=("openai", "sk-test-0123456789"), routine=(supervisor.new_identity(), "lease-token")
        )
        with (
            mock.patch.object(transport, "_team_token", return_value="machine-bearer"),
            transport.supervisor_session(session, account=False, local_identity=identity),
        ):
            headers = transport._request_headers(
                "POST",
                "/v1/x",
                b"{}",
                accept="application/x-ndjson",
                content_type="application/json",
                filename=None,
                bindings=bindings,
            )
            plain = transport._request_headers(
                "POST",
                "/v1/x",
                b"{}",
                accept="application/json",
                content_type="application/json",
                filename=None,
                bindings=transport._NO_BINDINGS,
            )
        self.assertIn(contract.ROUTINE_ASSERTION_HEADER, headers)
        self.assertNotIn(contract.ASSERTION_HEADER, headers)
        self.assertIn(contract.ASSERTION_HEADER, plain)
        self.assertNotIn(contract.ROUTINE_ASSERTION_HEADER, plain)
        claims = json.loads(_decode(headers[contract.ROUTINE_ASSERTION_HEADER].split(".")[1]))
        self.assertEqual(claims["model"]["provider"], "openai")


class RoutineHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "chat-history.sqlite3"
        patch = mock.patch.object(history, "STORE_PATH", self.path)
        patch.start()
        self.addCleanup(patch.stop)

    def test_one_row_per_run_that_a_newer_version_replaces_at_the_end(self) -> None:
        done, skipped, frozen = BATCH["notices"]
        self.assertTrue(
            history.append_routine_notice(
                {**frozen, "run_id": done["run_id"], "notice_id": done["notice_id"], "version": 1}
            )
        )
        self.assertTrue(history.append_routine_notice(skipped))
        self.assertTrue(history.append_routine_notice(done))
        # An equal version is idempotent; an older one is already superseded; a conflicting equal one is refused.
        self.assertTrue(history.append_routine_notice(done))
        self.assertTrue(
            history.append_routine_notice(
                {**frozen, "run_id": done["run_id"], "notice_id": done["notice_id"], "version": 1}
            )
        )
        self.assertFalse(history.append_routine_notice({**done, "detail": {"actions": [["shimpz-cloudflare", "x"]]}}))
        entries = history.page("team_1")["entries"]
        self.assertEqual([entry["outcome"] for entry in entries], ["skipped", "done"])
        self.assertEqual(entries[-1]["id"], f"{done['notice_id']}:routine")
        self.assertEqual(entries[-1]["quote"], done["quote"])
        # A notice's row time is its own instant, never the moment Admin wrote it.
        self.assertEqual([entry["created_at"] for entry in entries], [skipped["created_at"], done["created_at"]])
        with sqlite3.connect(self.path) as database:
            database.execute(
                "UPDATE transcript SET created_at = ? WHERE event_key = ?",
                ("2000-01-01T00:00:00Z", f"{done['notice_id']}:routine"),
            )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("team_1")
        with sqlite3.connect(self.path) as database:
            database.execute(
                "UPDATE transcript SET created_at = ? WHERE event_key = ?",
                (done["created_at"], f"{done['notice_id']}:routine"),
            )
        turn = history.new_turn_id()
        self.assertTrue(history.append_user("team_1", turn, "Hello"))
        self.assertEqual(history.conversation("team_1", turn), ())
        with self.assertRaises(ValueError):
            history.append_routine_notice({**done, "outcome": "run"})
        with sqlite3.connect(self.path) as database:
            database.execute(
                "UPDATE transcript SET payload = ? WHERE event_key = ?",
                (
                    json.dumps({"kind": "routine-run", **{k: done[k] for k in history._NOTICE_FIELDS}, "extra": 1}),
                    f"{done['notice_id']}:routine",
                ),
            )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("team_1")
        with sqlite3.connect(self.path) as database:
            stored = {"kind": "routine-run", **{name: done[name] for name in history._NOTICE_FIELDS}, "outcome": "run"}
            database.execute(
                "UPDATE transcript SET payload = ? WHERE event_key = ?",
                (json.dumps(stored), f"{done['notice_id']}:routine"),
            )
        with self.assertRaises(history.HistoryUnavailableError):
            history.page("team_1")


class RoutineTeamCallTests(unittest.TestCase):
    def test_calls_admit_only_closed_answers(self) -> None:
        # A claim holds no model key: a healthy compiled run needs none.
        with (
            mock.patch.object(models, "resolve_api_key") as resolve,
            mock.patch.object(transport, "_call", return_value=answer(CLAIMED)) as call,
        ):
            self.assertEqual(team.claim(), CLAIMED)
        call.assert_called_once_with("POST", "/v1/routines/claim", {})
        resolve.assert_not_called()
        hinted = {"run": None, "next_due_at": 1790000300}
        with mock.patch.object(transport, "_call", return_value=answer(hinted)):
            self.assertEqual(team.claim(), hinted)
        with mock.patch.object(transport, "_call", return_value=answer(BATCH)):
            self.assertEqual(team.notices(), BATCH)
        with mock.patch.object(transport, "_call", return_value=answer({"acknowledged": True})) as call:
            team.acknowledge(BATCH["notices"])
        self.assertEqual(
            call.call_args.args[2]["deliveries"][0],
            {"team_id": "team_1", "notice_id": BATCH["notices"][0]["notice_id"], "version": 2},
        )
        for response, action in (
            (answer({**CLAIMED, "run": {**CLAIM, "provider": "other"}}), lambda: team.claim()),
            (answer({"run": None}), lambda: team.claim()),
            (answer({"notices": [], "more": True}), team.notices),
            (answer({"acknowledged": False}), lambda: team.acknowledge(BATCH["notices"])),
            (team_bridge.TeamResponse(200, IDLE), lambda: team.claim()),
            (answer({"code": "x"}, 503), team.notices),
            (team_bridge.TeamResponse(200, ["not", "an", "object"]), team.notices),
        ):
            with (
                self.subTest(response=response),
                mock.patch.object(transport, "_call", return_value=response),
                self.assertRaises(team.RoutineTeamError),
            ):
                action()

    def test_an_acknowledgment_is_split_to_fit_team_and_the_request_bound(self) -> None:
        # Ten Teams with thirty notices each: one 300-delivery acknowledgment would exceed both bounds.
        delivered = [
            {"team_id": f"team_{index // 30:02d}", "notice_id": f"{index:032x}", "version": 1} for index in range(300)
        ]
        self.assertGreater(len(json.dumps({"deliveries": delivered}, separators=(",", ":"))), 16 * 1024)
        acknowledged = answer({"acknowledged": True})
        with mock.patch.object(transport, "_call", return_value=acknowledged) as call:
            team.acknowledge([{**item, "outcome": "done"} for item in delivered])
        bodies = [request.args[2] for request in call.call_args_list]
        self.assertGreater(len(bodies), 1)
        for body in bodies:
            self.assertLessEqual(len(body["deliveries"]), team.MAX_ACK_DELIVERIES)
            self.assertLessEqual(len(transport._encode_payload(body)), transport.MAX_JSON_BODY_BYTES)
        self.assertEqual([item for body in bodies for item in body["deliveries"]], delivered)
        # Deliveries small enough to reach Team's count bound before the byte bound are split by count.
        small = [{"team_id": "t", "notice_id": str(index), "version": 1} for index in range(300)]
        with mock.patch.object(transport, "_call", return_value=acknowledged) as call:
            team.acknowledge(small)
        self.assertEqual([len(request.args[2]["deliveries"]) for request in call.call_args_list], [256, 44])
        with mock.patch.object(transport, "_call", return_value=acknowledged) as call:
            team.acknowledge([])
        call.assert_not_called()
        # A failed acknowledgment is reported and ends the rest; the acknowledged part stays acknowledged.
        many = [{"team_id": "team_1", "notice_id": f"{index:032x}", "version": 1} for index in range(700)]
        failed = answer({"code": "x"}, 503)
        with (
            mock.patch.object(transport, "_call", side_effect=[acknowledged, failed, acknowledged]) as call,
            self.assertRaises(team.RoutineTeamError),
        ):
            team.acknowledge(many)
        self.assertEqual(call.call_count, 2)

    def test_a_run_segment_is_signed_for_its_own_lease_and_answers_its_own_run(self) -> None:
        identity = supervisor.new_identity()
        done = answer({"team_id": CLAIM["team_id"], "run_id": CLAIM["run_id"], "status": "done"})
        with (
            mock.patch.object(models, "resolve_api_key", return_value="sk-test-0123456789"),
            mock.patch.object(transport, "_call_stream", return_value=done) as stream,
        ):
            self.assertEqual(team.run(CLAIM, identity), "done")
        bindings = stream.call_args.kwargs["bindings"]
        self.assertEqual(bindings.routine, (identity, CLAIM["lease_token"]))
        # The signed segment names exactly the revision, plan, and mode the claim leased.
        self.assertEqual(
            stream.call_args.args[2],
            {"revision": CLAIM["revision"], "plan_digest": CLAIM["plan_digest"], "mode": CLAIM["mode"]},
        )
        self.assertEqual(bindings.model_credential, ("openai", "sk-test-0123456789"))
        self.assertEqual(stream.call_args.args[1], f"/v1/teams/team_1/routines/runs/{CLAIM['run_id']}/segment")
        stream.call_args.kwargs["progress"]({"type": "progress"})
        # Without a key the segment still runs, carrying no model credential; Team pauses a recovery it then needs.
        with (
            mock.patch.object(models, "resolve_api_key", return_value=None),
            mock.patch.object(transport, "_call_stream", return_value=done) as stream,
        ):
            self.assertEqual(team.run(CLAIM, identity), "done")
        self.assertIsNone(stream.call_args.kwargs["bindings"].model_credential)
        for key, response in (
            ("sk-test-0123456789", answer({"team_id": "team_2", "run_id": CLAIM["run_id"], "status": "done"})),
            ("sk-test-0123456789", answer({"team_id": "team_1", "run_id": CLAIM["run_id"], "status": "running"})),
        ):
            with (
                self.subTest(response=response),
                mock.patch.object(models, "resolve_api_key", return_value=key),
                mock.patch.object(transport, "_call_stream", return_value=response),
                self.assertRaises(team.RoutineTeamError),
            ):
                team.run(CLAIM, identity)


class RoutineRollupDeliveryTests(unittest.TestCase):
    def test_teams_rollup_sequences_end_with_exactly_their_pinned_transcript_rows(self) -> None:
        for name, case in ROLLUPS.items():
            with tempfile.TemporaryDirectory() as directory, self.subTest(case=name):
                acknowledged: list[dict[str, object]] = []
                batches = [{"notices": batch, "more": False} for batch in case["deliveries"]]
                with (
                    mock.patch.object(history, "STORE_PATH", Path(directory) / "chat-history.sqlite3"),
                    mock.patch.object(team, "notices", side_effect=batches),
                    mock.patch.object(team, "acknowledge", side_effect=acknowledged.extend),
                ):
                    # Each delivery goes through the real transcript write before its exact versions are acknowledged.
                    written = [delivery.deliver() for _batch in batches]
                    entries = history.page("team_1")["entries"]
                self.assertEqual(written, [len(batch) for batch in case["deliveries"]])
                self.assertEqual(acknowledged, [item for batch in case["deliveries"] for item in batch])
                rows = [
                    [entry["id"].removesuffix(":routine"), entry["version"], entry["detail"]["runs"]]
                    for entry in entries
                    if entry["outcome"] == "healthy"
                ]
                self.assertEqual(rows, case["transcript"])


class RoutineDeliveryTests(unittest.TestCase):
    def test_every_batch_is_written_before_it_is_acknowledged(self) -> None:
        events: list[str] = []
        batches = [{"notices": BATCH["notices"][:1], "more": True}, {"notices": BATCH["notices"][1:], "more": False}]
        with (
            mock.patch.object(team, "notices", side_effect=batches),
            mock.patch.object(
                history, "append_routine_notice", side_effect=lambda notice: events.append("write") or True
            ),
            mock.patch.object(team, "acknowledge", side_effect=lambda items: events.append(f"ack{len(items)}")),
        ):
            self.assertEqual(delivery.deliver(), 3)
        self.assertEqual(events, ["write", "ack1", "write", "write", "ack2"])
        with mock.patch.object(team, "notices", return_value={"notices": [], "more": False}):
            self.assertEqual(delivery.deliver(), 0)
        with (
            mock.patch.object(team, "notices", return_value={"notices": BATCH["notices"][:1], "more": True}),
            mock.patch.object(history, "append_routine_notice", return_value=True),
            mock.patch.object(team, "acknowledge") as acknowledge,
        ):
            self.assertEqual(delivery.deliver(), delivery.MAX_BATCHES)
        self.assertEqual(acknowledge.call_count, delivery.MAX_BATCHES)
        with (
            mock.patch.object(team, "notices", return_value=BATCH),
            mock.patch.object(history, "append_routine_notice", return_value=False),
            mock.patch.object(team, "acknowledge") as acknowledge,
            self.assertRaises(history.HistoryUnavailableError),
        ):
            delivery.deliver()
        acknowledge.assert_not_called()


class RoutineLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        patch = mock.patch.object(history, "STORE_PATH", Path(temporary.name) / "chat-history.sqlite3")
        patch.start()
        self.addCleanup(patch.stop)

    def test_a_notice_read_before_a_team_is_deleted_never_outlives_its_history(self) -> None:
        from history import http as history_http

        deleting = threading.Event()
        deleted = threading.Event()
        done = BATCH["notices"][0]

        def destroy():
            deleting.set()
            # Team removes the Team's notices with the Team, so a later read returns none.
            deleted.wait(5)
            return team_bridge.TeamResponse(200, {"deleted": True})

        def notices():
            return {"notices": [] if deleted.is_set() else [done], "more": False}

        worker = threading.Thread(target=history_http.team_delete, args=("team_1", destroy))
        with mock.patch.object(team, "notices", side_effect=notices), mock.patch.object(team, "acknowledge"):
            worker.start()
            self.assertTrue(deleting.wait(5))
            delivered: list[int] = []
            deliverer = threading.Thread(target=lambda: delivered.append(delivery.deliver()))
            deliverer.start()
            deliverer.join(0.2)
            # Delivery waits for the deletion and its transcript cleanup to finish.
            self.assertTrue(deliverer.is_alive())
            deleted.set()
            worker.join(5)
            deliverer.join(5)
        self.assertEqual(delivered, [0])
        self.assertEqual(history.page("team_1")["entries"], [])


class RoutineSchedulerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.identity = supervisor.new_identity()
        for patch in (
            mock.patch.object(state, "local_routine_identity", return_value=self.identity),
            mock.patch.object(supervisor, "materialize_routine_key"),
            mock.patch.object(delivery, "deliver", return_value=0),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_lane_slot_is_reserved_before_a_claim_and_freed_when_the_run_ends(self) -> None:
        release = threading.Event()
        ran: list[dict[str, object]] = []

        def run(claimed, identity):
            ran.append(claimed)
            self.assertIs(identity, self.identity)
            release.wait(5)
            return "done"

        runner = scheduler.RoutineScheduler(workers=1)
        self.addCleanup(runner.close)
        with (
            mock.patch.object(team, "claim", return_value=CLAIMED) as claim,
            mock.patch.object(team, "run", side_effect=run),
        ):
            runner.tick()
            runner.tick()
            # The only slot is busy, so the second tick claims nothing.
            self.assertEqual(claim.call_count, 1)
            release.set()
            deadline = time.monotonic() + 5
            while not runner._slots.acquire(blocking=False):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            runner._slots.release()
        self.assertEqual(ran, [CLAIM])

    def test_failures_wait_for_the_next_tick_and_never_hold_a_slot(self) -> None:
        runner = scheduler.RoutineScheduler(workers=1)
        self.addCleanup(runner.close)
        with (
            mock.patch.object(delivery, "deliver", side_effect=history.HistoryUnavailableError("down")),
            mock.patch.object(team, "claim", side_effect=team.RoutineTeamError("down")),
            self.assertLogs("shimpz.admin.routine", level="WARNING") as logged,
        ):
            runner.tick()
        self.assertEqual(len(logged.output), 2)
        with mock.patch.object(team, "claim", return_value=IDLE):
            runner.tick()
        failed = threading.Event()
        with (
            mock.patch.object(team, "claim", return_value=CLAIMED),
            mock.patch.object(
                team,
                "run",
                side_effect=lambda *_args: failed.set() or (_ for _ in ()).throw(team.RoutineTeamError("x")),
            ),
        ):
            runner.tick()
            self.assertTrue(failed.wait(5))
        deadline = time.monotonic() + 5
        while not runner._slots.acquire(blocking=False):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)

    def test_a_hint_or_a_finished_run_wakes_the_next_tick_sooner_but_never_in_a_tight_loop(self) -> None:
        runner = scheduler.RoutineScheduler(interval=30, jitter=0)
        self.addCleanup(runner.close)
        self.assertEqual(runner.delay(1000.0), 30)
        with mock.patch.object(team, "claim", return_value={"run": None, "next_due_at": 1010}):
            runner.tick()
        self.assertEqual(runner.delay(1000.0), 10)
        # A hint already due waits the minimum, never zero; one beyond the interval waits the interval.
        self.assertEqual(runner.delay(1020.0), scheduler.MIN_WAKE_SECONDS)
        with mock.patch.object(team, "claim", return_value={"run": None, "next_due_at": 9999}):
            runner.tick()
        self.assertEqual(runner.delay(1000.0), 30)
        with mock.patch.object(team, "claim", return_value=IDLE):
            runner.tick()
        self.assertEqual(runner.delay(1000.0), 30)
        finished, gate = threading.Event(), threading.Event()
        with (
            mock.patch.object(team, "claim", side_effect=[CLAIMED, IDLE]),
            mock.patch.object(team, "run", side_effect=lambda *_args: gate.wait(5) and (finished.set() or "done")),
        ):
            runner.tick()
            gate.set()
            self.assertTrue(finished.wait(5))
            self.assertTrue(runner._wake.wait(5))
        self.assertEqual(runner.delay(time.time() + 60), scheduler.MIN_WAKE_SECONDS)

    def test_a_rodar_wake_claims_at_once_instead_of_waiting_for_the_interval(self) -> None:
        runner = scheduler.RoutineScheduler(interval=30, jitter=0)
        self.addCleanup(runner.close)
        self.assertEqual(runner.delay(time.time()), 30)
        runner.wake()
        self.assertTrue(runner._wake.is_set())
        # The Routine is due now, so the next tick waits only the minimum, never the reconciliation interval.
        self.assertEqual(runner.delay(time.time()), scheduler.MIN_WAKE_SECONDS)

    def test_one_wake_fills_every_free_slot_and_keeps_teams_hint_once_nothing_more_starts(self) -> None:
        short = {**CLAIM, "team_id": "team_1", "run_id": "1" * 32}
        long = {**CLAIM, "team_id": "team_2", "run_id": "2" * 32}
        gates = {short["run_id"]: threading.Event(), long["run_id"]: threading.Event()}
        ended = threading.Event()

        def run(claimed, _identity):
            gates[claimed["run_id"]].wait(5)
            if claimed["run_id"] == short["run_id"]:
                ended.set()
            return "done"

        runner = scheduler.RoutineScheduler(interval=30, jitter=0, workers=2)
        self.addCleanup(runner.close)
        self.addCleanup(lambda: [gate.set() for gate in gates.values()])
        claims = [{"run": short, "next_due_at": None}, {"run": long, "next_due_at": 1005}]
        with (
            mock.patch.object(team, "claim", side_effect=claims) as claim,
            mock.patch.object(team, "run", side_effect=run),
        ):
            runner.tick()
            # Both Teams start on one wake; with every slot busy nothing more is claimed and no stale hint polls.
            self.assertEqual(claim.call_count, 2)
            self.assertEqual(runner.delay(1000.0), 30)
            runner.tick()
            self.assertEqual(claim.call_count, 2)
            gates[short["run_id"]].set()
            self.assertTrue(ended.wait(5))
            self.assertTrue(runner._wake.wait(5))
        # The short Team's slot is free while the long Team runs on: the next claim's hint is kept.
        with mock.patch.object(team, "claim", return_value={"run": None, "next_due_at": 1005}) as claim:
            runner.tick()
        claim.assert_called_once()
        self.assertEqual(runner.delay(1000.0), 5)

    def test_the_thread_ticks_until_closed_and_survives_any_failure(self) -> None:
        runner = scheduler.RoutineScheduler(interval=0.01, jitter=0.001)
        ticks: list[int] = []
        again = threading.Event()

        def tick():
            ticks.append(1)
            if len(ticks) == 1:
                raise RuntimeError("the credential store is unreadable")
            again.set()

        with (
            mock.patch.object(runner, "tick", side_effect=tick),
            self.assertLogs("shimpz.admin.routine", level="ERROR"),
        ):
            runner.start()
            self.assertTrue(again.wait(5))
            runner.close()
        self.assertFalse(runner._thread.is_alive())


if __name__ == "__main__":
    unittest.main()
