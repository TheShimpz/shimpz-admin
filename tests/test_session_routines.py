"""A Team's Routines over the session socket keep exactly what their routes did (ADR-0114 tranche (c), ADR-0086).

Each method reaches the same Routine operation with the same arguments and answers what it answers; every change Admin
completes raises the Team's `routines` topic, also when the socket that asked closed meanwhile; an answer that makes a
Routine due wakes the scheduler; and a held run's resume is a long call that says once that it started, is answered by
chat's own Action-password authority, and never resumes once its socket closed.
"""

import asyncio
import json
import threading
import unittest
from unittest import mock

from tests.session_socket_case import SessionSocketCase

from tests import chat_socket_fixtures

ROUTINE = "c" * 32
RUN = "d" * 32
CHALLENGE = "b" * 32
OK = {"ok": True}
DENY = {"type": "human-response", "challenge_id": CHALLENGE, "decision": "deny"}


class RoutineMethodCase(SessionSocketCase):
    def setUp(self) -> None:
        super().setUp()
        self.manage = __import__("routine.manage", fromlist=["manage"])
        self.answer = __import__("routine.answer", fromlist=["answer"])
        self.routines = __import__("session.routines", fromlist=["routines"])
        self.ok = self.transport.TeamResponse(200, OK)
        # How a card was answered is kept in the transcript; these tests stand in for the history store.
        kept = mock.patch.object(self.routines.history_store, "append_proposal_answer", return_value=True)
        self.kept_answers = kept.start()
        self.addCleanup(kept.stop)

    def results(self, *calls: tuple[str, dict], topics: tuple[str, ...] = ()) -> tuple[list[dict], set[str]]:
        """Answer each call in order on one socket, returning its results and the topics raised meanwhile."""

        async def scenario() -> tuple[list[dict], set[str]]:
            websocket = await self._connect()
            if topics:
                await websocket.result("subscribe", {"topics": list(topics)})
            results, raised = [], set()
            for method, params in calls:
                call_id = await websocket.call(method, params)
                while (frame := await websocket.next_frame())["type"] != "result":
                    if frame["type"] == "changed":
                        raised.add(frame["topic"])
                    elif frame != {"type": "progress", "id": call_id, "state": "running"}:
                        raise AssertionError(frame)
                results.append(frame)
            while True:
                try:
                    raised.add((await websocket.next_frame(0.2))["topic"])
                except TimeoutError:
                    break
            await websocket.disconnect()
            return results, raised

        return asyncio.run(scenario())


class RoutineOperationTests(RoutineMethodCase):
    def test_each_method_reaches_its_routine_operation_with_its_arguments(self) -> None:
        chosen = {"tag": "e" * 64}
        cases = (
            ("routines.list", {"team_id": "team_1"}, "list_routines", ("team_1",)),
            ("routines.pause", {"team_id": "team_1", "routine_id": ROUTINE}, "pause", ("team_1", ROUTINE)),
            ("routines.resume", {"team_id": "team_1", "routine_id": ROUTINE}, "resume", ("team_1", ROUTINE)),
            ("routines.diagnostics", {"team_id": "team_1", "run_id": RUN}, "diagnostics", ("team_1", RUN)),
            (
                "routines.plan_steps",
                {"team_id": "team_1", "routine_id": ROUTINE, "revision": "2", "offset": "0"},
                "plan_steps",
                ("team_1", ROUTINE, "2", "0"),
            ),
            (
                "routines.run_steps",
                {"team_id": "team_1", "run_id": RUN, "snapshot": "latest", "offset": "0"},
                "run_steps",
                ("team_1", RUN, "latest", "0"),
            ),
            ("routines.card", {"team_id": "team_1", "run_id": ROUTINE}, "open_card", ("team_1", ROUTINE)),
            (
                "routines.card_answer",
                {"team_id": "team_1", "run_id": ROUTINE, "body": chosen},
                "answer_card",
                ("team_1", ROUTINE, chosen),
            ),
            (
                "routines.proposal_confirm",
                {"team_id": "team_1", "proposal_id": ROUTINE},
                "confirm_proposal",
                ("team_1", ROUTINE),
            ),
            (
                "routines.proposal_revoke",
                {"team_id": "team_1", "proposal_id": ROUTINE},
                "revoke_proposal",
                ("team_1", ROUTINE),
            ),
        )
        for method, params, operation, arguments in cases:
            with self.subTest(method=method), mock.patch.object(self.manage, operation, return_value=self.ok) as called:
                (result,), _raised = self.results((method, params))
            called.assert_called_once_with(*arguments)
            self.assertEqual((result["status"], result["body"]), (200, OK))
        with mock.patch.object(self.answer, "open_challenge", return_value=self.ok) as opened:
            (result,), raised = self.results(
                ("routines.challenge", {"team_id": "team_1", "run_id": RUN, "body": {"locale": "ja"}}),
                topics=("team/team_1/routines",),
            )
        opened.assert_called_once_with("team_1", RUN, {"locale": "ja"})
        # Opening a challenge changes nothing the Team's Routine list shows, so no page reads it again.
        self.assertEqual((result["status"], raised), (200, set()))

    def test_a_request_admin_refuses_before_team_is_the_pages_own_400(self) -> None:
        with mock.patch.object(self.transport, "call") as call:
            results, _raised = self.results(
                ("routines.pause", {"team_id": "team_1", "routine_id": "x"}),
                ("routines.plan_steps", {"team_id": "team_1", "routine_id": ROUTINE, "revision": "02", "offset": "0"}),
                ("routines.run_steps", {"team_id": "team_1", "run_id": RUN, "snapshot": "x", "offset": "0"}),
                ("routines.card_answer", {"team_id": "team_1", "run_id": ROUTINE, "body": {"tag": "x"}}),
                ("routines.challenge", {"team_id": "team_1", "run_id": RUN, "body": {"locale": "it"}}),
                ("routines.human", {"team_id": "team_1", "run_id": RUN, "body": {"type": "human-response"}}),
            )
        self.assertEqual([result["status"] for result in results], [400] * 6)
        self.assertEqual(results[-1]["body"], {"detail": "human response is invalid"})
        call.assert_not_called()

    def test_team_refusals_keep_their_safe_code(self) -> None:
        busy = self.transport.TeamResponse(409, {"code": "routine-busy"})
        with mock.patch.object(self.manage, "pause", return_value=busy):
            (result,), raised = self.results(
                ("routines.pause", {"team_id": "team_1", "routine_id": ROUTINE}), topics=("team/team_1/routines",)
            )
        self.assertEqual((result["status"], result["body"], raised), (409, {"code": "routine-busy"}, set()))


