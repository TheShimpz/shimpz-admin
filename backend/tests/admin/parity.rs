//! The browser's copies of the Team protocol's presentation rules and of the session socket protocol stay the Rust
//! authorities' own (ADR-0090, ADR-0114): each browser constant is read from its source and compared with the vendored
//! Team protocol crate or the Admin session protocol, so a drift on either side fails here.

use admin_backend::{json, session::frames};
use team_protocol::{challenge, identifiers, payload, purpose, routine, turn};

const CHAT_PROTOCOL: &str = include_str!("../../../frontend/src/lib/chat/protocol.js");
const IDS: &str = include_str!("../../../frontend/src/lib/ids.js");
const TEAM_CONTEXT: &str = include_str!("../../../frontend/src/lib/teams/context.js");
const ATTACHMENT_FILES: &str = include_str!("../../../frontend/src/lib/chat/attachments/files.js");
const ROUTINE_PROTOCOL: &str = include_str!("../../../frontend/src/lib/routines/protocol.js");
const SESSION_SOCKET: &str = include_str!("../../../frontend/src/lib/session/socket.js");
// Rust authorities whose rule is private to their module: their source text is read instead.
const ROUTINE_RUN_SOURCE: &str = include_str!("../../../protocol/team/http/src/routine_run.rs");
const FRAMES_SOURCE: &str = include_str!("../../src/session/frames.rs");
const RUN_SOURCE: &str = include_str!("../../src/chat/run/mod.rs");

/// Every value of `const name = …;` (exported or not) the source defines.
fn definitions<'a>(source: &'a str, name: &str) -> Vec<&'a str> {
    let declaration = format!("const {name} = ");
    source
        .lines()
        .filter_map(|line| {
            line.strip_prefix("export ")
                .unwrap_or(line)
                .strip_prefix(&declaration)
        })
        .filter_map(|rest| rest.strip_suffix(';'))
        .collect()
}

/// The one value of the module-private `const name = …;`.
fn constant<'a>(source: &'a str, name: &str) -> &'a str {
    let declaration = format!("const {name} = ");
    let found: Vec<&str> = source
        .lines()
        .filter_map(|line| line.strip_prefix(&declaration)?.strip_suffix(';'))
        .collect();
    assert_eq!(found.len(), 1, "{name} is missing from the browser source");
    found[0]
}

/// The one value of `const name = …;`, exported or not.
fn exported<'a>(source: &'a str, name: &str) -> &'a str {
    let found = definitions(source, name);
    assert_eq!(
        found.len(),
        1,
        "{name} is defined once in the browser source"
    );
    found[0]
}

/// A browser constant's integer: a product of integer literals and constants the same file defines that way.
fn integer(source: &str, expression: &str, depth: usize) -> Option<u64> {
    if depth > 4 {
        return None;
    }
    expression.split('*').try_fold(1_u64, |product, factor| {
        let factor = factor.trim();
        let value = if !factor.is_empty()
            && factor
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'_')
        {
            factor.replace('_', "").parse().ok()?
        } else if !factor.is_empty()
            && factor
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            match definitions(source, factor).as_slice() {
                [defined] => integer(source, defined, depth + 1)?,
                _ => return None,
            }
        } else {
            return None;
        };
        product.checked_mul(value)
    })
}

fn bound(source: &str, name: &str) -> u64 {
    integer(source, exported(source, name), 0)
        .unwrap_or_else(|| panic!("{name} is not a literal browser bound"))
}

const fn n(value: usize) -> u64 {
    value as u64
}

/// The code points a browser `/[\uXXXX-\uXXXX…]/` class literal names, as a predicate.
fn class(literal: &str) -> impl Fn(u32) -> bool {
    let body = literal
        .strip_suffix('u')
        .unwrap_or(literal)
        .strip_prefix("/[")
        .and_then(|rest| rest.strip_suffix("]/"))
        .unwrap_or_else(|| panic!("{literal} is not one character class"));
    let points: Vec<&str> = body.split("\\u").skip(1).collect();
    assert!(body.starts_with("\\u"), "{literal} holds only \\u escapes");
    let mut ranges = Vec::new();
    let mut index = 0;
    while index < points.len() {
        let parse = |text: &str| u32::from_str_radix(&text[..4], 16).unwrap();
        let low = parse(points[index]);
        if points[index].len() == 5 && points[index].ends_with('-') {
            ranges.push((low, parse(points[index + 1])));
            assert_eq!(
                points[index + 1].len(),
                4,
                "{literal} has one range per pair"
            );
            index += 2;
        } else {
            assert_eq!(
                points[index].len(),
                4,
                "{literal} has only escapes and ranges"
            );
            ranges.push((low, low));
            index += 1;
        }
    }
    move |point| {
        ranges
            .iter()
            .any(|(low, high)| (*low..=*high).contains(&point))
    }
}

