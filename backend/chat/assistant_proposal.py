"""Pure matching and textual decision rules for Local chat Assistant lifecycle proposals."""

from __future__ import annotations

import re
import secrets
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Literal

from chat import local_catalog, store_catalog
from protocol.http.v1 import payload as team_contract

UNINSTALL_PROPOSAL_TTL_SECONDS = 120
MINIMUM_MATCH_SCORE = 40
MAX_CAPABILITY_SHORTLIST = 8
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
_UNINSTALL_AFFIRMATIVE = frozenset(
    {
        "autorizo a desinstalacao",
        "claro",
        "confirmo",
        "desinstale",
        "go ahead",
        "go ahead and uninstall",
        "ok",
        "okay",
        "pode",
        "pode desinstalar",
        "pode remover",
        "please uninstall",
        "remova",
        "remove it",
        "sim",
        "sure",
        "uninstall it",
        "yes",
    }
)
_UNINSTALL_NEGATIVE = frozenset(
    {
        "cancel",
        "cancela",
        "cancelar",
        "cancele",
        "do not remove",
        "do not uninstall",
        "dont remove",
        "dont uninstall",
        "esquece",
        "forget it",
        "nao",
        "nao desinstale",
        "nao foi isso que pedi",
        "nao remova",
        "no",
    }
)
_CAPABILITY_CONTINUATIONS = frozenset(
    {
        "activate it",
        "ative",
        "can you enable it",
        "can you install it",
        "consegue habilitar",
        "could you enable it",
        "enable it",
        "habilite",
        "install it",
        "instale",
        "please enable it",
        "pode ativar",
        "pode habilitar",
        "pode instalar",
        "voce consegue habilitar",
        "voce mesmo consegue habilitar",
    }
)

Decision = Literal["confirm", "cancel", "ambiguous"]
DirectoryAssistant = store_catalog.CatalogAssistant | local_catalog.LocalAssistant


@dataclass(frozen=True, slots=True)
class Capability:
    assistant_id: str
    name: str
    summary: str
    actions: tuple[str, ...]
    integrations: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class UninstallCandidate:
    assistant: Capability
    version: str


@dataclass(frozen=True, slots=True)
class UninstallProposal:
    proposal_id: str
    team_id: str
    assistant: Capability
    assistant_version: str
    language_exemplar: str | None = field(repr=False)
    expires_at: float

    def valid_for(self, team_id: str, now: float) -> bool:
        return team_id == self.team_id and now < self.expires_at


def _fold(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value.casefold())
    return "".join(character for character in normalized if not unicodedata.combining(character))


def _confirmation(value: str) -> str:
    return _TERMINAL_PUNCTUATION.sub("", " ".join(_fold(value).strip().split()))


def _classify_confirmation(
    value: object,
    affirmative: frozenset[str],
    negative: frozenset[str],
) -> Decision:
    if not isinstance(value, str) or not value.strip() or len(value) > 160:
        return "ambiguous"
    normalized = _confirmation(value)
    if normalized in affirmative:
        return "confirm"
    if normalized in negative:
        return "cancel"
    return "ambiguous"


def classify_uninstall_confirmation(value: object) -> Decision:
    """Classify only a complete uninstall-specific user response."""
    return _classify_confirmation(value, _UNINSTALL_AFFIRMATIVE, _UNINSTALL_NEGATIVE)


def capability_continuation(value: object) -> bool:
    """Accept only one complete request to resume a prior capability objective."""
    return _classify_confirmation(value, _CAPABILITY_CONTINUATIONS, frozenset()) == "confirm"


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
        integrations=capability.integrations,
        actions=capability.actions,
    )


def _direct_candidate_match(message: str, candidate: store_catalog.CatalogAssistant) -> bool:
    return (
        _contains_phrase(message, candidate.assistant_id)
        or _contains_phrase(message, candidate.name)
        or any(_contains_phrase(message, integration.provider) for integration in candidate.integrations)
        or any(_contains_phrase(message, action) for action in candidate.actions)
    )


def capability_shortlist(
    message: str,
    catalog: tuple[store_catalog.CatalogAssistant, ...],
    *,
    installed_ids: frozenset[str],
    enabled: tuple[Capability, ...],
) -> tuple[store_catalog.CatalogAssistant, ...]:
    """Return a deterministic strong gap shortlist or no planning signal."""
    search = _search_text(message)
    message_tokens = _tokens(message)
    if not search or not message_tokens:
        return ()
    ranked = sorted(
        (
            (_candidate_score(search, message_tokens, candidate), candidate.assistant_id, candidate)
            for candidate in catalog
            if candidate.assistant_id not in installed_ids
        ),
        key=lambda item: (-item[0], item[1]),
    )
    strong = tuple(item for item in ranked if item[0] >= MINIMUM_MATCH_SCORE)
    if not strong:
        return ()
    enabled_score = max((_capability_score(search, message_tokens, item) for item in enabled), default=0)
    if enabled_score >= strong[0][0]:
        return ()
    top_score = strong[0][0]
    top = tuple(item[2] for item in strong if item[0] == top_score)
    if len(top) > 1 and any(not _direct_candidate_match(search, candidate) for candidate in top):
        return ()
    if (
        len(strong) > MAX_CAPABILITY_SHORTLIST
        and strong[MAX_CAPABILITY_SHORTLIST - 1][0] == strong[MAX_CAPABILITY_SHORTLIST][0]
    ):
        return ()
    return tuple(item[2] for item in strong[:MAX_CAPABILITY_SHORTLIST])


