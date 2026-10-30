//! The JSON values Admin reads, builds, and writes: strict JSON values with Python's member order and equality, and the
//! `json.dumps` forms each boundary writes.

use std::fmt::Write as _;

pub use strict_json::{Number, Value};
use team_protocol::python::json::{self as pyjson, Options};

/// Python's `json.dumps(value, ensure_ascii=False, separators=(",", ":"))`: frames, Team request bodies, and sizes.
pub const COMPACT: Options = Options {
    ensure_ascii: false,
    sort_keys: false,
    compact: true,
};

/// `json.dumps(value, separators=(",", ":"), sort_keys=True)`: the audit journal's ASCII lines.
pub const SORTED_ASCII: Options = Options {
    ensure_ascii: true,
    sort_keys: true,
    compact: true,
};

/// `json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)`: chat history rows.
pub const SORTED: Options = Options {
    ensure_ascii: false,
    sort_keys: true,
    compact: true,
};

/// The text of `value` written with `options`.
#[must_use]
pub fn dumps(value: &Value, options: Options) -> String {
    pyjson::dumps(value, options)
}

/// The compact text of `value` in member order, as Admin sends it to a browser or to Team.
#[must_use]
pub fn compact(value: &Value) -> String {
    pyjson::dumps(value, COMPACT)
}

/// `json.dumps(value, indent=2, sort_keys=True)` with Python's ASCII escapes: the Admin store's own layout.
#[must_use]
pub fn indented(value: &Value) -> String {
    let mut out = String::new();
    write_indented(value, 0, &mut out);
    out
}

fn write_indented(value: &Value, depth: usize, out: &mut String) {
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                out.push_str(if index == 0 { "\n" } else { ",\n" });
                indent(depth + 1, out);
                write_indented(item, depth + 1, out);
            }
            out.push('\n');
            indent(depth, out);
            out.push(']');
        }
        Value::Object(members) if !members.is_empty() => {
            let mut sorted: Vec<&(String, Value)> = members.iter().collect();
            sorted.sort_by(|left, right| left.0.cmp(&right.0));
            out.push('{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                out.push_str(if index == 0 { "\n" } else { ",\n" });
                indent(depth + 1, out);
                pyjson::write_string(key, true, out);
                out.push_str(": ");
                write_indented(item, depth + 1, out);
            }
            out.push('\n');
            indent(depth, out);
            out.push('}');
        }
        other => {
            let _ = write!(
                out,
                "{}",
                pyjson::dumps(
                    other,
                    Options {
                        ensure_ascii: true,
                        sort_keys: true,
                        compact: false
                    }
                )
            );
        }
    }
}

fn indent(depth: usize, out: &mut String) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// Parses one strict JSON document (unique keys, UTF-8, bounded depth).
///
/// # Errors
///
/// Returns the reason the document is refused.
pub fn parse(raw: &[u8]) -> Result<Value, strict_json::Error> {
    strict_json::parse(raw)
}

/// A string value.
#[must_use]
pub fn text(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

/// An integer value.
#[must_use]
pub const fn int(value: i64) -> Value {
    Value::Number(Number::Int(value))
}

/// An object of these members, in this order.
#[must_use]
pub fn object(members: Vec<(&str, Value)>) -> Value {
    Value::Object(
        members
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

/// The empty object `{}`.
#[must_use]
pub const fn empty() -> Value {
    Value::Object(Vec::new())
}

/// `{"detail": detail}`, the body `FastAPI` answers an `HTTPException` with.
#[must_use]
pub fn detail(detail: &str) -> Value {
    object(vec![("detail", text(detail))])
}

/// `{"detail": detail, "code": code}`.
#[must_use]
pub fn detail_code(detail: &str, code: &str) -> Value {
    object(vec![("detail", text(detail)), ("code", text(code))])
}

/// `{"code": code}`.
#[must_use]
pub fn code(code: &str) -> Value {
    object(vec![("code", text(code))])
}

/// The members of an object, or `None` for any other value.
#[must_use]
pub fn members(value: &Value) -> Option<&[(String, Value)]> {
    match value {
        Value::Object(members) => Some(members),
        _ => None,
    }
}

/// The text of a string value.
#[must_use]
pub fn as_str(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) => Some(text),
        _ => None,
    }
}

/// The items of an array value.
#[must_use]
pub fn as_array(value: &Value) -> Option<&[Value]> {
    match value {
        Value::Array(items) => Some(items),
        _ => None,
    }
}

/// An exact integer (never a boolean or a float), as Python's `type(x) is int` within `i64`.
#[must_use]
pub const fn as_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(Number::Int(number)) => Some(*number),
        _ => None,
    }
}

/// `value[key]` when `value` is an object holding `key`.
#[must_use]
pub fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

/// `value[key]` as text.
#[must_use]
pub fn get_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(as_str)
}

/// Whether `value` is an object with exactly these member names.
#[must_use]
pub fn has_exactly(value: &Value, fields: &[&str]) -> bool {
    members(value).is_some_and(|members| {
        members.len() == fields.len()
            && members
                .iter()
                .all(|(key, _)| fields.contains(&key.as_str()))
    })
}

/// Whether `value` is an object holding `key`.
#[must_use]
pub fn contains(value: &Value, key: &str) -> bool {
    members(value).is_some_and(|members| members.iter().any(|(name, _)| name == key))
}

/// Sets `value[key]` as a Python `dict` does: in place when present, appended otherwise. A non-object is unchanged.
pub fn set(value: &mut Value, key: &str, item: Value) {
    if let Value::Object(members) = value {
        if let Some(slot) = members.iter_mut().find(|(name, _)| name == key) {
            slot.1 = item;
        } else {
            members.push((key.to_owned(), item));
        }
    }
}

/// Removes and returns `value[key]`.
pub fn remove(value: &mut Value, key: &str) -> Option<Value> {
    if let Value::Object(members) = value {
        let index = members.iter().position(|(name, _)| name == key)?;
        return Some(members.remove(index).1);
    }
    None
}

/// A copy of an object without `key`.
#[must_use]
pub fn without(value: &Value, key: &str) -> Value {
    let mut copy = value.clone();
    remove(&mut copy, key);
    copy
}

/// Python's `==` over JSON values: objects compare as `dict`s whatever their member order, numbers by value.
#[must_use]
pub fn equal(left: &Value, right: &Value) -> bool {
    team_protocol::python::value::py_eq(left, right)
}

/// `{**base, **extra}`: `extra`'s members replace or follow `base`'s.
#[must_use]
pub fn merged(base: &Value, extra: &Value) -> Value {
    let mut out = base.clone();
    if let Some(members) = members(extra) {
        for (key, item) in members {
            set(&mut out, key, item.clone());
        }
    }
    out
}

/// The UTF-8 length of the compact text of `value`.
#[must_use]
pub fn compact_len(value: &Value) -> usize {
    pyjson::encoded_len(value, COMPACT)
}

/// An array of strings.
#[must_use]
pub fn strings<I, S>(items: I) -> Value
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    Value::Array(items.into_iter().map(|item| text(item)).collect())
}

#[cfg(test)]
mod tests;