/// The code points a Rust `matches!(point, 0x00..=0x08 | 0xfeff …)` names, read from the source of function `name`.
fn matched(source: &str, name: &str) -> impl Fn(u32) -> bool {
    let start = source.find(&format!("fn {name}(")).unwrap();
    let body = &source[start..];
    let body = &body[body.find("matches!(").unwrap() + "matches!(".len()..];
    let body = &body[body.find(',').unwrap() + 1..body.find(')').unwrap()];
    let parse = |text: &str| {
        let text = text.trim();
        text.strip_prefix("0x").map_or_else(
            || text.parse().unwrap(),
            |hex| u32::from_str_radix(hex, 16).unwrap(),
        )
    };
    let ranges: Vec<(u32, u32)> = body
        .split('|')
        .map(|item| match item.split_once("..=") {
            Some((low, high)) => (parse(low), parse(high)),
            None => (parse(item), parse(item)),
        })
        .collect();
    move |point| {
        ranges
            .iter()
            .any(|(low, high)| (*low..=*high).contains(&point))
    }
}

/// The concatenated raw string literals a Rust `static name` is declared from.
fn declared(source: &str, name: &str) -> String {
    let start = source.find(&format!("static {name}: ")).unwrap();
    let body = &source[start..];
    let end = ["});", "));"]
        .iter()
        .filter_map(|ending| body.find(ending))
        .min()
        .unwrap();
    let body = &body[..end];
    body.split("r\"")
        .skip(1)
        .map(|piece| &piece[..piece.find('"').unwrap()])
        .collect()
}

fn browser_pattern(python: &str) -> String {
    format!("/^{}$/", python.strip_suffix(r"\Z").unwrap())
}

#[test]
fn a_browser_bound_reads_its_own_units_and_refuses_anything_else() {
    let units = "const KIB = 1024;\nconst MIB = 1024 * KIB;\nconst LOOP = 2 * LOOP;\n";
    assert_eq!(integer(units, "512 * KIB", 0), Some(512 * 1024));
    assert_eq!(integer(units, "25 * MIB", 0), Some(25 * 1024 * 1024));
    assert_eq!(integer(units, "60_000", 0), Some(60_000));
    assert_eq!(
        integer("const KIB = 1000;\n", "512 * KIB", 0),
        Some(512_000)
    );
    for expression in ["LIMIT", "1 + 2", "2 * OTHER", "1.5", "2 * LOOP"] {
        assert_eq!(integer(units, expression, 0), None, "{expression}");
    }
}

