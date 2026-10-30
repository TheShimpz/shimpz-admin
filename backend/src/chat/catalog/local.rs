//! The strict bounded planning projection of the Space's staged Local Assistant snapshots.

use team_protocol::{
    payload::{MAX_LOCAL_ASSISTANTS, canonical_local_assistant, canonical_snapshot_summary},
    python::datetime::{fromisoformat, ymd_to_ord},
};

use crate::{
    fault::{Fault, Reply},
    json::{self, Value},
    team::{bridge, transport::Team},
};

/// One labeled staged snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalAssistant {
    /// Its Assistant id.
    pub assistant_id: String,
    /// Its name.
    pub name: String,
    /// Its summary.
    pub summary: String,
    /// The exact staged image.
    pub image_id: String,
    /// The providers of its Integrations.
    pub integrations: Vec<String>,
    /// Its Action ids.
    pub actions: Vec<String>,
    /// Its version.
    pub assistant_version: String,
    /// The first Creator its stage labels declare.
    pub creator: String,
    /// Its creation instant in UTC microseconds.
    pub created_at: i64,
}

/// The staged snapshots a plan may offer, and every Assistant identity staged in this Space: a staged identity Team did
/// not admit is never offered, yet still shadows a publication of the same Assistant (ADR-0060).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LocalInventory {
    /// The offerable snapshots, by Assistant id.
    pub offerable: Vec<LocalAssistant>,
    /// Every staged identity.
    pub staged_ids: Vec<String>,
}

/// The inventory is unavailable or invalid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Invalid;

/// An admitted, zone-qualified creation time as UTC microseconds.
fn instant(text: &str) -> Option<i64> {
    let parsed = fromisoformat(text).ok()?;
    let days = i64::from(ymd_to_ord(parsed.year, parsed.month, parsed.day));
    let seconds = days * 86_400
        + i64::from(parsed.hour) * 3600
        + i64::from(parsed.minute) * 60
        + i64::from(parsed.second);
    Some(seconds * 1_000_000 + i64::from(parsed.microsecond) - parsed.offset?)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(json::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(json::as_str)
        .map(str::to_owned)
        .collect()
}

fn assistant(entry: &Value) -> Option<(LocalAssistant, bool)> {
    let text = |key| json::get_str(entry, key).map(str::to_owned);
    let assistant = LocalAssistant {
        assistant_id: text("assistant_id")?,
        name: text("name")?,
        summary: text("summary")?,
        image_id: text("image_id")?,
        integrations: strings(entry.get("integrations")),
        actions: strings(entry.get("actions")),
        assistant_version: text("assistant_version")?,
        creator: strings(entry.get("declared_creators")).into_iter().next()?,
        created_at: instant(json::get_str(entry, "created_at")?)?,
    };
    Some((
        assistant,
        json::get_str(entry, "admission") == Some("admissible"),
    ))
}

/// The newest exact staged image of every Local identity Team admitted, and every staged id. An identity with any
/// image whose labels Team refused is never offered: that image has no creation time to rank it.
///
/// # Errors
///
/// Returns [`Invalid`] for an unavailable or invalid inventory.
pub fn primary(response: &Reply) -> Result<LocalInventory, Invalid> {
    let entries = entries(response)?;
    let labels_invalid = |entry: &Value| json::get_str(entry, "reason") == Some("labels-invalid");
    let mut unlabeled: Vec<String> = entries
        .iter()
        .filter(|entry| labels_invalid(entry))
        .filter_map(|entry| json::get_str(entry, "assistant_id").map(str::to_owned))
        .collect();
    let newest = newest(
        entries
            .iter()
            .copied()
            .filter(|entry| !labels_invalid(entry)),
    )?;
    let mut staged_ids: Vec<String> = newest
        .iter()
        .map(|(assistant, _)| assistant.assistant_id.clone())
        .collect();
    let offerable = newest
        .into_iter()
        .filter(|(assistant, offerable)| *offerable && !unlabeled.contains(&assistant.assistant_id))
        .map(|(assistant, _)| assistant)
        .collect();
    staged_ids.append(&mut unlabeled);
    staged_ids.sort_unstable();
    staged_ids.dedup();
    Ok(LocalInventory {
        offerable,
        staged_ids,
    })
}

/// Every admitted inventory entry, each staged image once.
fn entries(response: &Reply) -> Result<Vec<&Value>, Invalid> {
    let body = &response.body;
    if !response.success() || !bridge::traced_exactly(body, &["assistants"]) {
        return Err(Invalid);
    }
    let raw = body
        .get("assistants")
        .and_then(json::as_array)
        .filter(|raw| raw.len() <= MAX_LOCAL_ASSISTANTS)
        .ok_or(Invalid)?;
    let entries: Vec<&Value> = raw
        .iter()
        .map(canonical_local_assistant)
        .collect::<Option<_>>()
        .ok_or(Invalid)?;
    let mut images: Vec<&str> = entries
        .iter()
        .filter_map(|entry| json::get_str(entry, "image_id"))
        .collect();
    images.sort_unstable();
    images.dedup();
    if images.len() == entries.len() {
        Ok(entries)
    } else {
        Err(Invalid)
    }
}

/// The newest image of every labeled identity, by creation time then image id, in Assistant id order.
fn newest<'a>(
    entries: impl Iterator<Item = &'a Value>,
) -> Result<Vec<(LocalAssistant, bool)>, Invalid> {
    let mut newest: Vec<(LocalAssistant, bool)> = Vec::new();
    for entry in entries {
        let (candidate, offerable) = assistant(entry).ok_or(Invalid)?;
        let known = newest
            .iter_mut()
            .find(|(known, _)| known.assistant_id == candidate.assistant_id);
        match known {
            Some(current)
                if (candidate.created_at, &candidate.image_id)
                    > (current.0.created_at, &current.0.image_id) =>
            {
                *current = (candidate, offerable);
            }
            Some(_) => {}
            None => newest.push((candidate, offerable)),
        }
    }
    newest.sort_by(|left, right| left.0.assistant_id.cmp(&right.0.assistant_id));
    Ok(newest)
}

/// One staged snapshot's summary in exactly one interface language, as Team reads it from the snapshot's own pack
/// (ADR-0091); never the English summary in its place.
///
/// # Errors
///
/// Returns the Team request's fault, or [`Fault::Internal`] for a summary that is unavailable or in another language.
pub async fn localized_summary(
    team: &Team,
    assistant: &LocalAssistant,
    locale: &str,
) -> Result<String, Fault> {
    let response = bridge::local_assistant_summary(team, &assistant.image_id, locale).await?;
    if response.status != 200 {
        return Err(Fault::Internal);
    }
    let body = json::without(&response.body, "trace_id");
    canonical_snapshot_summary(&body)
        .filter(|summary| json::get_str(summary, "locale") == Some(locale))
        .and_then(|summary| json::get_str(summary, "summary"))
        .map(str::to_owned)
        .ok_or(Fault::Internal)
}
