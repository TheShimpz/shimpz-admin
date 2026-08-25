"""Pure matching and textual decision rules for one Local chat install proposal."""

from __future__ import annotations

import re
import secrets
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Literal

from chat import store_catalog
from protocol.http.v1 import payload as team_contract

PROPOSAL_TTL_SECONDS = 300
MINIMUM_MATCH_SCORE = 40
_TERMINAL_PUNCTUATION = re.compile(r"[\s.!?,;:]+$")
_SEARCH_SEPARATOR = re.compile(r"[^a-z0-9]+")
_TEAM_ID = re.compile(r"^[a-z0-9_]{1,40}$")
_PROPOSAL_ID = re.compile(r"^[0-9a-f]{32}$")
_STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "assistant",
        "assistente",
        "da",
        "de",
        "do",
        "e",
        "for",
        "me",
        "my",
        "o",
        "os",
        "para",
        "please",
        "por",
        "shimpz",
        "the",
        "um",
        "uma",
    }
)
_AFFIRMATIVE = frozenset(
    {
        "autorizo a instalacao",
        "claro",
        "confirmo",
        "go ahead",
        "go ahead and install",
        "instale",
        "install it",
        "ok",
        "okay",
        "pode",
        "pode instalar",
        "pode instalar sim",
        "please install",
        "sim",
        "sure",
        "yes",
    }
)
_NEGATIVE = frozenset(
    {
        "cancel",
        "cancela",
        "cancelar",
        "cancele",
        "do not install",
        "dont install",
        "esquece",
        "forget it",
        "nao",
        "nao foi isso que pedi",
        "nao instale",
        "no",
    }
)

Decision = Literal["confirm", "cancel", "ambiguous"]


@dataclass(frozen=True, slots=True)
class Capability:
    assistant_id: str
    name: str
    summary: str
    actions: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class InstallProposal:
    proposal_id: str
    team_id: str
    assistant: store_catalog.CatalogAssistant
    language_exemplar: str | None = field(repr=False)
    expires_at: float

    def valid_for(self, team_id: str, now: float) -> bool:
        return team_id == self.team_id and now < self.expires_at


def _fold(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value.casefold())
    return "".join(character for character in normalized if not unicodedata.combining(character))


def _confirmation(value: str) -> str:
    return _TERMINAL_PUNCTUATION.sub("", " ".join(_fold(value).strip().split()))


def classify_confirmation(value: object) -> Decision:
    """Classify only a complete, explicit user-authored response."""
    if not isinstance(value, str) or not value.strip() or len(value) > 160:
        return "ambiguous"
    normalized = _confirmation(value)
    if normalized in _AFFIRMATIVE:
        return "confirm"
    if normalized in _NEGATIVE:
        return "cancel"
    return "ambiguous"


def _search_text(value: str) -> str:
    return " ".join(_SEARCH_SEPARATOR.sub(" ", _fold(value)).split())


def _tokens(*values: str) -> frozenset[str]:
    return frozenset(
        token
        for value in values
        for token in _search_text(value).split()
        if len(token) > 1 and token not in _STOP_WORDS
    )


def _contains_phrase(message: str, value: str) -> bool:
    phrase = _search_text(value)
    return bool(phrase) and f" {phrase} " in f" {message} "


def _score_fields(
    message: str,
    message_tokens: frozenset[str],
    *,
    assistant_id: str,
    name: str,
    summary: str,
    integrations: Iterable[str],
    actions: Iterable[str],
) -> int:
    score = 0
    if _contains_phrase(message, assistant_id) or _contains_phrase(message, name):
        score = 100
    for provider in integrations:
        if _contains_phrase(message, provider):
            score = max(score, 90)
    action_values = tuple(actions)
    if any(_contains_phrase(message, action) for action in action_values):
        score = max(score, 70)
    terms = _tokens(assistant_id, name, summary, *integrations, *action_values)
    overlap = len(message_tokens & terms)
    if overlap >= 2:
        score = max(score, overlap * 20)
    return score


def _candidate_score(message: str, tokens: frozenset[str], candidate: store_catalog.CatalogAssistant) -> int:
    return _score_fields(
        message,
        tokens,
        assistant_id=candidate.assistant_id,
        name=candidate.name,
        summary=candidate.summary,
        integrations=(item.provider for item in candidate.integrations),
        actions=candidate.actions,
    )


def _capability_score(message: str, tokens: frozenset[str], capability: Capability) -> int:
    return _score_fields(
        message,
        tokens,
        assistant_id=capability.assistant_id,
        name=capability.name,
        summary=capability.summary,
        integrations=(),
        actions=capability.actions,
    )


def select_candidate(
    message: str,
    catalog: tuple[store_catalog.CatalogAssistant, ...],
    *,
    installed_ids: frozenset[str],
    enabled: tuple[Capability, ...],
) -> store_catalog.CatalogAssistant | None:
    """Select one strong public candidate without model inference or product-specific mappings."""
    search = _search_text(message)
    message_tokens = _tokens(message)
    if not search or not message_tokens:
        return None
    ranked = sorted(
        (
            (_candidate_score(search, message_tokens, candidate), candidate.assistant_id, candidate)
            for candidate in catalog
            if candidate.assistant_id not in installed_ids
        ),
        key=lambda item: (-item[0], item[1]),
    )
    if not ranked or ranked[0][0] < MINIMUM_MATCH_SCORE:
        return None
    best_score, _assistant_id, best = ranked[0]
    if len(ranked) > 1 and ranked[1][0] == best_score:
        return None
    enabled_score = max((_capability_score(search, message_tokens, item) for item in enabled), default=0)
    return None if enabled_score >= best_score else best


def create_proposal(
    team_id: str,
    assistant: store_catalog.CatalogAssistant,
    *,
    language_exemplar: object,
    now: float,
    proposal_id_factory: Callable[[], str] = lambda: secrets.token_hex(16),
) -> InstallProposal:
    proposal_id = proposal_id_factory()
    if _TEAM_ID.fullmatch(team_id) is None or _PROPOSAL_ID.fullmatch(proposal_id) is None or now < 0:
        raise ValueError("invalid Assistant install proposal")
    return InstallProposal(
        proposal_id=proposal_id,
        team_id=team_id,
        assistant=assistant,
        language_exemplar=team_contract.canonical_language_exemplar(language_exemplar),
        expires_at=now + PROPOSAL_TTL_SECONDS,
    )
