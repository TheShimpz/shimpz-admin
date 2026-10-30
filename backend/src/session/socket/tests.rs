use axum::http::{HeaderName, HeaderValue};

use super::*;

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    map
}

#[test]
fn only_the_exact_subprotocol_offered_alone_is_this_protocol() {
    assert_eq!(
        offered_protocols(&headers(&[("sec-websocket-protocol", "shimpz.admin.v1")])),
        ["shimpz.admin.v1"]
    );
    assert_eq!(
        offered_protocols(&headers(&[(
            "sec-websocket-protocol",
            "shimpz.admin.v1, other"
        )])),
        ["shimpz.admin.v1", "other"]
    );
    assert_eq!(offered_protocols(&headers(&[])), Vec::<String>::new());
}

#[test]
fn the_socket_is_bound_to_one_admitted_origin_of_admin_s_own_page() {
    let admitted = vec!["http://127.0.0.1:7777".to_owned()];
    let page = [
        ("origin", "http://127.0.0.1:7777"),
        ("sec-fetch-site", "same-origin"),
    ];
    assert_eq!(
        admitted_origin(&headers(&page), &admitted).as_deref(),
        Some("http://127.0.0.1:7777")
    );
    assert_eq!(
        admitted_origin(&headers(&[("origin", "http://localhost:7777")]), &admitted),
        None
    );
    assert_eq!(
        admitted_origin(&headers(&[("sec-fetch-site", "same-origin")]), &admitted),
        None
    );
    let twice = [
        ("origin", "http://127.0.0.1:7777"),
        ("origin", "http://127.0.0.1:7777"),
    ];
    assert_eq!(admitted_origin(&headers(&twice), &admitted), None);
}

#[test]
fn a_frame_outside_the_bounded_json_contract_names_its_close_code() {
    assert_eq!(decode(Message::Binary(vec![1].into())), Err(1003));
    assert_eq!(decode(Message::Text("{\"a\":1,\"a\":2}".into())), Err(1007));
    assert_eq!(decode(Message::Text("[]".into())), Err(1007));
    assert_eq!(
        decode(Message::Text(
            "x".repeat(frames::MAX_INBOUND_BYTES + 1).into()
        )),
        Err(1009)
    );
    assert!(
        decode(Message::Text("{\"type\":\"activity\"}".into()))
            .unwrap()
            .is_some()
    );
    assert_eq!(decode(Message::Ping(Vec::new().into())), Ok(None));
}

fn test_socket() -> (tempfile::TempDir, Arc<Socket>) {
    let root = tempfile::tempdir().unwrap();
    let app = App::new(crate::process::config::Config::under(root.path()));
    let socket = Arc::new(Socket::new(
        app,
        "http://127.0.0.1:7777".to_owned(),
        String::new(),
    ));
    (root, socket)
}

#[tokio::test(start_paused = true)]
async fn a_write_the_client_never_takes_closes_the_socket_at_its_deadline() {
    let (_root, socket) = test_socket();
    socket.send(&crate::json::empty(), None).unwrap();
    let never = futures_util::sink::unfold((), |(), _: Message| {
        std::future::pending::<Result<(), ()>>()
    });
    let writer = tokio::spawn(write(Arc::clone(&socket), Box::pin(never)));
    tokio::time::sleep(WRITE_DEADLINE + CLOSE_DEADLINE + Duration::from_secs(1)).await;
    assert!(writer.is_finished());
    assert_eq!(socket.close_code(), UNAVAILABLE);
}

#[tokio::test(start_paused = true)]
async fn a_close_overtakes_a_blocked_write() {
    let (_root, socket) = test_socket();
    socket.send(&crate::json::empty(), None).unwrap();
    let never = futures_util::sink::unfold((), |(), _: Message| {
        std::future::pending::<Result<(), ()>>()
    });
    let writer = tokio::spawn(write(Arc::clone(&socket), Box::pin(never)));
    tokio::time::sleep(Duration::from_millis(10)).await;
    socket.end(ORIGIN_REFUSED);
    tokio::time::sleep(CLOSE_DEADLINE + Duration::from_secs(1)).await;
    assert!(writer.is_finished());
    assert_eq!(socket.close_code(), ORIGIN_REFUSED);
}