def _bounded_shortlist[AssistantT](
    ranked: list[tuple[int, str, AssistantT]],
    direct: Callable[[AssistantT], bool],
    *,
    allow_ambiguous_ties: bool = False,
) -> tuple[AssistantT, ...]:
    strong = tuple(item for item in ranked if item[0] >= MINIMUM_MATCH_SCORE)
    if not strong:
        return ()
    top_score = strong[0][0]
    top = tuple(item[2] for item in strong if item[0] == top_score)
    if not allow_ambiguous_ties and len(top) > 1 and any(not direct(candidate) for candidate in top):
        return ()
    if (
        len(strong) > MAX_CAPABILITY_SHORTLIST
        and strong[MAX_CAPABILITY_SHORTLIST - 1][0] == strong[MAX_CAPABILITY_SHORTLIST][0]
    ):
        return ()
    return tuple(item[2] for item in strong[:MAX_CAPABILITY_SHORTLIST])


def _directory_identity_score(query: str, tokens: frozenset[str], assistant_id: str, name: str) -> int:
    if _contains_phrase(query, assistant_id) or _contains_phrase(query, name):
        return 100
    identity_tokens = _tokens(assistant_id, name)
    overlap = len(tokens & identity_tokens)
    return 60 + min(overlap, 4) * 5 if overlap and tokens <= identity_tokens else 0


def install_shortlist(
    query: str,
    candidates: tuple[DirectoryAssistant, ...],
) -> tuple[DirectoryAssistant, ...]:
    """Rank a semantic install target into one bounded local-first directory."""
    search = _search_text(query)
    tokens = _tokens(query)
    if not search or not tokens:
        return ()
    ranked = sorted(
        (
            (
                max(
                    _directory_identity_score(search, tokens, candidate.assistant_id, candidate.name),
                    _candidate_score(search, tokens, candidate),
                ),
                candidate.assistant_id,
                candidate,
            )
            for candidate in candidates
        ),
        key=lambda item: (-item[0], item[1]),
    )
    return _bounded_shortlist(
        ranked,
        lambda candidate: _direct_candidate_match(search, candidate),
        allow_ambiguous_ties=True,
    )


def uninstall_shortlist(
    query: str,
    candidates: tuple[UninstallCandidate, ...],
) -> tuple[UninstallCandidate, ...]:
    """Rank a semantic uninstall target using installed id/name data only."""
    search = _search_text(query)
    tokens = _tokens(query)
    if not search or not tokens:
        return ()

    def score(candidate: UninstallCandidate) -> int:
        assistant = candidate.assistant
        return _directory_identity_score(search, tokens, assistant.assistant_id, assistant.name)

    def direct(candidate: UninstallCandidate) -> bool:
        assistant = candidate.assistant
        return _contains_phrase(search, assistant.assistant_id) or _contains_phrase(search, assistant.name)

    ranked = sorted(
        ((score(candidate), candidate.assistant.assistant_id, candidate) for candidate in candidates),
        key=lambda item: (-item[0], item[1]),
    )
    return _bounded_shortlist(ranked, direct, allow_ambiguous_ties=True)


def _proposal_id(team_id: str, now: float, proposal_id_factory: Callable[[], str]) -> str:
    proposal_id = proposal_id_factory()
    if _TEAM_ID.fullmatch(team_id) is None or _PROPOSAL_ID.fullmatch(proposal_id) is None or now < 0:
        raise ValueError("invalid Assistant lifecycle proposal")
    return proposal_id


def create_uninstall_proposal(
    team_id: str,
    candidate: UninstallCandidate,
    *,
    language_exemplar: object,
    now: float,
    proposal_id_factory: Callable[[], str] = lambda: secrets.token_hex(16),
) -> UninstallProposal:
    proposal_id = _proposal_id(team_id, now, proposal_id_factory)
    return UninstallProposal(
        proposal_id=proposal_id,
        team_id=team_id,
        assistant=candidate.assistant,
        assistant_version=candidate.version,
        language_exemplar=team_contract.canonical_language_exemplar(language_exemplar),
        expires_at=now + UNINSTALL_PROPOSAL_TTL_SECONDS,
    )
