//! One Assistant's or staged snapshot's summary or page in one interface language, read by Team from a pack, and the
//! interface registry of the Space's Assistant names (ADR-0091).

use super::{bridge, transport::Team};
use crate::{
    fault::{Fault, Outcome, Reply},
    json::{self, Value},
};

/// The most Assistants the interface registry names.
pub const MAX_ASSISTANTS: usize = 128;

/// One bounded, trimmed, control-free line of Assistant display text from a catalog.
fn catalog_text(value: &Value, maximum: usize) -> Option<&str> {
    let text = json::as_str(value)?;
    let length = text.chars().count();
    let admitted = (1..=maximum).contains(&length)
        && team_protocol::python::text::strip(text) == text
        && !text
            .chars()
            .any(|character| (character as u32) < 32 || character as u32 == 127);
    admitted.then_some(text)
}

/// The Space's admissible Assistants by name: each identity once, with its catalog name.
fn names(response: &Reply) -> Option<Vec<(String, String)>> {
    let fields = bridge::trace_envelope(&response.body, &["assistants"])?;
    let fields: Vec<&str> = fields.iter().map(String::as_str).collect();
    if !json::has_exactly(&response.body, &fields) {
        return None;
    }
    let items = response
        .get("assistants")
        .and_then(json::as_array)
        .filter(|items| items.len() <= MAX_ASSISTANTS)?;
    let mut named: Vec<(String, String)> = Vec::with_capacity(items.len());
    for item in items {
        if !json::has_exactly(item, &["id", "title"]) {
            return None;
        }
        let raw = item.get("id")?;
        let id = crate::chat::payloads::assistant_id(raw).ok()?;
        if json::as_str(raw) != Some(id.as_str()) || named.iter().any(|(known, _)| *known == id) {
            return None;
        }
        let title = catalog_text(item.get("title")?, 80)?;
        named.push((id, title.to_owned()));
    }
    Some(named)
}

/// `assistants.registry`: the Space's Assistant names the interface shows, each identity with its catalog name.
///
/// # Errors
///
/// Returns 502 for an invalid registry.
pub async fn assistants_list(team: &Team) -> Outcome {
    let response = bridge::list_assistants(team).await;
    if !response.success() {
        return Ok(response);
    }
    let named =
        names(&response).ok_or_else(|| Fault::detail(502, "Team Assistant registry is invalid"))?;
    let assistants = named
        .into_iter()
        .map(|(id, title)| json::object(vec![("id", json::text(id)), ("title", json::text(title))]))
        .collect();
    Ok(Reply::ok(json::object(vec![(
        "assistants",
        Value::Array(assistants),
    )])))
}

/// A summary or a page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A summary.
    Summary,
    /// A page.
    Details,
}

impl Kind {
    const fn name(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Details => "details",
        }
    }
}

/// The canonical locale a summary or page is asked in.
///
/// # Errors
///
/// Returns 422 for any other locale.
pub fn canonical_locale(locale: &str, kind: Kind) -> Result<String, Fault> {
    team_protocol::payload::canonical_locale(&json::text(locale))
        .map(str::to_owned)
        .ok_or_else(|| Fault::detail(422, &format!("Assistant {} locale is invalid", kind.name())))
}

/// Exactly Team's summary or page in the requested locale, never another language.
///
/// A Team failure keeps its bounded status, code, and any retry hint; an answer outside the closed shape or in another
/// locale fails as invalid.
///
/// # Errors
///
/// Returns 502 for an invalid answer.
pub fn localized(result: Reply, canonical: &str, subject: &str, kind: Kind) -> Outcome {
    if result.status != 200 {
        return Ok(result);
    }
    let body = json::without(&result.body, "trace_id");
    let answer = match kind {
        Kind::Summary => team_protocol::payload::canonical_snapshot_summary(&body),
        Kind::Details => team_protocol::payload::canonical_assistant_details(&body),
    };
    match answer {
        Some(answer) if json::get_str(answer, "locale") == Some(canonical) => {
            Ok(Reply::ok(answer.clone()))
        }
        _ => Err(Fault::detail(
            502,
            &format!("{subject} {} is invalid", kind.name()),
        )),
    }
}

/// `assistants.summary`.
///
/// # Errors
///
/// Returns 422 for a locale, 400 for an id, or 502 for an invalid answer.
pub async fn assistant_summary(
    team: &Team,
    team_id: &str,
    assistant_id: &str,
    locale: &str,
) -> Outcome {
    let canonical = canonical_locale(locale, Kind::Summary)?;
    let result = bridge::assistant_summary(team, team_id, assistant_id, &canonical)
        .await
        .map_err(Fault::bad_request)?;
    localized(result, &canonical, "Assistant", Kind::Summary)
}

/// `assistants.details`: Team answers for the binding it runs, so the identity it returns must be the one asked for.
///
/// # Errors
///
/// As [`assistant_summary`].
pub async fn assistant_details(
    team: &Team,
    team_id: &str,
    assistant_id: &str,
    locale: &str,
) -> Outcome {
    let canonical = canonical_locale(locale, Kind::Details)?;
    let result = bridge::assistant_details(team, team_id, assistant_id, &canonical)
        .await
        .map_err(Fault::bad_request)?;
    let reply = localized(result, &canonical, "Assistant", Kind::Details)?;
    if reply.status == 200 && reply.get_str("assistant_id") != Some(assistant_id) {
        return Err(Fault::detail(502, "Assistant details are invalid"));
    }
    Ok(reply)
}

/// `snapshots.list`.
///
/// # Errors
///
/// Never: a Team failure is its answer.
pub async fn local_assistants_list(team: &Team) -> Outcome {
    Ok(bridge::list_local_assistants(team).await)
}

/// `snapshots.summary`: one staged snapshot's summary in the interface language, from its own pack.
///
/// # Errors
///
/// As [`assistant_summary`].
pub async fn local_assistant_summary(team: &Team, image_id: &str, locale: &str) -> Outcome {
    let canonical = canonical_locale(locale, Kind::Summary)?;
    let result = bridge::local_assistant_summary(team, image_id, &canonical)
        .await
        .map_err(Fault::bad_request)?;
    localized(result, &canonical, "Local Assistant", Kind::Summary)
}

/// `snapshots.details`: one staged snapshot's page in the interface language.
///
/// # Errors
///
/// As [`assistant_summary`].
pub async fn local_assistant_details(team: &Team, image_id: &str, locale: &str) -> Outcome {
    let canonical = canonical_locale(locale, Kind::Details)?;
    let result = bridge::local_assistant_details(team, image_id, &canonical)
        .await
        .map_err(Fault::bad_request)?;
    localized(result, &canonical, "Local Assistant", Kind::Details)
}

#[cfg(test)]
mod tests;
