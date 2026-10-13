"""The Admin session socket protocol replays its golden vectors (ADR-0114)."""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from protocol.socket.v1 import frames

VECTORS = json.loads((ROOT / "backend" / "protocol" / "socket" / "v1" / "vectors.json").read_text(encoding="utf-8"))


class SessionProtocolVectorTests(unittest.TestCase):
    def test_the_vectors_name_this_protocol(self) -> None:
        self.assertEqual(
            (VECTORS["version"], VECTORS["subprotocol"], VECTORS["path"]), (1, frames.SUBPROTOCOL, frames.PATH)
        )

    def test_every_valid_call_is_admitted_and_every_invalid_one_refused(self) -> None:
        for frame in VECTORS["calls"]["valid"]:
            with self.subTest(frame=frame):
                self.assertEqual(frames.call(frame), (frame["id"], frame["method"], frame["params"]))
        for frame in VECTORS["calls"]["invalid"]:
            with self.subTest(frame=frame), self.assertRaises(frames.ProtocolError) as refused:
                frames.call(frame)
            self.assertEqual(refused.exception.close_code, 1008)

    def test_the_activity_frame_carries_nothing_but_its_type(self) -> None:
        for frame in VECTORS["activity"]["valid"]:
            self.assertIsNone(frames.activity(frame))
        for frame in VECTORS["activity"]["invalid"]:
            with self.subTest(frame=frame), self.assertRaises(frames.ProtocolError) as refused:
                frames.activity(frame)
            self.assertEqual(refused.exception.close_code, 1008)

    def test_a_chat_frame_carries_its_team_and_the_exact_v7_frame(self) -> None:
        for case in VECTORS["chat"]["valid"]:
            with self.subTest(case=case):
                self.assertEqual(frames.chat_frame(case["frame"]), (case["team_id"], case["v7"]))
        for frame in VECTORS["chat"]["invalid"]:
            with self.subTest(frame=frame), self.assertRaises(frames.ProtocolError):
                frames.chat_frame(frame)
        for event in VECTORS["server"]["chat"]:
            without = {key: value for key, value in event.items() if key != "team_id"}
            self.assertEqual(frames.chat_event("marketing", without), event)
        with self.assertRaises(ValueError):
            frames.chat_event("marketing", {"type": "done", "team_id": "sales"})

    def test_server_frames_are_the_exact_vector_shapes(self) -> None:
        server = VECTORS["server"]
        result = server["result"]
        self.assertEqual(
            frames.result(result["id"], result["status"], result["body"], (result["topic"], result["epoch"], 3)),
            result,
        )
        refused = server["refused"]
        self.assertEqual(frames.result(refused["id"], refused["status"], refused["body"]), refused)
        changed = server["changed"]
        self.assertEqual(frames.changed(changed["topic"], changed["epoch"], changed["revision"]), changed)
        session = server["session"]
        self.assertEqual(frames.session(3480.9, 82800.2, session["source_revision"]), session)
        self.assertEqual(frames.session(3480.9, 82800.2, None), server["session_unnamed"])
        for revision in ("A" * 40, "a" * 39, "a" * 40 + "\n", "g" * 40, 1):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                frames.session(1, 2, revision)
        self.assertEqual(frames.progress(server["progress"]["id"]), server["progress"])
        self.assertRegex(changed["epoch"], frames.EPOCH_RE)

    def test_topics_follow_the_closed_grammar(self) -> None:
        for topic in VECTORS["topics"]["valid"]:
            self.assertTrue(frames.is_topic(topic), topic)
        for topic in VECTORS["topics"]["invalid"]:
            self.assertFalse(frames.is_topic(topic), topic)

    def test_a_server_frame_is_bounded_whole(self) -> None:
        envelope = len(frames.encode(frames.result("c", 200, {"text": ""})).encode())
        fits = frames.result("c", 200, {"text": "é" * ((frames.MAX_OUTBOUND_BYTES - envelope) // 2)})
        self.assertLessEqual(len(frames.encode(fits).encode()), frames.MAX_OUTBOUND_BYTES)
        with self.assertRaises(ValueError):
            frames.encode(frames.result("c", 200, {"text": "x" * frames.MAX_OUTBOUND_BYTES}))

    def test_a_full_history_page_fits_one_result_frame(self) -> None:
        history = __import__("history.store", fromlist=["store"])
        # The largest page the store returns: its byte bound of stored rows, each re-serialized with its envelope.
        entry = {
            "id": "a" * 32 + ":reply",
            "created_at": "2026-10-12T00:00:00Z",
            "kind": "message",
            "role": "assistant",
            "author": "M" * 80,
            "text": "\\\\" * 4000,
        }
        rows = history.MAX_PAGE_BYTES // len(json.dumps(entry, ensure_ascii=False))
        page = {"entries": [entry] * min(rows, history.PAGE_ROWS), "before": "AAAAAAAAAMg"}
        self.assertLessEqual(len(frames.encode(frames.result("c", 200, page)).encode()), frames.MAX_OUTBOUND_BYTES)

    def test_a_body_is_measured_as_the_page_sends_it(self) -> None:
        # Compact UTF-8 JSON: a two-byte character counts twice, and nothing a page never sends is counted.
        self.assertEqual(frames.body_bytes({"team_name": "é"}), len('{"team_name":"é"}'.encode()))
        # A lone surrogate the strict decoder admitted is still measured rather than failing the call.
        self.assertEqual(frames.body_bytes({"x": "\ud800"}), len('{"x":""}') + 3)

    def test_every_body_bound_is_one_a_method_takes_and_every_body_method_has_one(self) -> None:
        bodies = {method for method, (required, _optional) in frames.METHODS.items() if "body" in required}
        self.assertEqual(set(frames.BODY_BYTES), bodies)
        self.assertEqual((frames.BODY_BYTES["teams.rename"], frames.BODY_BYTES["teams.delete"]), (1024, 8 * 1024))
        self.assertLessEqual(frames.LONG_METHODS, set(frames.METHODS))
        self.assertLessEqual(set(frames.READ_TOPICS), set(frames.METHODS))


if __name__ == "__main__":
    unittest.main()
