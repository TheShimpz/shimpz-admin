"""Pure matching and textual decision rules for Local chat Assistant lifecycle proposals."""

import re
import secrets
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Literal

from chat import local_catalog, store_catalog
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import turn as turn_contract

UNINSTALL_PROPOSAL_TTL_SECONDS = 120
# The candidates a capability plan and an intent route each admit, Team's own bounds.
MAX_CAPABILITY_SHORTLIST = turn_contract.MAX_CAPABILITY_CANDIDATES
MAX_ROUTE_SHORTLIST = turn_contract.MAX_INTENT_ROUTE_CANDIDATES
_TERMINAL_PUNCTUATION = re.compile(r"[\s.!?,;:]+$")
_SPACELESS_RUN = re.compile(
    "[\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff\u3005-\u3007\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff"
    "\uf900-\ufaff\U00020000-\U0003ffff]+"
)
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
class AssistantReference:
    assistant_id: str
    name: str


def reference_from_item(value: object) -> AssistantReference | None:
    """Project one already-validated lifecycle item into identity-only memory."""
    if not isinstance(value, dict):
        return None
    assistant_id = value.get("id")
    name = value.get("name")
    if not isinstance(assistant_id, str) or not isinstance(name, str):
        return None
    return AssistantReference(assistant_id, name)


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
    locale: str | None
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
    """Fold text to space-separated words of letters, marks, and digits of any script.

    A nonempty result is the only objective eligibility rule; scores computed from it rank candidates and never gate.
    Runs of scripts written without spaces (Han, kana, Thai, Lao, Myanmar, Khmer) become words of their own.
    """
    folded = unicodedata.normalize("NFKC", _fold(value)).casefold()
    words = "".join(character if unicodedata.category(character)[0] in "LMN" else " " for character in folded)
    return " ".join(_SPACELESS_RUN.sub(lambda run: f" {run.group()} ", words).split())


def _word_tokens(word: str) -> tuple[str, ...]:
    if _SPACELESS_RUN.fullmatch(word):
        return tuple(word[index : index + 2] for index in range(len(word) - 1)) or (word,)
    return (word,) if len(word) > 1 and word not in _STOP_WORDS else ()


def _tokens(*values: str) -> frozenset[str]:
    return frozenset(token for value in values for word in _search_text(value).split() for token in _word_tokens(word))


def _contains_phrase(message: str, value: str) -> bool:
    """Match a whole phrase, requiring a word boundary only at an edge written in a spaced script."""
    phrase = _search_text(value)
    if not phrase:
        return False
    start = "" if _SPACELESS_RUN.match(phrase[0]) else r"(?<!\S)"
    end = "" if _SPACELESS_RUN.match(phrase[-1]) else r"(?!\S)"
    return re.search(start + re.escape(phrase) + end, message) is not None


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


def _bounded_pool[AssistantT](
    ranked: list[tuple[int, str, AssistantT]],
    limit: int,
) -> tuple[AssistantT, ...]:
    """Keep the model-facing selection pool within the planner bound, preferring stronger lexical signals.

    A tie across the bound would silently displace an equally ranked candidate, so it yields no pool. The kept pool
    is returned in the Assistant id order that the Team selection directory contract requires; scores only decide
    which candidates fit the bound.
    """
    if len(ranked) > limit and ranked[limit - 1][0] == ranked[limit][0]:
        return ()
    return tuple(item[2] for item in sorted(ranked[:limit], key=lambda item: item[1]))


def capability_candidates(
    message: str,
    catalog: tuple[DirectoryAssistant, ...],
    *,
    installed_ids: frozenset[str],
    enabled: tuple[Capability, ...],
) -> tuple[tuple[Capability, ...], tuple[DirectoryAssistant, ...]]:
    """Return the bounded enabled and installable candidates for semantic intent planning.

    The planner, not keyword overlap, decides whether an Assistant serves the objective. Installable candidates take
    the bounded slots first, ordered lexically only when they exceed the bound; a tie across that bound, or no
    installable candidate, means no planning signal. Enabled capabilities fill the remaining slots as context so the
    planner can prefer what is already installed.
    """
    search = _search_text(message)
    if not search:
        return (), ()
    tokens = _tokens(message)
    installable = sorted(
        (
            (_candidate_score(search, tokens, candidate), candidate.assistant_id, candidate)
            for candidate in catalog
            if candidate.assistant_id not in installed_ids
        ),
        key=lambda item: (-item[0], item[1]),
    )
    kept_installable = _bounded_pool(installable, MAX_CAPABILITY_SHORTLIST)
    if not kept_installable:
        return (), ()
    context = sorted(
        (
            (_capability_score(search, tokens, capability), capability.assistant_id, capability)
            for capability in enabled
        ),
        key=lambda item: (-item[0], item[1]),
    )
    kept_enabled = tuple(item[2] for item in context[: MAX_CAPABILITY_SHORTLIST - len(kept_installable)])
    return (
        tuple(sorted(kept_enabled, key=lambda item: item.assistant_id)),
        tuple(sorted(kept_installable, key=lambda item: item.assistant_id)),
    )


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
    """Order a bounded install directory; the structured selection decides by intent."""
    search = _search_text(query)
    tokens = _tokens(query)
    if not search:
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
    return _bounded_pool(ranked, MAX_ROUTE_SHORTLIST)


def uninstall_shortlist(
    query: str,
    candidates: tuple[UninstallCandidate, ...],
) -> tuple[UninstallCandidate, ...]:
    """Order a bounded uninstall directory from installed id/name data; selection decides by intent."""
    search = _search_text(query)
    tokens = _tokens(query)
    if not search:
        return ()

    def score(candidate: UninstallCandidate) -> int:
        assistant = candidate.assistant
        return _directory_identity_score(search, tokens, assistant.assistant_id, assistant.name)

    ranked = sorted(
        ((score(candidate), candidate.assistant.assistant_id, candidate) for candidate in candidates),
        key=lambda item: (-item[0], item[1]),
    )
    return _bounded_pool(ranked, MAX_ROUTE_SHORTLIST)


def _proposal_id(team_id: str, now: float, proposal_id_factory: Callable[[], str]) -> str:
    proposal_id = proposal_id_factory()
    if team_contract.TEAM_ID_RE.fullmatch(team_id) is None or _PROPOSAL_ID.fullmatch(proposal_id) is None or now < 0:
        raise ValueError("invalid Assistant lifecycle proposal")
    return proposal_id


def create_uninstall_proposal(
    team_id: str,
    candidate: UninstallCandidate,
    *,
    locale: object,
    now: float,
    proposal_id_factory: Callable[[], str] = lambda: secrets.token_hex(16),
) -> UninstallProposal:
    proposal_id = _proposal_id(team_id, now, proposal_id_factory)
    return UninstallProposal(
        proposal_id=proposal_id,
        team_id=team_id,
        assistant=candidate.assistant,
        assistant_version=candidate.version,
        locale=team_contract.canonical_locale(locale),
        expires_at=now + UNINSTALL_PROPOSAL_TTL_SECONDS,
    )
