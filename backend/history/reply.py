"""What a stored chat reply carries beside its text: its Routine card, question, or refusal, and its receipt.

Pure shape checks, the same when a reply is written and when its row is read back.
"""

from collections.abc import Mapping

from chat import local as chat_local


def routine_reply(value: Mapping[str, object], clarification: object) -> dict[str, object]:
    """A stored reply's Routine card, question, or refusal, exactly in the closed form a live reply admits it in."""
    admitted = chat_local.admit_routine_fields(dict(value), clarification)
    if admitted is None or any(admitted[name] != value[name] for name in admitted):
        raise ValueError("chat history Routine reply is invalid")
    return admitted


def receipt(value: object) -> list[dict[str, object]]:
    """A reply's receipt (ADR-0082): the Team progress its page was shown, in the order it arrived.

    Each event is a canonical public Team progress event with the sequence it was delivered under and the delivery it
    came in, numbered in order from 0; within a delivery the sequence only increases.
    """
    if not isinstance(value, list) or not 1 <= len(value) <= chat_local.MAX_PUBLIC_PROGRESS_EVENTS:
        raise ValueError("chat history receipt is invalid")
    receipt: list[dict[str, object]] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("chat history receipt is invalid")
        segment, seq = item.get("segment"), item.get("seq")
        event = {key: field for key, field in item.items() if key not in {"segment", "seq"}}
        try:
            public = chat_local.canonical_public_progress(event)
        except ValueError:
            raise ValueError("chat history receipt is invalid") from None
        previous = (receipt[-1]["segment"], receipt[-1]["seq"]) if receipt else (0, 0)
        if (
            public != event
            or public["origin"] != "team"
            or type(segment) is not int
            or type(seq) is not int
            or not 1 <= seq <= chat_local.MAX_PUBLIC_PROGRESS_EVENTS
            or not ((segment == previous[0] and seq > previous[1]) or (receipt and segment == previous[0] + 1))
        ):
            raise ValueError("chat history receipt is invalid")
        receipt.append({"segment": segment, "seq": seq, **public})
    return receipt
