"""Bounded edges of the Admin session socket's parts: budgets, queue, registry, calls, timers, and the watcher."""

import asyncio
import contextlib
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi import HTTPException
from session import budget, calls, lane, methods, outbound, registry, socket, topics, watcher
from signin import audit, auth, local_auth


def _gate(**overrides) -> socket.Gate:
    async def current(_cookies) -> bool:
        return True

    values = {
        "session_current": current,
        "renew_session": current,
        "allowed_origins": lambda: frozenset({"http://localhost:7777"}),
        "request_scope": lambda _cookies: contextlib.nullcontext(),
        "session_deadlines": lambda _cookies: (60.0, 600.0),
        "authenticate": mock.AsyncMock(),
        "recheck_password": mock.AsyncMock(),
        "confirmations": local_auth.Context(),
        "cookie": "shimpz_admin",
    }
    return socket.Gate(**{**values, **overrides})


def _socket(gate: socket.Gate) -> socket.SessionSocket:
    websocket = types.SimpleNamespace(cookies={"shimpz_admin": "token"})
    return socket.SessionSocket(websocket, gate, "http://localhost:7777", "s" * 64)


class SessionPartsTests(unittest.TestCase):
    def test_a_socket_that_closes_while_its_check_comes_back_is_not_current(self) -> None:
        async def scenario() -> bool:
            closed = asyncio.Event()

            async def authorized() -> bool:
                # The check passes, and the socket closes before the worker reads the answer.
                closed.set()
                return True

            socket = types.SimpleNamespace(authorized=authorized, loop=asyncio.get_running_loop(), closed=closed)
            return await asyncio.to_thread(lane.current, socket)

        self.assertFalse(asyncio.run(scenario()))

    def test_a_budget_forgets_events_and_sessions_older_than_its_minute(self) -> None:
        now = [0.0]
        limited = budget.SessionBudget(1, clock=lambda: now[0])
        self.assertTrue(limited.admit("a"))
        self.assertFalse(limited.admit("a"))
        now[0] = budget.WINDOW_SECONDS - 1
        self.assertTrue(limited.admit("b"))
        now[0] = budget.WINDOW_SECONDS
        # A's minute passed: its spent event is forgotten, and so is the session once nothing remains.
        self.assertTrue(limited.admit("a"))
        now[0] = 2 * budget.WINDOW_SECONDS
        self.assertTrue(limited.admit("c"))
        self.assertEqual(set(limited._events), {"c"})
        # Within one session, only the events older than a minute leave its window.
        pair = budget.SessionBudget(2, clock=lambda: now[0])
        now[0] = 0.0
        self.assertTrue(pair.admit("a"))
        now[0] = 30.0
        self.assertTrue(pair.admit("a"))
        self.assertFalse(pair.admit("a"))
        now[0] = budget.WINDOW_SECONDS + 1
        self.assertTrue(pair.admit("a"))
        self.assertFalse(pair.admit("a"))

    def test_a_closed_queue_refuses_every_frame(self) -> None:
        queue = outbound.Outbound()
        queue.closed = True
        with self.assertRaises(RuntimeError):
            queue.put("{}")

    def test_removing_a_socket_the_registry_never_held_changes_nothing(self) -> None:
        held = registry.Registry()
        handle = registry.Handle(
            "s", "a", {}, lambda _code: None, lambda _topic: False, mock.AsyncMock(), None, lambda: None
        )
        held.remove(handle)
        self.assertEqual(held.handles(), ())

    def test_only_a_closed_topic_grammar_changes(self) -> None:
        with self.assertRaises(ValueError):
            topics.changed("team/marketing/files")