/// Each browser bound and the Team protocol constant it copies.
const TURN_BOUNDS: [(&str, &str, u64); 17] = [
    (
        CHAT_PROTOCOL,
        "MAX_MESSAGE_CHARS",
        n(turn::MAX_CHAT_MESSAGE_CHARS),
    ),
    (CHAT_PROTOCOL, "MAX_FILES", n(payload::MAX_CHAT_FILES)),
    (CHAT_PROTOCOL, "MAX_REPLY_CHARS", n(turn::MAX_REPLY_CHARS)),
    (
        CHAT_PROTOCOL,
        "MAX_GUIDANCE_REPLY_CHARS",
        n(turn::MAX_INTENT_ROUTE_REPLY_CHARS),
    ),
    (
        CHAT_PROTOCOL,
        "MAX_ASSISTANTS",
        n(payload::MAX_CHAT_ASSISTANTS),
    ),
    (IDS, "MAX_TEAM_NAME_CHARS", n(payload::MAX_TEAM_NAME_CHARS)),
    (
        TEAM_CONTEXT,
        "MAX_TEAM_ASSISTANTS",
        n(payload::MAX_TEAM_ASSISTANTS),
    ),
    (
        ATTACHMENT_FILES,
        "MAX_ATTACHMENTS",
        n(payload::MAX_CHAT_FILES),
    ),
    (
        ATTACHMENT_FILES,
        "MAX_FILENAME_BYTES",
        n(payload::MAX_FILENAME_BYTES),
    ),
    (
        ATTACHMENT_FILES,
        "MAX_MEDIA_TYPE_CHARS",
        n(payload::MAX_MEDIA_TYPE_CHARS),
    ),
    (
        ATTACHMENT_FILES,
        "MAX_MESSAGE_IMAGES",
        n(turn::MAX_ATTACHMENT_IMAGES),
    ),
    (
        ATTACHMENT_FILES,
        "MAX_MESSAGE_TEXT_CHARACTERS",
        n(turn::MAX_ATTACHED_TEXT_CHARS),
    ),
    (
        ATTACHMENT_FILES,
        "MAX_MESSAGE_TEXT_BYTES",
        n(turn::MAX_ATTACHED_TEXT_BYTES),
    ),
    (
        ATTACHMENT_FILES,
        "MAX_TEXT_CHARACTERS",
        n(turn::MAX_ATTACHMENT_TEXT_CHARS),
    ),
    (
        ATTACHMENT_FILES,
        "MAX_TEXT_BYTES",
        n(turn::MAX_ATTACHMENT_TEXT_BYTES),
    ),
    (
        CHAT_PROTOCOL,
        "MAX_HELP_URL_CHARS",
        n(payload::MAX_HELP_URL_CHARS),
    ),
    (
        CHAT_PROTOCOL,
        "MAX_PURPOSE_CHARS",
        n(purpose::MAX_PURPOSE_CHARS),
    ),
];

#[test]
fn each_browser_turn_bound_is_the_team_definition() {
    for (source, name, expected) in TURN_BOUNDS {
        assert_eq!(bound(source, name), expected, "{name}");
    }
    assert_eq!(
        bound(ATTACHMENT_FILES, "MAX_UPLOAD_BYTES"),
        u64::try_from(payload::MAX_FILE_UPLOAD_BYTES).unwrap()
    );
}

#[test]
fn the_browser_help_url_grammar_is_the_team_pattern_byte_for_byte() {
    let start = CHAT_PROTOCOL
        .find("export const HELP_URL_PATTERN = [\n")
        .unwrap();
    let block = &CHAT_PROTOCOL[start..];
    let block = &block[block.find('\n').unwrap() + 1..block.find("\n].join('');").unwrap()];
    let pieces: Vec<&str> = block
        .lines()
        .map(|line| {
            line.strip_prefix("  String.raw`")
                .and_then(|rest| rest.strip_suffix("`,"))
                .unwrap()
        })
        .collect();
    assert_eq!(pieces.len(), 5);
    assert_eq!(pieces.concat(), payload::HELP_URL_PATTERN);
    constant(CHAT_PROTOCOL, "MAX_HELP_URL_CHARS");
}

#[test]
fn the_browser_purpose_rule_mirrors_the_team_rule() {
    constant(CHAT_PROTOCOL, "MAX_PURPOSE_CHARS");
    let forbidden = constant(CHAT_PROTOCOL, "PURPOSE_FORBIDDEN_RE");
    for marker in [
        r"\p{C}",
        r"\p{Zl}",
        r"\p{Zp}",
        r"(?!-)\p{Pd}",
        " -",
        "- ",
        r":\/\/",
    ] {
        assert!(forbidden.contains(marker), "{marker}");
    }
    let rule = &CHAT_PROTOCOL[CHAT_PROTOCOL
        .find("export function canonicalPurpose(")
        .unwrap()..];
    let rule = &rule[..rule.find("\n}\n").unwrap()];
    for check in [
        "value.normalize('NFC') !== value",
        "value.trim() !== value",
        "codePointLength(value) < 1",
        "codePointLength(value) > MAX_PURPOSE_CHARS",
        "PURPOSE_FORBIDDEN_RE.test(value)",
        "value.toLowerCase().includes('www.')",
    ] {
        assert!(rule.contains(check), "{check}");
    }
}

