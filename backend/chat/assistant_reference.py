"""One bounded Assistant referent retained only for the current chat socket."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AssistantReference:
    assistant_id: str
    name: str


def from_item(value: object) -> AssistantReference | None:
    """Project one already-validated lifecycle item into identity-only memory."""
    if not isinstance(value, dict):
        return None
    assistant_id = value.get("id")
    name = value.get("name")
    if not isinstance(assistant_id, str) or not isinstance(name, str):
        return None
    return AssistantReference(assistant_id, name)