class SessionCallEdgeTests(unittest.TestCase):
    def test_every_call_failure_is_answered_as_the_http_gate_would(self) -> None:
        async def scenario() -> None:
            session_socket = _socket(_gate())
            for failure, expected in (
                (auth.PasswordRecordError("bad"), (503, "password-recovery-required")),
                (audit.AuditUnavailableError("down"), (503, None)),
                (RuntimeError("unexpected"), (500, None)),
            ):

                async def failing(*_args, failure=failure):
                    raise failure

                with self.subTest(failure=failure), mock.patch.dict(methods.METHODS, {"teams.list": failing}):
                    if expected[0] == 500:
                        with self.assertLogs("shimpz-admin", "ERROR"):
                            status, body = await calls._dispatch(session_socket, "c1", "teams.list", {})
                    else:
                        status, body = await calls._dispatch(session_socket, "c1", "teams.list", {})
                self.assertEqual(status, expected[0])
                if expected[1] is not None:
                    self.assertEqual(body["code"], expected[1])

        asyncio.run(scenario())

    def test_a_result_for_a_socket_that_closed_meanwhile_is_dropped(self) -> None:
        async def answered(*_args):
            return 200, {}

        async def scenario() -> None:
            session_socket = _socket(_gate())
            session_socket.outbound.closed = True
            with mock.patch.dict(methods.METHODS, {"teams.list": answered}):
                await calls.run(session_socket, "c1", "teams.list", {})
            self.assertEqual(session_socket.outbound.queued, 0)

        asyncio.run(scenario())

    def test_a_waiting_call_whose_socket_is_refused_or_unchecked_never_runs(self) -> None:
        async def never(*_args):
            raise AssertionError("must not run")

        async def scenario() -> None:
            refused = _socket(_gate(session_current=mock.AsyncMock(return_value=False)))
            with mock.patch.dict(methods.METHODS, {"subscribe": never}):
                await calls.run(refused, "c1", "subscribe", {"topics": ["teams"]})
            self.assertEqual((refused.outbound.queued, refused.close_code), (0, socket.SIGNED_OUT))
            # A read checks its socket on the lane worker that runs it, and is never answered once refused there.
            unread = _socket(_gate(session_current=mock.AsyncMock(return_value=False)))
            with mock.patch.object(methods.team_order, "listing", side_effect=AssertionError("must not read")):
                await calls.run(unread, "c2", "teams.list", {})
            self.assertEqual((unread.outbound.queued, unread.close_code), (0, socket.SIGNED_OUT))
            # A lane worker whose check never answers closes its socket as unavailable instead of running.
            stalled = _socket(_gate())
            check = mock.Mock()
            check.result.side_effect = TimeoutError
            with (
                mock.patch.object(lane.asyncio, "run_coroutine_threadsafe", return_value=check) as scheduled,
                mock.patch.object(stalled, "end") as end,
            ):
                self.assertFalse(await asyncio.to_thread(lane.current, stalled))
            scheduled.call_args.args[0].close()
            check.cancel.assert_called_once_with()
            end.assert_called_once_with(lane.SOCKET_UNAVAILABLE)
            # A worker whose socket's loop already closed runs nothing, leaving no check behind.
            closed = _socket(_gate())
            with (
                mock.patch.object(lane.asyncio, "run_coroutine_threadsafe", side_effect=RuntimeError("closed")),
                mock.patch.object(closed, "authorized", new=mock.Mock(return_value=mock.Mock())) as authorized,
            ):
                self.assertFalse(await asyncio.to_thread(lane.current, closed))
            authorized.return_value.close.assert_called_once_with()
            # A timed-out check on a loop that closed meanwhile still refuses the read.
            with (
                mock.patch.object(lane.asyncio, "run_coroutine_threadsafe", return_value=check),
                mock.patch.object(stalled, "end", side_effect=RuntimeError("closed")),
            ):
                self.assertFalse(await asyncio.to_thread(lane.current, stalled))

        asyncio.run(scenario())


class SessionProgressTests(unittest.TestCase):
    def test_progress_reaches_the_page_only_for_a_call_still_running_on_an_open_socket(self) -> None:
        async def scenario() -> None:
            session_socket = _socket(_gate())
            session_socket.progress("gone")
            self.assertEqual(session_socket.outbound.queued, 0)
            session_socket.calls["c1"] = mock.Mock()
            session_socket.progress("c1")
            self.assertEqual(await session_socket.outbound.take(), '{"type":"progress","id":"c1","state":"running"}')
            session_socket._end(1000)
            session_socket.progress("c1")
            self.assertEqual(session_socket.outbound.queued, 0)

        asyncio.run(scenario())


