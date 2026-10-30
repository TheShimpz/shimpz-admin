//! Pure matching and textual decision rules for Local chat Assistant lifecycle proposals.

use team_protocol::{
    identifiers::TEAM_ID_RE,
    payload::canonical_locale,
    python::text,
    turn::{MAX_CAPABILITY_CANDIDATES, MAX_INTENT_ROUTE_CANDIDATES},
};
use unicode_normalization::{UnicodeNormalization, char::canonical_combining_class};

use crate::{chat::catalog::Offer, json};

/// How long an uninstall proposal waits for its confirmation.
pub const UNINSTALL_PROPOSAL_TTL_SECONDS: i64 = 120;
const STOP_WORDS: [&str; 21] = [
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
];
const UNINSTALL_AFFIRMATIVE: [&str; 18] = [
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
];
const UNINSTALL_NEGATIVE: [&str; 15] = [
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
];
const CAPABILITY_CONTINUATIONS: [&str; 16] = [
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
];

/// One complete user response to a pending decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Yes.
    Confirm,
    /// No.
    Cancel,
    /// Anything else.
    Ambiguous,
}

/// One installed Assistant's capability as its Team's binding declares it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capability {
    /// Its id.
    pub assistant_id: String,
    /// Its name.
    pub name: String,
    /// Its summary.
    pub summary: String,
    /// Its Action ids.
    pub actions: Vec<String>,
    /// The providers of its Integrations.
    pub integrations: Vec<String>,
}

/// The identity of the Assistant a recent lifecycle turn named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssistantReference {
    /// Its id.
    pub assistant_id: String,
    /// Its name.
    pub name: String,
}

/// The identity of one already-validated lifecycle item.
#[must_use]
pub fn reference_from_item(value: &json::Value) -> Option<AssistantReference> {
    Some(AssistantReference {
        assistant_id: json::get_str(value, "id")?.to_owned(),
        name: json::get_str(value, "name")?.to_owned(),
    })
}

/// One installed Assistant an uninstall request may name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UninstallCandidate {
    /// Its capability.
    pub assistant: Capability,
    /// Its installed version.
    pub version: String,
    /// `local` or `published`.
    pub provenance: String,
}

/// The one installed Assistant an uninstall request selected, and the Creator its exact binding declares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UninstallTarget {
    /// The candidate.
    pub candidate: UninstallCandidate,
    /// Its binding's first Creator.
    pub creator: String,
}

/// One socket-bound uninstall proposal awaiting its confirmation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UninstallProposal {
    /// Its id.
    pub proposal_id: String,
    /// The Team.
    pub team_id: String,
    /// The Assistant.
    pub assistant: Capability,
    /// The version it would uninstall.
    pub assistant_version: String,
    /// `local` or `published`.
    pub provenance: String,
    /// Its binding's first Creator.
    pub creator: String,
    /// The interface language.
    pub locale: Option<String>,
    /// When it expires on the monotonic clock, in milliseconds.
    pub expires_at_ms: i64,
}

impl UninstallProposal {
    /// Whether it still answers `team_id` at `now_ms`.
    #[must_use]
    pub fn valid_for(&self, team_id: &str, now_ms: i64) -> bool {
        team_id == self.team_id && now_ms < self.expires_at_ms
    }
}

fn fold(value: &str) -> String {
    text::casefold(value)
        .nfkd()
        .filter(|character| canonical_combining_class(*character) == 0)
        .collect()
}

