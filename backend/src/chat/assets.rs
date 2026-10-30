//! The public Store catalog in bounded pages for the session socket, and the same-origin public Assistant icons.

use std::sync::{Arc, LazyLock};

use axum::{
    extract::{Path, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use data_encoding::HEXLOWER;
use sha2::{Digest, Sha256};
use team_protocol::{
    payload::canonical_locale,
    python::regex::{Pattern, declared},
};

use super::catalog::store::{CatalogAssistant, CatalogPage, IconError};
use crate::{
    fault::{Fault, Outcome, Reply},
    http::respond,
    json::{self, Value},
    lanes::Ended,
    process::app::App,
    session::frames::MAX_OUTBOUND_BYTES,
};

/// One page's Assistants take at most this many bytes, so the whole result frame fits the socket's outbound bound.
pub const PAGE_BYTES: usize = MAX_OUTBOUND_BYTES - 4 * 1024;
static CURSOR_RE: LazyLock<Pattern> =
    LazyLock::new(|| declared(r"([1-9][0-9]{0,3})\.([0-9a-f]{32})\Z"));

/// The answer a full catalog lane gives.
#[must_use]
pub fn catalog_full() -> Reply {
    Reply::detail(503, "Assistant catalog is unavailable")
}

fn actions(page: &CatalogPage) -> Value {
    Value::Array(
        page.actions
            .iter()
            .map(|action| {
                json::object(vec![
                    ("id", json::text(&action.id)),
                    ("effect", json::text(&action.effect)),
                    ("description", json::text(&action.description)),
                ])
            })
            .collect(),
    )
}

fn stored_inputs(page: &CatalogPage) -> Value {
    Value::Array(
        page.stored_inputs
            .iter()
            .map(|item| {
                json::object(vec![
                    ("id", json::text(&item.id)),
                    ("label", json::text(&item.label)),
                    ("description", json::text(&item.description)),
                    ("help_url", json::text(&item.help_url)),
                ])
            })
            .collect(),
    )
}

/// One publication as the Assistants page lists it and shows it on its own page.
fn entry(assistant: &CatalogAssistant) -> Value {
    let page = &assistant.page;
    let integrations = assistant
        .integrations
        .iter()
        .map(|provider| {
            json::object(vec![
                ("id", json::text(provider)),
                ("provider", json::text(provider)),
            ])
        })
        .collect();
    json::object(vec![
        ("assistant_id", json::text(&assistant.assistant_id)),
        ("name", json::text(&assistant.name)),
        ("summary", json::text(&assistant.summary)),
        ("description", json::text(&page.description)),
        (
            "assistant_version",
            json::text(&assistant.assistant_version),
        ),
        (
            "creators",
            json::strings(assistant.creators.iter().map(String::as_str)),
        ),
        ("links", Value::Object(page.links.clone())),
        ("source_digest", json::text(&assistant.source_digest)),
        ("icon_digest", json::text(&assistant.icon_digest)),
        ("actions", actions(page)),
        ("integrations", Value::Array(integrations)),
        ("stored_inputs", stored_inputs(page)),
    ])
}

/// Where the next page starts in a catalog of `count` entries whose digest is `digest`.
fn start(cursor: Option<&str>, digest: &str, count: usize) -> Result<usize, Fault> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let invalid = || Fault::detail(400, "Assistant catalog cursor is invalid");
    let found = CURSOR_RE
        .search(cursor)
        .ok()
        .flatten()
        .filter(|_| CURSOR_RE.is_full(cursor))
        .ok_or_else(invalid)?;
    if found.group(cursor, 2) != Some(digest) {
        return Err(Fault::body(
            409,
            json::object(vec![
                ("code", json::text("catalog-changed")),
                (
                    "detail",
                    json::text("The Assistant catalog changed; read it again"),
                ),
            ]),
        ));
    }
    let offset: usize = found
        .group(cursor, 1)
        .and_then(|offset| offset.parse().ok())
        .ok_or_else(invalid)?;
    if offset >= count {
        return Err(invalid());
    }
    Ok(offset)
}

/// One bounded page of the Store projection the Assistants pages show, in one interface language; each page names the
/// next until the last, and a catalog that changed between pages is refused (409).
///
/// # Errors
///
/// Returns 422 for an invalid locale, 400 for an invalid cursor, 409 for a changed catalog, or 502 when the catalog is
/// unavailable.
pub async fn catalog_page(app: &App, locale: &str, cursor: Option<&str>) -> Outcome {
    let locale = canonical_locale(&json::text(locale))
        .ok_or_else(|| Fault::detail(422, "Assistant catalog locale is invalid"))?
        .to_owned();
    let assistants = app
        .domains
        .chat
        .catalog
        .get(&app.outbound, &locale)
        .await
        .map_err(|_| Fault::detail(502, "Assistant catalog is unavailable"))?;
    let entries: Vec<Value> = assistants.iter().map(entry).collect();
    let encoded: Vec<String> = entries.iter().map(json::compact).collect();
    let digest = HEXLOWER.encode(&Sha256::digest(encoded.join("\n").as_bytes()))[..32].to_owned();
    let first = start(cursor, &digest, entries.len())?;
    let (mut end, mut used) = (first, 0);
    while end < entries.len() && used + encoded[end].len() < PAGE_BYTES {
        used += encoded[end].len() + 1;
        end += 1;
    }
    if end == first && first < entries.len() {
        return Err(Fault::detail(502, "Assistant catalog is unavailable"));
    }
    let next = if end < entries.len() {
        json::text(format!("{end}.{digest}"))
    } else {
        Value::Null
    };
    Ok(Reply::ok(json::object(vec![
        ("version", json::int(1)),
        ("locale", json::text(locale)),
        ("assistants", Value::Array(entries[first..end].to_vec())),
        ("next", next),
    ])))
}

/// `GET /api/assistants/{assistant_id}/catalog-icon`: one catalog-resolved PNG; the browser is never an asset
/// authority.
pub async fn catalog_icon(
    State(app): State<Arc<App>>,
    Path(assistant_id): Path<String>,
) -> Response {
    let unavailable =
        |status| respond::json_response(status, &json::detail("Assistant icon is unavailable"));
    let fetching = Arc::clone(&app);
    let Ok(job) = app.domains.chat.lanes.icon.submit(async move {
        fetching
            .domains
            .chat
            .catalog
            .icon(&fetching.outbound, &assistant_id)
            .await
    }) else {
        return unavailable(503);
    };
    let contents = match job.wait().await {
        Ended::Done(Ok(contents)) => contents,
        Ended::Done(Err(IconError::NotFound)) => return unavailable(404),
        _ => return unavailable(502),
    };
    let mut response = (*contents).clone().into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}
