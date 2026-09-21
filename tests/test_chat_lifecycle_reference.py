"""Identity-only lifecycle reference contracts at the Admin-to-Team boundary."""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team

from chat import assistant_proposal, local, socket

TRACE_ID = "a" * 32


def _future(value: object) -> concurrent.futures.Future[object]:
    future: concurrent.futures.Future[object] = concurrent.futures.Future()
    future.set_result(value)
    return future


class ChatLifecycleReferenceTests(unittest.TestCase):
    def test_reference_is_classification_only_and_crosses_as_identity_only(self) -> None:
        reference = assistant_proposal.AssistantReference("cloudflare", "Cloudflare")
        with (
            mock.patch.object(local, "_model_credential", return_value=("openai", "secret")),
            mock.patch.object(team, "intent_route", return_value=team.TeamResponse(503, {})) as route,
        ):
            local.intent_route(
                "team_1",
                "instale ele de novo",
                None,
                [],
                local.IntentRouteContext(reference=reference),
            )

        self.assertEqual(
            route.call_args.args[1]["lifecycle_reference"],
            {"id": "cloudflare", "name": "Cloudflare"},
        )
        candidates = [{"id": "cloudflare", "name": "Cloudflare", "summary": ""}]
        with self.assertRaises(team.TeamRequestError):
            local.intent_route(
                "team_1",
                "instale o cloudflare",
                "assistant-install",
                candidates,
                local.IntentRouteContext(reference=reference),
            )

    def test_intent_route_rejects_invalid_input_and_inconsistent_team_output(self) -> None:
        candidates = [{"id": "cloudflare", "name": "Cloudflare", "summary": ""}]
        invalid_input = (
            ("unknown", candidates),
            (None, candidates),
            ("assistant-install", "invalid"),
            ("assistant-install", [{"id": "cloudflare", "name": "Cloudflare"}]),
            ("assistant-install", [*candidates, *candidates]),
            ("assistant-uninstall", [{"id": "cloudflare", "name": "Cloudflare", "summary": "private"}]),
        )
        for expected, directory in invalid_input:
            with self.subTest(expected=expected, directory=directory), self.assertRaises(team.TeamRequestError):
                local.intent_route("team_1", "objective", expected, directory)

        base = {
            "team_id": "team_1",
            "intent": "assistant-uninstall",
            "query": "",
            "assistant_ids": ["cloudflare"],
            "reply": "",
            "trace_id": TRACE_ID,
        }
        invalid_output = (
            {**base, "team_id": "team_2"},
            {**base, "assistant_ids": ["unknown"]},
            {**base, "assistant_ids": []},
            {**base, "intent": "assistant-install"},
            {**base, "query": "cloudflare"},
            {**base, "trace_id": "bad"},
            {**base, "extra": True},
        )
        for body in invalid_output:
            with (
                self.subTest(body=body),
                mock.patch.object(local, "_model_credential", return_value=("openai", "secret")),
                mock.patch.object(team, "intent_route", return_value=team.TeamResponse(200, body)),
            ):
                self.assertEqual(
                    local.intent_route(
                        "team_1",
                        "desinstale o cloudflare",
                        "assistant-uninstall",
                        candidates,
                    ),
                    team.TeamResponse(502, {"code": "chat-response-invalid"}),
                )

        classification_invalid = (
            {
                "team_id": "team_1",
                "intent": "ordinary-task",
                "query": "unexpected",
                "assistant_ids": [],
                "reply": "",
                "trace_id": TRACE_ID,
            },
            {
                "team_id": "team_1",
                "intent": "unresolved",
                "query": "unexpected",
                "assistant_ids": [],
                "reply": "",
                "trace_id": TRACE_ID,
            },
        )
        for body in classification_invalid:
            with (
                self.subTest(body=body),
                mock.patch.object(local, "_model_credential", return_value=("openai", "secret")),
                mock.patch.object(team, "intent_route", return_value=team.TeamResponse(200, body)),
            ):
                self.assertEqual(
                    local.intent_route("team_1", "faça isso", None, []),
                    team.TeamResponse(502, {"code": "chat-response-invalid"}),
                )

        valid_classification = {
            "team_id": "team_1",
            "intent": "ordinary-task",
            "query": "",
            "assistant_ids": [],
            "reply": "",
            "trace_id": TRACE_ID,
        }
        with (
            mock.patch.object(local, "_model_credential", return_value=("openai", "secret")),
            mock.patch.object(
                team,
                "intent_route",
                return_value=team.TeamResponse(200, valid_classification),
            ),
        ):
            self.assertEqual(
                local.intent_route("team_1", "faça isso", None, []),
                team.TeamResponse(
                    200,
                    {key: value for key, value in valid_classification.items() if key != "trace_id"},
                ),
            )

        invalid_unresolved = {
            "team_id": "team_1",
            "intent": "unresolved",
            "query": "unexpected",
            "assistant_ids": [],
            "reply": "",
            "trace_id": TRACE_ID,
        }
        with (
            mock.patch.object(local, "_model_credential", return_value=("openai", "secret")),
            mock.patch.object(team, "intent_route", return_value=team.TeamResponse(200, invalid_unresolved)),
        ):
            self.assertEqual(
                local.intent_route("team_1", "instale", "assistant-install", candidates),
                team.TeamResponse(502, {"code": "chat-response-invalid"}),
            )

        valid_unresolved = {**invalid_unresolved, "query": "", "reply": "Qual Assistant você quer instalar?"}
        with (
            mock.patch.object(local, "_model_credential", return_value=("openai", "secret")),
            mock.patch.object(team, "intent_route", return_value=team.TeamResponse(200, valid_unresolved)),
        ):
            self.assertEqual(
                local.intent_route("team_1", "instale", "assistant-install", candidates),
                team.TeamResponse(
                    200,
                    {key: value for key, value in valid_unresolved.items() if key != "trace_id"},
                ),
            )

    def test_direct_start_records_and_delivers_one_admitted_turn(self) -> None:
        async def scenario() -> None:
            response = local.PublicResponse(200, {"team_id": "team_1", "team_name": "Marketing", "reply": "Done"})
            future = _future(response)
            connection = socket._Connection(admitted_history_id="a" * 32)
            websocket = mock.AsyncMock()
            with (
                mock.patch.object(socket, "_submit_team_turn", return_value=(future, mock.sentinel.progress)),
                mock.patch.object(socket, "_deliver_turn", new=mock.AsyncMock()) as deliver,
            ):
                await socket._start_direct_turn(
                    websocket,
                    connection,
                    "team_1",
                    {"message": "hello"},
                    "hello",
                )
                await connection.active.delivery

            turn = connection.active
            self.assertEqual(turn.future, future)
            self.assertEqual(turn.operation, "chat")
            self.assertEqual(turn.language_exemplar, "hello")
            self.assertIs(turn.progress, mock.sentinel.progress)
            self.assertEqual(turn.history_id, "a" * 32)
            self.assertIsNone(connection.admitted_history_id)
            deliver.assert_awaited_once_with(websocket, connection, turn, "team_1")

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
