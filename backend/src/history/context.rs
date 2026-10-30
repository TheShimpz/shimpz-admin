//! Bounded untrusted conversation evidence projected from Local chat history.

use team_protocol::{
    payload::{MAX_CONVERSATION_CHARS, MAX_CONVERSATION_ENTRIES, MAX_CONVERSATION_TEXT_CHARS},
    python::text,
    turn::MAX_OBJECTIVE_CHARS,
};

use crate::json::{self, Value};

/// The most entries a turn's conversation window carries.
pub const MAX_ENTRIES: usize = MAX_CONVERSATION_ENTRIES;
/// The longest text of one entry.
pub const MAX_TEXT_CHARS: usize = MAX_CONVERSATION_TEXT_CHARS;
/// The longest window in total.
pub const MAX_TOTAL_CHARS: usize = MAX_CONVERSATION_CHARS;
/// What a truncated entry's middle is replaced with.
pub const TRUNCATION_MARKER: char = '…';

/// One conversation entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// `user` or `assistant`.
    pub role: &'static str,
    /// Its text.
    pub text: String,
    /// Whether its middle was cut.
    pub truncated: bool,
}

impl Entry {
    /// The entry as Team's wire carries it.
    #[must_use]
    pub fn wire(&self) -> Value {
        json::object(vec![
            ("role", json::text(self.role)),
            ("text", json::text(&self.text)),
            ("truncated", Value::Bool(self.truncated)),
        ])
    }
}

/// The text is not admissible conversation text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Invalid(pub &'static str);

const LAYOUT_CONTROLS: [char; 3] = ['\n', '\r', '\t'];

fn printable_with_layout(text: &str) -> bool {
    text::isprintable(text) || text::isprintable(&text.replace(LAYOUT_CONTROLS, ""))
}

fn admissible(character: char) -> bool {
    let category = text::category(character);
    !category.starts_with('C') || category == "Cf" || LAYOUT_CONTROLS.contains(&character)
}

/// Canonical conversation text: NFC, non-empty, trimmed, and free of controls but layout and format characters.
///
/// # Errors
///
/// Returns [`Invalid`] for any other text.
pub fn canonical_text(value: &str) -> Result<String, Invalid> {
    let canonical = text::nfc(value);
    if canonical.is_empty() || text::strip(&canonical) != canonical {
        return Err(Invalid("conversation text is invalid"));
    }
    if printable_with_layout(&canonical) || canonical.chars().all(admissible) {
        Ok(canonical)
    } else {
        Err(Invalid("conversation text is invalid"))
    }
}

/// A person's message as Team's routes admit it: NFC within Team's bound, each character Team refuses replaced by
/// U+FFFD, trimmed. Only the routing objective is projected; the chat turn keeps the message as written.
#[must_use]
pub fn routable_text(value: &str) -> String {
    let canonical: String = text::nfc(value).chars().take(MAX_OBJECTIVE_CHARS).collect();
    if printable_with_layout(&canonical) {
        return text::strip(&canonical).to_owned();
    }
    let replaced: String = canonical
        .chars()
        .map(|character| {
            if admissible(character) {
                character
            } else {
                '\u{fffd}'
            }
        })
        .collect();
    text::strip(&replaced).to_owned()
}

/// One entry of `role`, its text cut in the middle to its bound.
///
/// # Errors
///
/// Returns [`Invalid`] for another role or inadmissible text.
pub fn bounded(role: &str, value: &str) -> Result<Entry, Invalid> {
    let role = match role {
        "user" => "user",
        "assistant" => "assistant",
        _ => return Err(Invalid("conversation role is invalid")),
    };
    let canonical = canonical_text(value)?;
    let length = text::len(&canonical);
    if length <= MAX_TEXT_CHARS {
        return Ok(Entry {
            role,
            text: canonical,
            truncated: false,
        });
    }
    let remaining = MAX_TEXT_CHARS - 1;
    let head = remaining / 2;
    let tail = remaining - head;
    let characters: Vec<char> = canonical.chars().collect();
    let mut text: String = characters[..head].iter().collect();
    text.push(TRUNCATION_MARKER);
    text.extend(&characters[length - tail..]);
    Ok(Entry {
        role,
        text,
        truncated: true,
    })
}

/// Re-admits a window: at most its entry bound, each entry canonical and bounded, within the total bound.
///
/// # Errors
///
/// Returns [`Invalid`] for a window outside those bounds.
pub fn admit(entries: &[Entry]) -> Result<Vec<Entry>, Invalid> {
    if entries.len() > MAX_ENTRIES {
        return Err(Invalid("conversation window is invalid"));
    }
    let mut admitted = Vec::with_capacity(entries.len());
    for entry in entries {
        let canonical =
            canonical_text(&entry.text).map_err(|_| Invalid("conversation entry is invalid"))?;
        if text::len(&canonical) > MAX_TEXT_CHARS || !matches!(entry.role, "user" | "assistant") {
            return Err(Invalid("conversation entry is invalid"));
        }
        admitted.push(Entry {
            role: entry.role,
            text: canonical,
            truncated: entry.truncated,
        });
    }
    if admitted
        .iter()
        .map(|entry| text::len(&entry.text))
        .sum::<usize>()
        > MAX_TOTAL_CHARS
    {
        return Err(Invalid("conversation window is invalid"));
    }
    Ok(admitted)
}

#[cfg(test)]
mod tests;
