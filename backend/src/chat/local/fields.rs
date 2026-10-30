//! What a completed turn's reply may carry beside its text: its usage, its Browser files, and at most one Routine card,
//! question, or refusal (ADR-0101, ADR-0122, ADR-0117).

use team_protocol::routine_proposal as routine_proposal_contract;

use crate::json::Value;

/// A done event's public fields.
pub const DONE_FIELDS: [&str; 4] = ["team_id", "team_name", "reply", "clarification"];
/// What the turn consumed.
pub const USAGE_FIELD: &str = "usage";
/// A recording turn's card.
pub const PROPOSAL_FIELD: &str = "routine_proposal";
/// A refinement turn's card.
pub const REFINEMENT_FIELD: &str = "routine_refinement";
/// Why a recording made no card.
pub const REFUSAL_FIELD: &str = "routine_refusal";
/// What Team must ask the person first.
pub const QUESTION_FIELD: &str = "routine_question";
/// The Routine fields, in their order.
pub const ROUTINE_FIELDS: [&str; 4] = [
    PROPOSAL_FIELD,
    REFINEMENT_FIELD,
    REFUSAL_FIELD,
    QUESTION_FIELD,
];
/// The files a Browser turn kept and lost.
pub const BROWSER_FIELD: &str = "browser";
/// Every optional field of a done event.
pub const OPTIONAL_DONE_FIELDS: [&str; 6] = [
    USAGE_FIELD,
    BROWSER_FIELD,
    PROPOSAL_FIELD,
    REFINEMENT_FIELD,
    REFUSAL_FIELD,
    QUESTION_FIELD,
];

fn canonical_routine_field(name: &str, value: &Value) -> Option<Value> {
    match name {
        PROPOSAL_FIELD => routine_proposal_contract::canonical_proposal(value).cloned(),
        REFINEMENT_FIELD => routine_proposal_contract::canonical_refinement(value).cloned(),
        REFUSAL_FIELD => routine_proposal_contract::canonical_refusal(value),
        _ => routine_proposal_contract::canonical_question(value).cloned(),
    }
}

/// A reply's Routine card, question, or refusal in its closed form, at most one and never beside a clarification;
/// `None` when the reply carries anything else.
#[must_use]
pub fn admit_routine_fields(body: &Value, clarification: &Value) -> Option<Vec<(String, Value)>> {
    let present: Vec<&str> = ROUTINE_FIELDS
        .into_iter()
        .filter(|name| crate::json::contains(body, name))
        .collect();
    match present.as_slice() {
        [] => Some(Vec::new()),
        [name] if *clarification == Value::Null => {
            let admitted = canonical_routine_field(name, body.get(name)?)?;
            Some(vec![((*name).to_owned(), admitted)])
        }
        _ => None,
    }
}
