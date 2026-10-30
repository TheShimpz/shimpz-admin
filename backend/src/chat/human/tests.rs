//! The Developers human-request vectors through Admin's browser challenge projection (ADR-0091).
//!
//! Admin never holds the reviewed message catalog, so a request whose only fault is relative to that catalog is
//! Team's to refuse; every other published refusal is Admin's too.

use super::*;

const VECTORS: &[u8] = include_bytes!("../../../protocol/assistant/human-request-vectors.json");
const COPY_FIELDS: [&str; 4] = ["title", "description", "label", "placeholder"];
/// The published refusals that only the reviewed catalog can decide; each keeps a reference shape Admin admits.
const CATALOG_BOUND_REFUSALS: [&str; 14] = [
    "reject_undeclared_message",
    "reject_description_bound_in_title",
    "reject_missing_param",
    "reject_extra_param",
    "reject_param_on_static_message",
    "reject_uppercase_domain",
    "reject_single_label_domain",
    "reject_overlong_domain",
    "reject_dns_name_long_label",
    "reject_trailing_hyphen_dns_name",
    "reject_integer_dns_name",
    "reject_integer_over_length",
    "reject_string_integer",
    "reject_option_label_bound",
];
/// Local Team stops an Action asking for these before any challenge reaches Admin.
const TEAM_REFUSED_AUTH_KINDS: [&str; 2] = ["auth:totp", "auth:passkey"];

fn vectors() -> Value {
    json::parse(VECTORS).unwrap()
}

fn cases<'a>(vectors: &'a Value, group: &str) -> &'a [Value] {
    let holder = if group == "fingerprint" {
        vectors
            .get("fingerprint")
            .and_then(|value| value.get("cases"))
    } else {
        vectors.get(group)
    };
    holder.and_then(json::as_array).unwrap()
}

fn fingerprint(request: &Value) -> String {
    HEXLOWER.encode(&Sha256::digest(
        json::dumps(request, json::SORTED).as_bytes(),
    ))
}

/// Bounded display copy for exactly the copy fields of any request shape, null where it is null.
fn rendered_for(request: &Value) -> Value {
    if json::members(request).is_none() {
        return json::empty();
    }
    let mut rendered: Vec<(String, Value)> = COPY_FIELDS
        .iter()
        .filter_map(|field| {
            let value = request.get(field)?;
            let copy = if matches!(value, Value::Null) {
                Value::Null
            } else {
                json::text(format!("Rendered {field}"))
            };
            Some(((*field).to_owned(), copy))
        })
        .collect();
    if let Some(options) = request.get("options").and_then(json::as_array) {
        let projected = options
            .iter()
            .enumerate()
            .map(|(index, option)| {
                let description = if json::members(option).is_some()
                    && option
                        .get("description")
                        .is_none_or(|value| matches!(value, Value::Null))
                {
                    Value::Null
                } else {
                    json::text(format!("Rendered description {index}"))
                };
                json::object(vec![
                    ("label", json::text(format!("Rendered option {index}"))),
                    ("description", description),
                ])
            })
            .collect();
        rendered.push(("options".to_owned(), Value::Array(projected)));
    }
    Value::Object(rendered)
}

/// Team's challenge for one request; a Stored Input request carries the help Team always adds to it.
fn challenge(request: &Value) -> Value {
    let stored = json::get_str(request, "kind") == Some("input:password")
        && request.get("stored_input").is_some();
    let mut members = Vec::new();
    if stored {
        members.push(("help", json::text("Create a key and copy it.")));
        members.push(("help_url", json::text("https://dashboard.exa.ai/api-keys")));
    }
    let mut fingerprinted = request.clone();
    json::set(
        &mut fingerprinted,
        "fingerprint",
        json::text(fingerprint(request)),
    );
    members.extend([
        ("team_id", json::text("team_1")),
        ("status", json::text("human-required")),
        ("turn_id", json::text("b".repeat(32))),
        ("challenge_id", json::text("b".repeat(32))),
        ("expires_in", json::int(300)),
        (
            "assistant",
            json::object(vec![
                ("id", json::text("shimpz-cloudflare")),
                ("name", json::text("Shimpz Cloudflare")),
                ("version", json::text("0.4.1")),
            ]),
        ),
        (
            "action",
            json::object(vec![
                ("id", json::text("list-zones")),
                ("summary", json::text("List reviewed Cloudflare zones.")),
            ]),
        ),
        ("request", fingerprinted),
        ("rendered", rendered_for(request)),
        ("locale", json::text("en")),
        (
            "pack_digest",
            json::text(format!("sha256:{}", "5".repeat(64))),
        ),
        ("trace_id", json::text("a".repeat(32))),
    ]);
    json::object(members)
}

#[test]
fn the_projection_admits_exactly_the_published_request_cases() {
    let vectors = vectors();
    for case in cases(&vectors, "request_cases") {
        let name = json::get_str(case, "name").unwrap();
        let request = case.get("request").unwrap();
        let admitted =
            case.get("valid") == Some(&Value::Bool(true)) || CATALOG_BOUND_REFUSALS.contains(&name);
        let projected = project(&challenge(request), "team_1");
        if admitted {
            let projected = projected.unwrap_or_else(|_| panic!("{name} is admitted"));
            let shown = projected.get("request").unwrap();
            assert_eq!(shown.get("kind"), request.get("kind"), "{name}");
            assert_eq!(
                shown.get("stored_input"),
                request.get("stored_input"),
                "{name}"
            );
        } else {
            assert_eq!(projected, Err(HumanChallengeError), "{name} is refused");
        }
    }
}

#[test]
fn only_catalog_relative_refusals_are_left_to_team() {
    let vectors = vectors();
    let all = cases(&vectors, "request_cases");
    for name in CATALOG_BOUND_REFUSALS {
        let case = all
            .iter()
            .find(|case| json::get_str(case, "name") == Some(name))
            .unwrap_or_else(|| panic!("{name} is a published case"));
        assert_eq!(case.get("valid"), Some(&Value::Bool(false)), "{name}");
        let error = json::get_str(case, "error").unwrap();
        assert!(
            ["copy_reference", "copy_bound", "copy_params"].contains(&error),
            "{name}"
        );
    }
}

#[test]
fn the_fingerprint_matches_the_published_serialization() {
    let vectors = vectors();
    for case in cases(&vectors, "fingerprint") {
        let name = json::get_str(case, "name").unwrap();
        let request = case.get("request").unwrap();
        let digest = json::get_str(case, "sha256").unwrap();
        assert_eq!(fingerprint(request), digest, "{name}");
        assert!(fingerprinted(request, digest), "{name}");
    }
}

#[test]
fn the_projection_knows_every_published_capability() {
    let vectors = vectors();
    let mut known: Vec<&str> = vec!["approval", "input:choices"];
    known.extend(LENGTH_KINDS.iter().map(|(kind, _)| *kind));
    known.extend(CHOICE_KINDS);
    known.extend(AUTH_KINDS);
    assert!(
        known
            .iter()
            .all(|kind| !TEAM_REFUSED_AUTH_KINDS.contains(kind))
    );
    known.extend(TEAM_REFUSED_AUTH_KINDS);
    known.sort_unstable();
    let mut published: Vec<&str> = vectors
        .get("capabilities")
        .and_then(json::as_array)
        .unwrap()
        .iter()
        .filter_map(json::as_str)
        .collect();
    published.sort_unstable();
    assert_eq!(published, known);
}