class RoutineTopicTests(RoutineMethodCase):
    def test_every_completed_change_raises_the_teams_routines_and_a_read_raises_none(self) -> None:
        topic = "team/team_1/routines"
        changes = {
            "routines.pause": ("pause", {"team_id": "team_1", "routine_id": ROUTINE}),
            "routines.resume": ("resume", {"team_id": "team_1", "routine_id": ROUTINE}),
            "routines.card_answer": (
                "answer_card",
                {"team_id": "team_1", "run_id": ROUTINE, "body": {"tag": "e" * 64}},
            ),
            "routines.proposal_confirm": ("confirm_proposal", {"team_id": "team_1", "proposal_id": ROUTINE}),
            "routines.proposal_revoke": ("revoke_proposal", {"team_id": "team_1", "proposal_id": ROUTINE}),
        }
        for method, (operation, params) in changes.items():
            with self.subTest(method=method), mock.patch.object(self.manage, operation, return_value=self.ok):
                _results, raised = self.results((method, params), topics=(topic,))
            self.assertEqual(raised, {topic})
        with mock.patch.object(self.answer, "resume_integrations", return_value=self.ok):
            _results, raised = self.results(
                ("routines.integrations", {"team_id": "team_1", "run_id": RUN}), topics=(topic,)
            )
        self.assertEqual(raised, {topic})
        # Reads, opening a recovery card included, raise nothing.
        for method, operation, params in (
            ("routines.diagnostics", "diagnostics", {"team_id": "team_1", "run_id": RUN}),
            ("routines.card", "open_card", {"team_id": "team_1", "run_id": ROUTINE}),
        ):
            with self.subTest(method=method), mock.patch.object(self.manage, operation, return_value=self.ok):
                _results, raised = self.results((method, params), topics=(topic,))
            self.assertEqual(raised, set())

    def test_a_change_that_completes_after_its_socket_closed_still_tells_the_reopened_page(self) -> None:
        started, release = threading.Event(), threading.Event()

        def slow(_team_id, _routine_id):
            started.set()
            release.wait(5)
            return self.ok

        async def scenario() -> dict:
            first = await self._connect()
            await first.call("routines.pause", {"team_id": "team_1", "routine_id": ROUTINE})
            await chat_socket_fixtures.wait_for_thread(started)
            await first.disconnect()
            reopened = await self._connect()
            await reopened.result("subscribe", {"topics": ["team/team_1/routines"]})
            release.set()
            changed = await reopened.next_frame()
            await reopened.disconnect()
            return changed

        with mock.patch.object(self.manage, "pause", side_effect=slow):
            changed = asyncio.run(scenario())
        self.assertEqual((changed["type"], changed["topic"]), ("changed", "team/team_1/routines"))

    def test_an_answer_that_makes_a_routine_due_wakes_the_scheduler(self) -> None:
        scheduler = mock.Mock()
        self.admin_app.app.state.routine_scheduler = scheduler
        self.addCleanup(delattr, self.admin_app.app.state, "routine_scheduler")
        card = {"team_id": "team_1", "run_id": ROUTINE, "body": {"tag": "e" * 64}}
        confirm = {"team_id": "team_1", "proposal_id": ROUTINE}
        stale = self.transport.TeamResponse(409, {"code": "routine-card-stale"})
        with (
            mock.patch.object(self.manage, "answer_card", return_value=self.ok),
            mock.patch.object(self.manage, "confirm_proposal", return_value=self.ok),
        ):
            self.results(("routines.card_answer", card), ("routines.proposal_confirm", confirm))
        self.assertEqual(scheduler.wake.call_count, 2)
        with mock.patch.object(self.manage, "answer_card", return_value=stale):
            self.results(("routines.card_answer", card))
        # A pause makes nothing due, and a refused answer wakes nothing.
        with mock.patch.object(self.manage, "pause", return_value=self.ok):
            self.results(("routines.pause", {"team_id": "team_1", "routine_id": ROUTINE}))
        self.assertEqual(scheduler.wake.call_count, 2)

    def test_a_card_answer_team_gave_is_kept_and_an_unavailable_history_never_fails_it(self) -> None:
        answered = {"team_id": "team_1", "proposal_id": ROUTINE, "routine_id": ROUTINE, "status": "created"}
        given = self.transport.TeamResponse(200, answered)
        refused = self.transport.TeamResponse(409, {"code": "routine-proposal-expired"})
        params = {"team_id": "team_1", "proposal_id": ROUTINE}
        with mock.patch.object(self.manage, "confirm_proposal", side_effect=[given, refused]):
            self.results(("routines.proposal_confirm", params), ("routines.proposal_confirm", params))
        self.kept_answers.assert_called_once_with(answered)
        self.kept_answers.side_effect = self.routines.history_store.HistoryUnavailableError("down")
        with mock.patch.object(self.manage, "revoke_proposal", return_value=given):
            (result,), _raised = self.results(("routines.proposal_revoke", params))
        self.assertEqual((result["status"], result["body"]), (200, answered))

    def test_an_admin_without_a_running_scheduler_still_answers(self) -> None:
        card = {"team_id": "team_1", "run_id": ROUTINE, "body": {"tag": "e" * 64}}
        with mock.patch.object(self.manage, "answer_card", return_value=self.ok):
            (result,), _raised = self.results(("routines.card_answer", card))
        self.assertEqual(result["status"], 200)


