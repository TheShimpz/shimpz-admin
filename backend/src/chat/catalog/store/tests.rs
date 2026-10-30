use super::*;

/// One valid publication as the Store serves it.
pub fn publication(id: &str) -> Value {
    let digest = format!("sha256:{}", "a".repeat(64));
    json::parse(
        format!(
            r#"{{"assistant_id":"{id}","name":"Cloudflare","summary":"Manage DNS records.",
            "description":"Manage DNS records in Cloudflare.","links":{{}},"assistant_version":"1.2.3",
            "creators":["@shimpz"],"github":"https://github.com/theshimpz/cloudflare","icon_digest":"{digest}","source_digest":"{digest}",
            "platforms":["linux/amd64","linux/arm64"],"allowed_hosts":["api.cloudflare.com"],
            "integrations":[{{"id":"cloudflare","provider":"cloudflare","scopes":["zone.read"]}}],"stored_inputs":[],
            "actions":[{{"id":"list-zones","integrations":["cloudflare"],"human_requests":[],"effect":"read_only",
            "description":"List zones."}}]}}"#
        )
        .as_bytes(),
    )
    .unwrap()
}

fn catalog(assistants: Vec<Value>) -> Value {
    json::object(vec![
        ("version", json::int(1)),
        ("locale", json::text("en")),
        ("assistants", Value::Array(assistants)),
    ])
}

#[test]
fn a_catalog_is_admitted_whole_in_exactly_its_locale_and_order() {
    let admitted = validate_catalog(
        &catalog(vec![publication("alpha"), publication("beta")]),
        "en",
    )
    .unwrap();
    assert_eq!(admitted[1].assistant_id, "beta");
    assert_eq!(admitted[0].integrations, ["cloudflare"]);
    assert_eq!(admitted[0].actions, ["list-zones"]);
    assert!(validate_catalog(&catalog(vec![publication("alpha")]), "pt").is_err());
    assert!(
        validate_catalog(
            &catalog(vec![publication("beta"), publication("alpha")]),
            "en"
        )
        .is_err()
    );
    assert!(
        validate_catalog(
            &catalog(vec![publication("alpha"), publication("alpha")]),
            "en"
        )
        .is_err()
    );
}

#[test]
fn one_invalid_publication_refuses_the_whole_snapshot() {
    let mut extra = publication("alpha");
    json::set(&mut extra, "secret", json::text("x"));
    let mut gated = publication("alpha");
    let action = json::parse(
        br#"[{"id":"x","integrations":[],"human_requests":["approval","auth:totp"],"effect":"mutating","description":"X."}]"#,
    )
    .unwrap();
    json::set(&mut gated, "actions", action);
    let mut platforms = publication("alpha");
    json::set(&mut platforms, "platforms", json::strings(["linux/amd64"]));
    for refused in [extra, gated, platforms] {
        assert!(validate_catalog(&catalog(vec![refused]), "en").is_err());
    }
}

#[test]
fn display_text_is_printable_nfc_and_trimmed() {
    assert_eq!(display_text(&json::text("Olá"), 10).as_deref(), Some("Olá"));
    assert!(display_text(&json::text("e\u{301}"), 10).is_none());
    assert!(catalog_text(&json::text(" x"), 10).is_none());
    assert!(catalog_text(&json::text("a\u{7f}"), 10).is_none());
}
