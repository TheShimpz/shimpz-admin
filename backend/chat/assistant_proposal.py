"""Pure matching and textual decision rules for Local chat Assistant lifecycle proposals."""

from __future__ import annotations

import re
import secrets
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Literal, Protocol

from chat import store_catalog
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
_TARGETLESS_UNINSTALL_REQUESTS = frozenset(
    {
        "desinstala",
        "desinstalar",
        "desinstale",
        "pode desinstalar",
        "please uninstall",
        "uninstall",
        "uninstall it",
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
_UNINSTALL_PREFIXES = (
    "can you ",
    "could you ",
    "eu quero ",
    "gostaria de ",
    "i want to ",
    "please ",
    "pode ",
    "por favor ",
    "quero que voce ",
    "quero ",
    "",
)
_UNINSTALL_VERBS = (
    "desinstala ",
    "desinstale ",
    "desinstalar ",
    "remove ",
    "remova ",
    "remover ",
    "uninstall ",
)
_SHORT_NAME_UNINSTALL_VERBS = frozenset(
    {
        "desinstala ",
        "desinstale ",
        "desinstalar ",
        "uninstall ",
    }
)
_GENERIC_ASSISTANT_NAME_TOKENS = frozenset({"assistant", "assistente", "shimpz"})
_UNINSTALL_SUFFIXES = (
    " deste time",
    " do time",
    " from this team",
    " from the team",
    "",
)
_INSTALL_PREFIXES = (
    "can you ",
    "could you ",
    "eu quero ",
    "gostaria de ",
    "i want to ",
    "please ",
    "pode ",
    "por favor ",
    "quero que voce ",
    "quero ",
    "",
)
_INSTALL_VERBS = ("instala ", "instale ", "instalar ", "install ")
_INSTALL_SUFFIXES = (" neste time", " no time", " on this team", " por favor", " please", "")
_INSTALL_TARGET_SEPARATOR = re.compile(r"\s+(?:and|e)\s+")
_LIFECYCLE_SEQUENCE_LEAD_INS = ("and now ", "e agora ", "agora ", "now ")

Decision = Literal["confirm", "cancel", "ambiguous"]


class AssistantIdentity(Protocol):
    assistant_id: str
    name: str


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


def targetless_uninstall_requested(value: object) -> bool:
    """Recognize only a complete uninstall imperative that names no target."""
    if not isinstance(value, str) or not value.strip() or len(value) > 160:
        return False
    normalized = _strip_lifecycle_sequence_lead_in(_search_text(value))
    return _classify_confirmation(normalized, _TARGETLESS_UNINSTALL_REQUESTS, frozenset()) == "confirm"


def capability_continuation(value: object) -> bool:
    """Accept only one complete request to resume a prior capability objective."""
    return _classify_confirmation(value, _CAPABILITY_CONTINUATIONS, frozenset()) == "confirm"


def _search_text(value: str) -> str:
    return " ".join(_SEARCH_SEPARATOR.sub(" ", _fold(value)).split())


def _strip_lifecycle_sequence_lead_in(value: str) -> str:
    for lead_in in _LIFECYCLE_SEQUENCE_LEAD_INS:
        if value.startswith(lead_in):
            return value[len(lead_in) :]
    return value


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


def _uninstall_request(message: object) -> tuple[str, bool] | None:
    if not isinstance(message, str) or not message.strip() or len(message) > 500:
        return None
    normalized = _strip_lifecycle_sequence_lead_in(_search_text(message))
    for prefix in _UNINSTALL_PREFIXES:
        if not normalized.startswith(prefix):
            continue
        remainder = normalized[len(prefix) :]
        for verb in _UNINSTALL_VERBS:
            if not remainder.startswith(verb):
                continue
            target = remainder[len(verb) :]
            for suffix in _UNINSTALL_SUFFIXES:
                if suffix and target.endswith(suffix):
                    target = target[: -len(suffix)]
                    break
            normalized_target = target.strip()
            return (normalized_target, verb in _SHORT_NAME_UNINSTALL_VERBS) if normalized_target else None
    return None


def _uninstall_target(message: object) -> str | None:
    request = _uninstall_request(message)
    return request[0] if request is not None else None


def uninstall_requested(message: object) -> bool:
    """Return whether a closed uninstall structure exists before Team discovery work."""
    return _uninstall_target(message) is not None


def _installation_targets(message: object) -> tuple[str, ...]:
    if not isinstance(message, str) or not message.strip() or len(message) > 500:
        return ()
    normalized = _strip_lifecycle_sequence_lead_in(_search_text(message))
    for prefix in _INSTALL_PREFIXES:
        if not normalized.startswith(prefix):
            continue
        remainder = normalized[len(prefix) :]
        for verb in _INSTALL_VERBS:
            if not remainder.startswith(verb):
                continue
            target = remainder[len(verb) :]
            for suffix in _INSTALL_SUFFIXES:
                if suffix and target.endswith(suffix):
                    target = target[: -len(suffix)]
                    break
            return tuple(part.strip() for part in _INSTALL_TARGET_SEPARATOR.split(target) if part.strip())
    return ()


def _identity_targets(capability: AssistantIdentity) -> frozenset[str]:
    exact = {_search_text(capability.assistant_id), _search_text(capability.name)}
    short_tokens = tuple(
        token for token in _search_text(capability.name).split() if token not in _GENERIC_ASSISTANT_NAME_TOKENS
    )
    aliases = exact | ({" ".join(short_tokens), *short_tokens} if short_tokens else set())
    targets = {target for value in exact if value for target in (value, f"a {value}", f"o {value}", f"the {value}")}
    for alias in aliases:
        if not alias:
            continue
        targets.update(
            {
                f"a assistente {alias}",
                f"a assistente da {alias}",
                f"a assistente de {alias}",
                f"a assistente do {alias}",
                f"an assistant {alias}",
                f"an {alias} assistant",
                f"assistant {alias}",
                f"a {alias} assistant",
                f"a {alias} assistente",
                f"assistente {alias}",
                f"assistente da {alias}",
                f"assistente de {alias}",
                f"assistente do {alias}",
                f"o assistant {alias}",
                f"o {alias} assistant",
                f"o assistant da {alias}",
                f"o assistant de {alias}",
                f"o assistant do {alias}",
                f"o assistente {alias}",
                f"o {alias} assistente",
                f"o assistente da {alias}",
                f"o assistente de {alias}",
                f"o assistente do {alias}",
                f"the assistant {alias}",
                f"the {alias} assistant",
                f"{alias} assistant",
                f"{alias} assistente",
            }
        )
    return frozenset(targets)


def _installation_identity_targets(assistant: AssistantIdentity) -> frozenset[str]:
    short_name = _short_name(assistant)
    if short_name is None:
        return _identity_targets(assistant)
    return _identity_targets(assistant) | {
        short_name,
        f"a {short_name}",
        f"o {short_name}",
        f"the {short_name}",
    }


def installation_only_requested(message: object, assistants: Iterable[AssistantIdentity]) -> bool:
    """Recognize only an exact install command bound to every admitted plan identity."""
    planned = tuple(assistants)
    targets = _installation_targets(message)
    if not planned or not targets or len(targets) != len(planned):
        return False
    selected: set[str] = set()
    for target in targets:
        matches = tuple(assistant for assistant in planned if target in _installation_identity_targets(assistant))
        if len(matches) != 1:
            return False
        selected.add(matches[0].assistant_id)
    return selected == {assistant.assistant_id for assistant in planned}


def _short_name(capability: AssistantIdentity) -> str | None:
    tokens = tuple(
        token for token in _search_text(capability.name).split() if token not in _GENERIC_ASSISTANT_NAME_TOKENS
    )
    return " ".join(tokens) or None


def _short_name_target(target: str, capability: Capability) -> str | None:
    short_name = _short_name(capability)
    if short_name is None:
        return None
    forms = {short_name, f"a {short_name}", f"o {short_name}", f"the {short_name}"}
    return short_name if target in forms else None


def _short_name_is_unique(
    short_name: str, selected: UninstallCandidate, candidates: tuple[UninstallCandidate, ...]
) -> bool:
    return all(
        candidate is selected or f" {short_name} " not in f" {_search_text(candidate.assistant.name)} "
        for candidate in candidates
    )


def select_uninstall_candidate(
    message: object,
    candidates: tuple[UninstallCandidate, ...],
) -> UninstallCandidate | None:
    """Select one installed Assistant only from a directly bound destructive request."""
    request = _uninstall_request(message)
    if request is None:
        return None
    target, allows_short_name = request
    matches = tuple(candidate for candidate in candidates if target in _identity_targets(candidate.assistant))
    if len(matches) == 1:
        return matches[0]
    if matches or not allows_short_name:
        return None
    short_matches = tuple(
        (candidate, short_name)
        for candidate in candidates
        if (short_name := _short_name_target(target, candidate.assistant)) is not None
    )
    if len(short_matches) != 1:
        return None
    candidate, short_name = short_matches[0]
    return candidate if _short_name_is_unique(short_name, candidate, candidates) else None


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