fn confirmation(value: &str) -> String {
    let folded = fold(value);
    let joined = text::strip(&folded)
        .split(text::isspace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    joined
        .trim_end_matches(|character: char| {
            text::isspace(character) || ".!?,;:".contains(character)
        })
        .to_owned()
}

fn classify(value: &str, affirmative: &[&str], negative: &[&str]) -> Decision {
    if text::strip(value).is_empty() || text::len(value) > 160 {
        return Decision::Ambiguous;
    }
    let normalized = confirmation(value);
    if affirmative.contains(&normalized.as_str()) {
        Decision::Confirm
    } else if negative.contains(&normalized.as_str()) {
        Decision::Cancel
    } else {
        Decision::Ambiguous
    }
}

/// Classifies only a complete uninstall-specific response.
#[must_use]
pub fn classify_uninstall_confirmation(value: &str) -> Decision {
    classify(value, &UNINSTALL_AFFIRMATIVE, &UNINSTALL_NEGATIVE)
}

/// Accepts only one complete request to resume a prior capability objective.
#[must_use]
pub fn capability_continuation(value: &str) -> bool {
    classify(value, &CAPABILITY_CONTINUATIONS, &[]) == Decision::Confirm
}

/// A character of a script written without spaces.
fn spaceless(character: char) -> bool {
    matches!(character as u32,
        0x0e00..=0x0eff | 0x1000..=0x109f | 0x1780..=0x17ff | 0x3005..=0x3007 | 0x3040..=0x30ff | 0x31f0..=0x31ff
        | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x2_0000..=0x3_ffff)
}

/// Text folded to space-separated words of letters, marks, and digits of any script; each run of a spaceless script is
/// a word of its own.
#[must_use]
pub fn search_text(value: &str) -> String {
    let folded = text::casefold(&fold(value).nfkc().collect::<String>());
    let mut spaced = String::with_capacity(folded.len());
    let mut in_run = false;
    for character in folded.chars() {
        let kept = matches!(
            text::category(character).as_bytes().first(),
            Some(b'L' | b'M' | b'N')
        );
        let character = if kept { character } else { ' ' };
        let run = spaceless(character);
        if run != in_run {
            spaced.push(' ');
        }
        in_run = run;
        spaced.push(character);
    }
    spaced
        .split(' ')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn word_tokens(word: &str) -> Vec<String> {
    let characters: Vec<char> = word.chars().collect();
    if !characters.is_empty() && characters.iter().all(|character| spaceless(*character)) {
        if characters.len() < 2 {
            return vec![word.to_owned()];
        }
        return characters
            .windows(2)
            .map(|pair| pair.iter().collect())
            .collect();
    }
    if characters.len() > 1 && !STOP_WORDS.contains(&word) {
        vec![word.to_owned()]
    } else {
        Vec::new()
    }
}

fn tokens(values: &[&str]) -> Vec<String> {
    let mut tokens: Vec<String> = values
        .iter()
        .flat_map(|value| {
            search_text(value)
                .split(' ')
                .flat_map(word_tokens)
                .collect::<Vec<_>>()
        })
        .collect();
    tokens.sort_unstable();
    tokens.dedup();
    tokens
}

/// Whether `message` (already search text) holds the whole phrase `value`, with a word boundary only at an edge
/// written in a spaced script.
fn contains_phrase(message: &str, value: &str) -> bool {
    let phrase = search_text(value);
    let (Some(first), Some(last)) = (phrase.chars().next(), phrase.chars().last()) else {
        return false;
    };
    message
        .char_indices()
        .map(|(start, _)| start)
        .filter(|start| message[*start..].starts_with(&phrase))
        .any(|start| {
            let end = start + phrase.len();
            let before = message[..start].chars().next_back();
            let after = message[end..].chars().next();
            (spaceless(first) || before.is_none_or(char::is_whitespace))
                && (spaceless(last) || after.is_none_or(char::is_whitespace))
        })
}

/// What one candidate is scored on.
struct Fields<'a> {
    assistant_id: &'a str,
    name: &'a str,
    summary: &'a str,
    integrations: &'a [String],
    actions: &'a [String],
}

fn score_fields(message: &str, message_tokens: &[String], fields: &Fields<'_>) -> usize {
    let mut score = 0;
    if contains_phrase(message, fields.assistant_id) || contains_phrase(message, fields.name) {
        score = 100;
    }
    if fields
        .integrations
        .iter()
        .any(|provider| contains_phrase(message, provider))
    {
        score = score.max(90);
    }
    if fields
        .actions
        .iter()
        .any(|action| contains_phrase(message, action))
    {
        score = score.max(70);
    }
    let mut values = vec![fields.assistant_id, fields.name, fields.summary];
    values.extend(fields.integrations.iter().map(String::as_str));
    values.extend(fields.actions.iter().map(String::as_str));
    let terms = tokens(&values);
    let overlap = message_tokens
        .iter()
        .filter(|token| terms.contains(token))
        .count();
    if overlap >= 2 {
        score = score.max(overlap * 20);
    }
    score
}

fn offer_score(message: &str, tokens: &[String], offer: &Offer) -> usize {
    score_fields(
        message,
        tokens,
        &Fields {
            assistant_id: offer.assistant_id(),
            name: offer.name(),
            summary: offer.summary(),
            integrations: offer.integrations(),
            actions: offer.actions(),
        },
    )
}

fn capability_score(message: &str, tokens: &[String], capability: &Capability) -> usize {
    score_fields(
        message,
        tokens,
        &Fields {
            assistant_id: &capability.assistant_id,
            name: &capability.name,
            summary: &capability.summary,
            integrations: &capability.integrations,
            actions: &capability.actions,
        },
    )
}

/// Scored candidates, strongest first and ties in Assistant id order.
fn ranked<T>(mut scored: Vec<(usize, String, T)>) -> Vec<(usize, String, T)> {
    scored.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    scored
}

/// The model-facing pool within `limit`, in Assistant id order; a tie across the bound yields no pool.
fn bounded_pool<T>(ranked: Vec<(usize, String, T)>, limit: usize) -> Vec<T> {
    if ranked.len() > limit && ranked[limit - 1].0 == ranked[limit].0 {
        return Vec::new();
    }
    let mut kept: Vec<(usize, String, T)> = ranked.into_iter().take(limit).collect();
    kept.sort_by(|left, right| left.1.cmp(&right.1));
    kept.into_iter().map(|(_, _, item)| item).collect()
}

/// The bounded enabled and installable candidates for semantic capability planning: installable candidates take the
/// slots first; enabled capabilities fill the rest as context. No installable candidate means no planning signal.
#[must_use]
pub fn capability_candidates(
    message: &str,
    catalog: &[Offer],
    installed_ids: &[String],
    enabled: &[Capability],
) -> (Vec<Capability>, Vec<Offer>) {
    let search = search_text(message);
    if search.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let message_tokens = tokens(&[message]);
    let installable = ranked(
        catalog
            .iter()
            .filter(|offer| !installed_ids.iter().any(|id| id == offer.assistant_id()))
            .map(|offer| {
                (
                    offer_score(&search, &message_tokens, offer),
                    offer.assistant_id().to_owned(),
                    offer.clone(),
                )
            })
            .collect(),
    );
    let kept_installable = bounded_pool(installable, MAX_CAPABILITY_CANDIDATES);
    if kept_installable.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let context = ranked(
        enabled
            .iter()
            .map(|capability| {
                (
                    capability_score(&search, &message_tokens, capability),
                    capability.assistant_id.clone(),
                    capability.clone(),
                )
            })
            .collect(),
    );
    let mut kept_enabled: Vec<Capability> = context
        .into_iter()
        .take(MAX_CAPABILITY_CANDIDATES - kept_installable.len())
        .map(|(_, _, capability)| capability)
        .collect();
    kept_enabled.sort_by(|left, right| left.assistant_id.cmp(&right.assistant_id));
    (kept_enabled, kept_installable)
}

fn identity_score(query: &str, query_tokens: &[String], assistant_id: &str, name: &str) -> usize {
    if contains_phrase(query, assistant_id) || contains_phrase(query, name) {
        return 100;
    }
    let identity = tokens(&[assistant_id, name]);
    let overlap = query_tokens
        .iter()
        .filter(|token| identity.contains(token))
        .count();
    if overlap > 0 && query_tokens.iter().all(|token| identity.contains(token)) {
        60 + overlap.min(4) * 5
    } else {
        0
    }
}

/// A bounded install directory; the structured selection decides by intent.
#[must_use]
pub fn install_shortlist(query: &str, candidates: &[Offer]) -> Vec<Offer> {
    let search = search_text(query);
    if search.is_empty() {
        return Vec::new();
    }
    let query_tokens = tokens(&[query]);
    let scored = candidates
        .iter()
        .map(|offer| {
            let score = identity_score(&search, &query_tokens, offer.assistant_id(), offer.name())
                .max(offer_score(&search, &query_tokens, offer));
            (score, offer.assistant_id().to_owned(), offer.clone())
        })
        .collect();
    bounded_pool(ranked(scored), MAX_INTENT_ROUTE_CANDIDATES)
}

/// A bounded uninstall directory from installed id and name; the selection decides by intent.
#[must_use]
pub fn uninstall_shortlist(
    query: &str,
    candidates: &[UninstallCandidate],
) -> Vec<UninstallCandidate> {
    let search = search_text(query);
    if search.is_empty() {
        return Vec::new();
    }
    let query_tokens = tokens(&[query]);
    let scored = candidates
        .iter()
        .map(|candidate| {
            let assistant = &candidate.assistant;
            let score = identity_score(
                &search,
                &query_tokens,
                &assistant.assistant_id,
                &assistant.name,
            );
            (score, assistant.assistant_id.clone(), candidate.clone())
        })
        .collect();
    bounded_pool(ranked(scored), MAX_INTENT_ROUTE_CANDIDATES)
}

/// One proposal to uninstall `target` from `team_id`, awaiting its confirmation from `now_ms`; `None` for an invalid
/// Team id.
#[must_use]
pub fn create_uninstall_proposal(
    team_id: &str,
    target: &UninstallTarget,
    locale: Option<&str>,
    now_ms: i64,
) -> Option<UninstallProposal> {
    if !TEAM_ID_RE.is_full(team_id) || now_ms < 0 {
        return None;
    }
    let candidate = &target.candidate;
    Some(UninstallProposal {
        proposal_id: crate::random::hex(16),
        team_id: team_id.to_owned(),
        assistant: candidate.assistant.clone(),
        assistant_version: candidate.version.clone(),
        provenance: candidate.provenance.clone(),
        creator: target.creator.clone(),
        locale: locale.and_then(|locale| canonical_locale(&json::text(locale)).map(str::to_owned)),
        expires_at_ms: now_ms + UNINSTALL_PROPOSAL_TTL_SECONDS * 1000,
    })
}

#[cfg(test)]
mod tests;
