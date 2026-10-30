//! The closed Cloudflare OAuth scope and start-URL projection Admin's boundaries share.

use std::sync::LazyLock;

use team_protocol::python::regex::{Pattern, declared};

/// The scopes a Cloudflare authorization may ask for.
pub const ALLOWED_SCOPES: [&str; 4] = ["dns.read", "dns.write", "offline_access", "zone.read"];
/// One OAuth scope.
pub static SCOPE_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"[A-Za-z0-9._:-]{1,128}\Z"));
static PKCE_VALUE_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"[A-Za-z0-9_-]{43}\Z"));

/// The URL or its scopes are outside the closed projection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidAuthorization;

/// The requested scopes: space-separated, unique, sorted, and allowed.
///
/// # Errors
///
/// Returns [`InvalidAuthorization`] for anything else.
pub fn canonical_authorization_scopes(value: &str) -> Result<Vec<&str>, InvalidAuthorization> {
    let scopes: Vec<&str> = value.split(' ').collect();
    let valid = scopes.len() <= ALLOWED_SCOPES.len()
        && scopes.iter().all(|scope| SCOPE_RE.is_full(scope))
        && scopes.windows(2).all(|pair| pair[0] < pair[1])
        && scopes.iter().all(|scope| ALLOWED_SCOPES.contains(scope));
    if valid {
        Ok(scopes)
    } else {
        Err(InvalidAuthorization)
    }
}

/// `urllib.parse.unquote_plus`, failing on any escape that is not a UTF-8 byte sequence.
fn unquote_plus(value: &str) -> Option<String> {
    let spaced = value.replace('+', " ");
    percent_encoding::percent_decode_str(&spaced)
        .decode_utf8()
        .ok()
        .map(std::borrow::Cow::into_owned)
}

/// `parse_qsl(query, keep_blank_values=True, strict_parsing=True, max_num_fields=4)`.
fn query_pairs(query: &str) -> Option<Vec<(String, String)>> {
    if query.matches('&').count() + 1 > 4 {
        return None;
    }
    query
        .split('&')
        .map(|field| {
            let (name, value) = field.split_once('=')?;
            Some((unquote_plus(name)?, unquote_plus(value)?))
        })
        .collect()
}

/// The host and port text of an `https` URL's authority, refusing userinfo and any port.
fn host_admitted(authority: &str) -> bool {
    if authority.contains('@') {
        return false;
    }
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    port.is_empty() && host.eq_ignore_ascii_case("shimpz.com")
}

/// The state of one exact, unnormalized Shimpz Cloudflare start URL for `callback_mode`.
///
/// # Errors
///
/// Returns [`InvalidAuthorization`] for any other URL.
pub fn authorization_state(
    value: &str,
    callback_mode: &str,
) -> Result<String, InvalidAuthorization> {
    if value.is_empty()
        || value.len() > 4096
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(InvalidAuthorization);
    }
    let (url, fragment) = value.split_once('#').unwrap_or((value, ""));
    let (scheme, rest) = url.split_once("://").ok_or(InvalidAuthorization)?;
    if !scheme.eq_ignore_ascii_case("https") || !fragment.is_empty() {
        return Err(InvalidAuthorization);
    }
    let (location, query) = rest.split_once('?').ok_or(InvalidAuthorization)?;
    let (authority, path) = location
        .find('/')
        .map_or((location, ""), |slash| location.split_at(slash));
    if !host_admitted(authority) || path != "/api/oauth/cloudflare/start" {
        return Err(InvalidAuthorization);
    }
    let pairs = query_pairs(query).ok_or(InvalidAuthorization)?;
    let field = |key: &str| {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    let mut names: Vec<&str> = pairs.iter().map(|(name, _)| name.as_str()).collect();
    names.sort_unstable();
    if names != ["callback", "code_challenge", "scope", "state"]
        || !field("state").is_some_and(|state| PKCE_VALUE_RE.is_full(state))
        || !field("code_challenge").is_some_and(|challenge| PKCE_VALUE_RE.is_full(challenge))
        || field("callback") != Some(callback_mode)
    {
        return Err(InvalidAuthorization);
    }
    canonical_authorization_scopes(field("scope").unwrap_or_default())?;
    Ok(field("state").unwrap_or_default().to_owned())
}

#[cfg(test)]
mod tests;