class SessionSocketCheckTests(unittest.TestCase):
    def test_an_unreadable_origin_authority_closes_the_socket_as_unavailable(self) -> None:
        def unreadable():
            raise RuntimeError("store unreadable")

        async def scenario() -> None:
            session_socket = _socket(_gate(allowed_origins=unreadable))
            self.assertFalse(await session_socket._authorized())
            await asyncio.sleep(0)
            self.assertEqual(session_socket.close_code, socket.UNAVAILABLE)

        asyncio.run(scenario())

    def test_deadlines_the_session_cannot_tell_are_never_sent(self) -> None:
        def unreadable(_cookies):
            raise OSError("store unreadable")

        async def scenario() -> None:
            for deadlines in (unreadable, lambda _cookies: None):
                session_socket = _socket(_gate(session_deadlines=deadlines))
                session_socket._send_deadlines()
                self.assertEqual(session_socket.outbound.queued, 0)
            closed = _socket(_gate())
            closed._end(1000)
            closed._send_deadlines()
            self.assertEqual(closed.outbound.queued, 0)

        asyncio.run(scenario())

    def test_activity_the_session_can_no_longer_renew_closes_the_socket(self) -> None:
        async def scenario() -> None:
            for renew, code in (
                (mock.AsyncMock(return_value=False), socket.SIGNED_OUT),
                (mock.AsyncMock(side_effect=OSError), socket.UNAVAILABLE),
            ):
                session_socket = _socket(_gate(renew_session=renew))
                with (
                    mock.patch.object(budget, "RENEWALS", budget.SessionRenewals(30.0)),
                    mock.patch.object(budget, "CALL_BUDGET", budget.SessionBudget(10)),
                ):
                    await session_socket._activity({"type": "activity"})
                self.assertEqual(session_socket.close_code, code)

        asyncio.run(scenario())

    def test_a_change_that_lands_after_close_or_unsubscribe_sends_nothing(self) -> None:
        async def scenario() -> None:
            session_socket = _socket(_gate())
            session_socket.subscriptions.add("teams")
            session_socket.changed("teams", 1)
            session_socket.subscriptions.clear()
            await asyncio.sleep(0)
            self.assertEqual(session_socket.outbound.queued, 0)

        asyncio.run(scenario())

    def test_the_expiry_timer_rechecks_until_authority_ends_and_reads_an_unreadable_expiry_as_now(self) -> None:
        checks = []

        async def current(_cookies) -> bool:
            checks.append(True)
            return len(checks) < 3

        def remaining(_cookies):
            if len(checks) == 1:
                raise OSError("store unreadable")
            return (0.0, 60.0)

        async def scenario() -> None:
            session_socket = _socket(_gate(session_current=current, session_deadlines=remaining))
            await asyncio.wait_for(session_socket._expire(), timeout=2)
            await asyncio.sleep(0)
            self.assertEqual((len(checks), session_socket.close_code), (3, registry.SIGNED_OUT))
            # A closed socket's timer has nothing left to do.
            await asyncio.wait_for(session_socket._expire(), timeout=1)

        asyncio.run(scenario())


class SessionSocketServeTests(unittest.TestCase):
    def test_a_handshake_that_fails_to_accept_leaves_nothing_registered(self) -> None:
        websocket = mock.AsyncMock()
        websocket.cookies = {"shimpz_admin": "token"}
        websocket.accept.side_effect = RuntimeError("peer gone")

        async def scenario() -> None:
            with mock.patch.object(socket, "_admit", new=mock.AsyncMock(return_value=("http://localhost:7777", "s"))):
                await socket.serve(websocket, _gate())
            self.assertEqual(registry.REGISTRY.handles(), ())

        asyncio.run(scenario())


class WatcherReadTests(unittest.TestCase):
    def test_each_watched_read_projects_its_value(self) -> None:
        team = types.SimpleNamespace(status=200, body={"services_total": 1})
        with mock.patch.object(watcher.team, "space_resources", return_value=team):
            self.assertEqual(watcher._resources(), (200, {"services_total": 1}))
        listing = types.SimpleNamespace(status_code=200, body=b'{"teams":[]}')
        with mock.patch.object(watcher.team_order, "listing", return_value=listing):
            self.assertEqual(watcher._teams(), (200, {"teams": []}))
        with mock.patch.object(watcher.platform_release, "read_status", return_value={"ordinal": 1}):
            self.assertEqual(watcher._release(), {"ordinal": 1})
        with mock.patch.object(
            watcher.platform_release,
            "read_status",
            side_effect=watcher.platform_release.PlatformReleaseUnavailableError,
        ):
            self.assertIsNone(watcher._release())

    def test_a_failed_read_raises_nothing_and_is_retried_at_its_interval(self) -> None:
        def failing():
            raise HTTPException(400, "Team id is invalid")

        handle = registry.Handle(
            "s",
            "a",
            {},
            lambda _code: None,
            lambda _topic: True,
            mock.AsyncMock(return_value=True),
            contextlib.nullcontext,
            lambda: None,
        )
        watching = watcher.Watcher({"teams": watcher.Watched(60.0, failing)})

        async def scenario() -> None:
            with (
                mock.patch.object(watcher.registry.REGISTRY, "handles", return_value=(handle,)),
                mock.patch.object(watcher.topics, "changed") as changed,
                self.assertLogs("shimpz-admin", "WARNING"),
            ):
                await watching._check("teams", watching._watched["teams"])
            changed.assert_not_called()
            self.assertGreater(watching._due["teams"], 0)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
