//! What a stored chat reply carries beside its text: its Routine card, question, or refusal, and its receipt. Pure
//! shape checks, the same when a reply is written and when its row is read back.

use super::Invalid;
use crate::{
    chat::local::{self, MAX_PUBLIC_PROGRESS_EVENTS},
    json::{self, Value},
};

/// A stored reply's Routine card, question, or refusal, exactly in the closed form a live reply admits it in.
///
/// # Errors
///
/// Returns [`Invalid`] for anything else.
pub fn routine_reply(
    value: &Value,
    clarification: &Value,
) -> Result<Vec<(String, Value)>, Invalid> {
    let admitted = local::admit_routine_fields(value, clarification)
        .ok_or(Invalid("chat history Routine reply is invalid"))?;
    if admitted.iter().any(|(name, item)| {
        value
            .get(name)
            .is_none_or(|stored| !json::equal(item, stored))
    }) {
        return Err(Invalid("chat history Routine reply is invalid"));
    }
    Ok(admitted)
}

fn receipt_event(item: &Value, previous: Option<(i64, i64)>) -> Result<Value, Invalid> {
    let invalid = Invalid("chat history receipt is invalid");
    json::members(item).ok_or(invalid)?;
    let segment = json::get(item, "segment").and_then(json::as_int);
    let seq = json::get(item, "seq").and_then(json::as_int);
    let event = json::without(&json::without(item, "segment"), "seq");
    let public = local::canonical_public_progress(&event).map_err(|_| invalid)?;
    let (Some(segment), Some(seq)) = (segment, seq) else {
        return Err(invalid);
    };
    let (last_segment, last_seq) = previous.unwrap_or((0, 0));
    let maximum = i64::try_from(MAX_PUBLIC_PROGRESS_EVENTS).unwrap_or(i64::MAX);
    let ordered = (segment == last_segment && seq > last_seq)
        || (previous.is_some() && segment == last_segment + 1);
    if !json::equal(&public, &event)
        || json::get_str(&public, "origin") != Some("team")
        || !(1..=maximum).contains(&seq)
        || !ordered
    {
        return Err(invalid);
    }
    let mut members = vec![
        ("segment".to_owned(), json::int(segment)),
        ("seq".to_owned(), json::int(seq)),
    ];
    members.extend(json::members(&public).unwrap_or_default().iter().cloned());
    Ok(Value::Object(members))
}

/// A reply's receipt (ADR-0082): the Team progress its page was shown, in the order it arrived, each event numbered by
/// its delivery from 0 and, within a delivery, by an increasing sequence.
///
/// # Errors
///
/// Returns [`Invalid`] for anything else.
pub fn receipt(value: &Value) -> Result<Vec<Value>, Invalid> {
    let items = json::as_array(value)
        .filter(|items| (1..=MAX_PUBLIC_PROGRESS_EVENTS).contains(&items.len()))
        .ok_or(Invalid("chat history receipt is invalid"))?;
    let mut receipt: Vec<Value> = Vec::with_capacity(items.len());
    for item in items {
        let previous = receipt.last().map(|last| {
            let number = |key| {
                json::get(last, key)
                    .and_then(json::as_int)
                    .unwrap_or_default()
            };
            (number("segment"), number("seq"))
        });
        receipt.push(receipt_event(item, previous)?);
    }
    Ok(receipt)
}