#[test]
fn the_browser_rendered_copy_bounds_are_the_team_bounds() {
    for (name, bounds) in [
        ("RENDERED_FIELD_CHARS", &challenge::RENDERED_FIELD_CHARS[..]),
        (
            "RENDERED_OPTION_CHARS",
            &challenge::RENDERED_OPTION_CHARS[..],
        ),
    ] {
        let literal = constant(CHAT_PROTOCOL, name)
            .strip_prefix("Object.freeze({ ")
            .and_then(|rest| rest.strip_suffix(" })"))
            .unwrap();
        let browser: Vec<(&str, usize)> = literal
            .split(", ")
            .map(|pair| {
                let (field, value) = pair.split_once(": ").unwrap();
                (field, value.parse().unwrap())
            })
            .collect();
        assert_eq!(browser, bounds, "{name}");
    }
}

#[test]
fn the_browser_unsafe_text_sets_are_the_team_sets() {
    let plan = class(exported(ROUTINE_PROTOCOL, "PLAN_UNSAFE_RE"));
    let diagnostic = class(exported(ROUTINE_PROTOCOL, "UNSAFE_DIAGNOSTIC_RE"));
    let unsafe_text = matched(ROUTINE_RUN_SOURCE, "unsafe_text");
    for point in 0..=0x10_ffff {
        assert_eq!(plan(point), routine::plan_unsafe(point), "plan {point:#x}");
        assert_eq!(
            diagnostic(point),
            unsafe_text(point),
            "diagnostic {point:#x}"
        );
    }
}

#[test]
fn the_browser_reply_control_set_refuses_exactly_the_team_characters() {
    let browser = class(exported(CHAT_PROTOCOL, "CHAT_TEXT_CONTROL_RE"));
    for character in (0..=0x10_ffff).filter_map(char::from_u32) {
        assert_eq!(
            browser(u32::from(character)),
            turn::REPLY_CONTROL_RE.is_full(&character.to_string()),
            "{:#x}",
            u32::from(character)
        );
    }
}

#[test]
fn the_browser_identifier_kinds_are_the_team_identifiers() {
    assert_eq!(
        exported(IDS, "ASSISTANT_ID_RE"),
        format!("/{}/", identifiers::ASSISTANT_ID_PATTERN)
    );
    assert_eq!(
        exported(IDS, "ACTION_ID_RE"),
        format!("/{}/", identifiers::ACTION_ID_PATTERN)
    );
    assert_eq!(
        bound(IDS, "MAX_ASSISTANT_ID_CHARS"),
        n(identifiers::MAX_ASSISTANT_ID_CHARS)
    );
    assert_eq!(
        bound(IDS, "MAX_IDENTIFIER_CHARS"),
        n(identifiers::MAX_IDENTIFIER_CHARS)
    );
    assert_eq!(
        bound(IDS, "MAX_ACTION_ID_CHARS"),
        n(identifiers::MAX_ACTION_ID_CHARS)
    );
    assert_eq!(
        identifiers::IDENTIFIER_PATTERN,
        identifiers::ASSISTANT_ID_PATTERN
    );
}

#[test]
fn the_browser_admits_exactly_the_running_event_admin_sends() {
    assert_eq!(
        bound(CHAT_PROTOCOL, "MAX_RUNNING_STEPS"),
        n(admin_backend::chat::run::LIVE_STEPS)
    );
    assert_eq!(
        bound(CHAT_PROTOCOL, "MAX_QUEUE_PLACE"),
        n(admin_backend::chat::gate::MAX_WAITING)
    );
    let snapshot = &RUN_SOURCE[RUN_SOURCE.find("pub fn snapshot(").unwrap()..];
    let snapshot = &snapshot
        [snapshot.find("json::object(vec![").unwrap()..snapshot.find("\n    }\n").unwrap()];
    let keys: Vec<&str> = snapshot
        .lines()
        .filter_map(|line| line.trim().strip_prefix("(\"")?.split('"').next())
        .chain(snapshot.lines().filter_map(|line| {
            let line = line.trim();
            (line.starts_with('"') && line.ends_with("\","))
                .then(|| line.trim_matches(|c| c == '"' || c == ','))
        }))
        .collect();
    let mut sorted = keys.clone();
    sorted.sort_unstable();
    assert_eq!(
        sorted,
        ["cursor", "elapsed_ms", "events", "position", "type"]
    );
    assert!(
        CHAT_PROTOCOL
            .contains("exactKeys(value, ['type', 'elapsed_ms', 'position', 'cursor', 'events'])")
    );
}

