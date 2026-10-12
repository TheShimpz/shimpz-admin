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
                call_id, method, params, background = frames.call(frame)
                self.assertEqual((call_id, method, params), (frame["id"], frame["method"], frame["params"]))
                self.assertIs(background, frame.get("background", False))
        for frame in VECTORS["calls"]["invalid"]:
            with self.subTest(frame=frame), self.assertRaises(frames.ProtocolError) as refused:
                frames.call(frame)
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


if __name__ == "__main__":
    unittest.main()
