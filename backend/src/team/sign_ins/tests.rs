use super::*;

fn traced(body: &Value) -> Value {
    json::merged(
        body,
        &json::object(vec![("trace_id", json::text("b".repeat(32)))]),
    )
}

#[test]
fn team_s_traced_answer_reaches_the_page_untraced_and_any_other_is_closed() {
    let cancelled = json::object(vec![("cancelled", Value::Bool(true))]);
    let answered = answer(
        &Reply::ok(traced(&cancelled)),
        contract::canonical_cancelled,
    );
    assert_eq!(answered, Reply::ok(cancelled.clone()));
    assert_eq!(
        answer(&Reply::ok(cancelled), contract::canonical_cancelled),
        Reply::detail(502, "team unavailable")
    );
    let busy = Reply::new(
        409,
        json::object(vec![
            ("code", json::text("browser-busy")),
            ("detail", json::text("x")),
        ]),
    );
    assert_eq!(
        answer(&busy, contract::canonical_cancelled),
        Reply::new(
            409,
            json::detail_code("sign-in unavailable", "browser-busy")
        )
    );
    let foreign = Reply::new(409, json::code("sign-in-absent"));
    assert_eq!(
        answer(&foreign, contract::canonical_cancelled),
        Reply::detail(502, "team unavailable")
    );
}

#[test]
fn a_deletion_is_bound_to_the_digest_of_the_exact_sign_in() {
    let sign_in = json::object(vec![
        ("sign_in_id", json::text("c".repeat(32))),
        ("generation", json::int(3)),
        ("team_incarnation", json::text("d".repeat(64))),
    ]);
    // sha256 of json.dumps(["sales", "d"*64, "c"*32, 3], separators=(",", ":")).
    let expected = data_encoding::HEXLOWER.encode(&Sha256::digest(
        format!(
            "[\"sales\",\"{}\",\"{}\",3]",
            "d".repeat(64),
            "c".repeat(32)
        )
        .as_bytes(),
    ));
    assert_eq!(
        deletion_subject("sales", &sign_in).unwrap(),
        format!("sign-in-delete:{expected}")
    );
}

#[test]
fn a_named_sign_in_reads_its_generation_as_python_reads_a_decimal() {
    let named = |generation: &str| {
        confirmed(
            &json::text("c".repeat(32)),
            &json::text(generation),
            &json::text("d".repeat(64)),
        )
    };
    assert_eq!(named("7").unwrap().get("generation"), Some(&json::int(7)));
    assert_eq!(
        named("\u{663}").unwrap().get("generation"),
        Some(&json::int(3))
    );
    assert!(named("0x7").is_err());
    assert!(named("").is_err());
    assert!(named("99999999999999999999999").is_err());
}

#[test]
fn a_request_names_the_page_s_verified_origin_never_its_own() {
    let body = json::object(vec![
        ("url", json::text("https://a.example")),
        ("origin", json::text("https://evil.example")),
    ]);
    let named = with_origin(&body, "http://127.0.0.1:7777");
    assert_eq!(
        json::get_str(&named, "origin"),
        Some("http://127.0.0.1:7777")
    );
    assert_eq!(with_origin(&json::text("x"), "o"), json::text("x"));
}