#[test]
fn the_browser_session_socket_bounds_and_topics_are_the_protocol_s() {
    assert_eq!(
        exported(SESSION_SOCKET, "ADMIN_SOCKET_PROTOCOL"),
        format!("'{}'", frames::SUBPROTOCOL)
    );
    assert_eq!(
        exported(SESSION_SOCKET, "ADMIN_SOCKET_PATH"),
        format!("'{}'", frames::PATH)
    );
    assert_eq!(exported(SESSION_SOCKET, "MAX_INBOUND_BYTES"), "1024 * 1024");
    assert_eq!(1024 * 1024, frames::MAX_OUTBOUND_BYTES);
    assert_eq!(
        bound(SESSION_SOCKET, "MAX_IN_FLIGHT"),
        n(frames::MAX_IN_FLIGHT)
    );
    assert_eq!(
        bound(SESSION_SOCKET, "MAX_SUBSCRIPTIONS"),
        n(frames::MAX_SUBSCRIPTIONS)
    );
    assert_eq!(
        bound(SESSION_SOCKET, "MAX_ATTACHED_TEAMS"),
        n(frames::MAX_ATTACHED_TEAMS)
    );
}

#[test]
fn the_browser_session_socket_grammars_are_the_protocol_s() {
    assert_eq!(
        exported(SESSION_SOCKET, "CALL_ID_RE"),
        browser_pattern(&declared(FRAMES_SOURCE, "CALL_ID_RE"))
    );
    assert_eq!(
        exported(SESSION_SOCKET, "EPOCH_RE"),
        browser_pattern(&declared(FRAMES_SOURCE, "EPOCH_RE"))
    );
    let topic = declared(FRAMES_SOURCE, "TOPIC_RE").replace('/', r"\/");
    assert_eq!(
        exported(SESSION_SOCKET, "TOPIC_RE"),
        browser_pattern(&topic)
    );
    let types = ["chat", "resume-task", "stop", "sync", "human-response"];
    let listed: Vec<String> = types.iter().map(|kind| format!("'{kind}'")).collect();
    assert_eq!(
        exported(SESSION_SOCKET, "CHAT_CLIENT_TYPES"),
        format!("new Set([{}])", listed.join(", "))
    );
    assert_eq!(frames::CHAT_TYPES, types);
}

/// An integer with `_` between each group of three digits, as the browser writes its large constants.
fn grouped(value: i64) -> String {
    let digits = value.to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push('_');
        }
        grouped.push(digit);
    }
    grouped
}

#[test]
fn the_browser_reports_activity_and_reads_deadlines_in_the_protocol_s_frames() {
    assert!(frames::activity(&json::object(vec![("type", json::text("activity"))])).is_ok());
    assert!(SESSION_SOCKET.contains("connection.send(JSON.stringify({ type: 'activity' }));"));
    let session = frames::session(1, 2, None);
    let mut keys: Vec<&str> = json::members(&session)
        .unwrap()
        .iter()
        .map(|(key, _)| key.as_str())
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "absolute_seconds",
            "idle_seconds",
            "source_revision",
            "source_time",
            "type"
        ]
    );
    assert!(SESSION_SOCKET.contains(
        "exactKeys(frame, ['type', 'idle_seconds', 'absolute_seconds', 'source_revision', 'source_time'])"
    ));
    assert!(SESSION_SOCKET.contains(&format!(
        "const MAX_SOURCE_TIME = {};",
        grouped(frames::MAX_SOURCE_TIME)
    )));
    assert_eq!(
        constant(SESSION_SOCKET, "SOURCE_REVISION_RE"),
        browser_pattern(&declared(FRAMES_SOURCE, "SOURCE_REVISION_RE"))
    );
}