class RoutineResumeTests(RoutineMethodCase):
    def test_a_human_answer_says_once_that_the_run_resumes_and_answers_with_its_outcome(self) -> None:
        checked = self.answer.Answered("team_1", RUN, {"challenge_id": CHALLENGE, "decision": "deny"}, None, None)
        resumed = self.transport.TeamResponse(200, {"team_id": "team_1", "run_id": RUN, "status": "denied"})

        async def scenario() -> list[dict]:
            websocket = await self._connect()
            call_id = await websocket.call("routines.human", {"team_id": "team_1", "run_id": RUN, "body": DENY})
            frames = [await websocket.next_frame(), await websocket.next_frame()]
            await websocket.disconnect()
            self.assertEqual(frames[0], {"type": "progress", "id": call_id, "state": "running"})
            return frames

        with (
            mock.patch.object(self.answer, "authenticated", new=mock.AsyncMock(return_value=checked)) as authenticated,
            mock.patch.object(self.answer, "resume_answered", return_value=resumed) as resume,
        ):
            frames = asyncio.run(scenario())
        self.assertEqual((frames[1]["status"], frames[1]["body"]), (200, resumed.body))
        resume.assert_called_once_with(checked)
        # The Action password is checked by chat's own authority, so both share its one lockout.
        self.assertEqual(authenticated.await_args.args[:3], ("team_1", RUN, DENY))
        self.assertIs(authenticated.await_args.args[3], self.admin_app._AUTHENTICATE_ACTION_REQUEST)

    def test_a_denial_sent_because_the_password_could_not_be_checked_still_announces_the_run(self) -> None:
        checked = self.answer.Answered(
            "team_1", RUN, {"challenge_id": CHALLENGE, "decision": "deny"}, None, (503, "authentication-unavailable")
        )
        denied = self.transport.TeamResponse(200, {"team_id": "team_1", "run_id": RUN, "status": "denied"})
        with (
            mock.patch.object(self.answer, "authenticated", new=mock.AsyncMock(return_value=checked)),
            mock.patch.object(self.answer, "resume_answered", return_value=denied),
        ):
            (result,), raised = self.results(
                ("routines.human", {"team_id": "team_1", "run_id": RUN, "body": DENY}), topics=("team/team_1/routines",)
            )
        # Team ended the run denied, so the Routines changed; the person learns the password could not be checked.
        self.assertEqual((result["status"], result["body"]), (503, {"code": "human-authentication-unavailable"}))
        self.assertEqual(raised, {"team/team_1/routines"})

    def test_a_rejected_or_expired_answer_never_resumes_and_says_nothing_started(self) -> None:
        rejected = self.transport.TeamResponse(409, {"code": "authentication-denied", "attempts_remaining": 2})
        with (
            mock.patch.object(self.answer, "authenticated", new=mock.AsyncMock(return_value=rejected)),
            mock.patch.object(self.answer, "resume_answered") as resume,
        ):
            (result,), _raised = self.results(("routines.human", {"team_id": "team_1", "run_id": RUN, "body": DENY}))
        self.assertEqual((result["status"], result["body"]["code"]), (409, "authentication-denied"))
        resume.assert_not_called()
        (expired,), _raised = self.results(("routines.human", {"team_id": "team_1", "run_id": RUN, "body": DENY}))
        self.assertEqual((expired["status"], expired["body"]), (409, {"code": "human-request-expired"}))

    def test_a_socket_that_closes_while_the_answer_is_authenticated_never_resumes_the_run(self) -> None:
        checked = self.answer.Answered("team_1", RUN, {"challenge_id": CHALLENGE, "decision": "deny"}, None, None)
        real = self.lane.current
        checks = []
        checked_again = threading.Event()

        def current(socket) -> bool:
            # The worker checks the socket when its turn comes and again once the answer is authenticated.
            result = real(socket)
            checks.append(result)
            if len(checks) == 2:
                checked_again.set()
            return result

        async def close_then_answer(*_args):
            for handle in self.registry.REGISTRY.handles():
                handle.end(1000)
            await asyncio.sleep(0)
            return checked

        async def scenario() -> None:
            websocket = await self._connect()
            await websocket.call("routines.human", {"team_id": "team_1", "run_id": RUN, "body": DENY})
            await self._closed(websocket)
            await chat_socket_fixtures.wait_for_thread(checked_again)
            await websocket.finish()

        with (
            mock.patch.object(self.lane, "current", side_effect=current),
            mock.patch.object(self.answer, "authenticated", side_effect=close_then_answer),
            mock.patch.object(self.answer, "resume_answered") as resume,
        ):
            asyncio.run(scenario())
        self.assertEqual(checks, [True, False])
        resume.assert_not_called()

    def test_an_integrations_resume_says_once_that_it_started(self) -> None:
        resumed = self.transport.TeamResponse(200, {"team_id": "team_1", "run_id": RUN, "status": "done"})

        async def scenario() -> list[dict]:
            websocket = await self._connect()
            call_id = await websocket.call("routines.integrations", {"team_id": "team_1", "run_id": RUN})
            frames = [await websocket.next_frame(), await websocket.next_frame()]
            await websocket.disconnect()
            self.assertEqual(frames[0], {"type": "progress", "id": call_id, "state": "running"})
            return frames

        with mock.patch.object(self.answer, "resume_integrations", return_value=resumed) as resume:
            frames = asyncio.run(scenario())
        resume.assert_called_once_with("team_1", RUN)
        self.assertEqual((frames[1]["status"], frames[1]["body"]), (200, resumed.body))

    def test_resumes_run_on_their_own_bounded_lane(self) -> None:
        lane = self.lane
        self.assertIsNot(lane.RESUME_LANE, lane.LANE)
        self.assertIsNot(lane.RESUME_LANE, lane.INSTALL_LANE)
        with mock.patch.object(lane.RESUME_LANE, "submit", side_effect=lane.ExecutorSaturatedError("full")):
            results, _raised = self.results(
                ("routines.integrations", {"team_id": "team_1", "run_id": RUN}),
                ("routines.human", {"team_id": "team_1", "run_id": RUN, "body": DENY}),
            )
        self.assertEqual([result["status"] for result in results], [429, 429])


class RoutineAnswerBoundTests(unittest.TestCase):
    def test_the_longest_text_answer_fits_its_body_bound(self) -> None:
        from protocol.socket.v1 import frames

        # A text answer of the 16,000 code points a request admits, each a 4-byte character, with its fields.
        body = {
            "type": "human-response",
            "challenge_id": "a" * 32,
            "decision": "submit",
            "value": "\U0001f600" * 16_000,
        }
        size = len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode())
        self.assertLessEqual(size, frames.BODY_BYTES["routines.human"])
        self.assertLess(frames.BODY_BYTES["routines.human"], frames.MAX_INBOUND_BYTES)
