use super::*;

const STATE: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

fn url(rest: &str) -> String {
    format!("https://shimpz.com/api/oauth/cloudflare/start?{rest}")
}

#[test]
fn only_the_exact_start_url_for_the_callback_mode_is_admitted() {
    let query =
        format!("state={STATE}&code_challenge={STATE}&scope=dns.read+zone.read&callback=loopback");
    assert_eq!(
        authorization_state(&url(&query), "loopback").unwrap(),
        STATE
    );
    assert!(authorization_state(&url(&query), "local-domain").is_err());
    for refused in [
        format!("http://shimpz.com/api/oauth/cloudflare/start?{query}"),
        format!("https://evil.example/api/oauth/cloudflare/start?{query}"),
        format!("https://user@shimpz.com/api/oauth/cloudflare/start?{query}"),
        format!("https://shimpz.com:443/api/oauth/cloudflare/start?{query}"),
        format!("{}#x", url(&query)),
        url(&format!("{query}&extra=1")),
        url(&query.replace("dns.read+zone.read", "zone.read+dns.read")),
        url(&query.replace("dns.read+zone.read", "dns.read+admin")),
    ] {
        assert!(
            authorization_state(&refused, "loopback").is_err(),
            "{refused}"
        );
    }
}
