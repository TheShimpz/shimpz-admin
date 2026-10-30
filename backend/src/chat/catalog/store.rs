//! Bounded Local discovery from the fixed public Store catalog, fetched and cached per interface language.
//!
//! Only the display copy (summary, description, Action descriptions, and Stored Input labels) is localized, from the
//! publication's own pack (ADR-0091); everything else is canonical, so chat planning reads the canonical English
//! catalog while the Assistants page reads the Supervisor's interface language.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use data_encoding::HEXLOWER;
use sha2::{Digest, Sha256};
use team_protocol::{
    identifiers::{canonical_assistant_id, canonical_identifier},
    payload::{
        ASSISTANT_VERSION_RE, DETAILS_CREATOR_RE, GITHUB_REPOSITORY_RE, MAX_DETAILS_ACTIONS,
        MAX_DETAILS_CREATORS, MAX_DETAILS_DESCRIPTION_CHARS, MAX_DETAILS_INTEGRATIONS,
        MAX_DETAILS_LINE_CHARS, MAX_DETAILS_NAME_CHARS, MAX_DETAILS_STORED_INPUTS,
        MAX_SNAPSHOT_SUMMARY_CHARS, MAX_STORED_INPUT_HELP_CHARS, SOURCE_DIGEST_RE,
        canonical_creator_links, canonical_help_url, canonical_locale,
    },
    python::{
        regex::{Pattern, declared},
        text,
    },
};

use crate::{
    clock::Clock,
    json::{self, Value},
    outbound,
    sync::lock,
};

/// The Store's host.
pub const CATALOG_HOST: &str = "shimpz.com";
/// The catalog path.
pub const CATALOG_PATH: &str = "/api/assistants";
/// Chat planning and icon resolution read the canonical English catalog.
pub const PLANNING_LOCALE: &str = "en";
const CATALOG_TIMEOUT: Duration = Duration::from_secs(5);
const CATALOG_TTL_MS: i64 = 60_000;
/// The largest catalog.
pub const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
/// The largest icon.
pub const MAX_ICON_BYTES: usize = 1024 * 1024;
/// The most Assistants a catalog lists.
pub const MAX_ASSISTANTS: usize = 1000;
const MAX_CACHED_ICONS: usize = 256;
const MAX_CACHED_ICON_BYTES: usize = 8 * 1024 * 1024;
const HUMAN_REQUEST_KINDS: [&str; 11] = [
    "approval",
    "input:text",
    "input:textarea",
    "input:password",
    "input:phone",
    "input:select",
    "input:choice",
    "input:choices",
    "auth:password",
    "auth:totp",
    "auth:passkey",
];
const GATE_KINDS: [&str; 4] = ["approval", "auth:password", "auth:totp", "auth:passkey"];
static INTEGRATION_SCOPE_RE: LazyLock<Pattern> =
    LazyLock::new(|| declared(r"[a-z0-9][a-z0-9.:/_-]*\Z"));
static ALLOWED_HOST_RE: LazyLock<Pattern> = LazyLock::new(|| {
    declared(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
});
const ASSISTANT_FIELDS: [&str; 15] = [
    "assistant_id",
    "name",
    "summary",
    "description",
    "links",
    "assistant_version",
    "creators",
    "github",
    "icon_digest",
    "source_digest",
    "platforms",
    "allowed_hosts",
    "integrations",
    "stored_inputs",
    "actions",
];

/// The catalog could not be admitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unavailable;

/// Why an icon is not served.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconError {
    /// The Assistant is not in the current catalog.
    NotFound,
    /// The catalog or the icon could not be admitted.
    Unavailable,
}

/// One Action as the Assistant page shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogAction {
    /// Its id.
    pub id: String,
    /// `read_only` or `mutating`.
    pub effect: String,
    /// Its localized description.
    pub description: String,
}

/// One declared Stored Input as a page shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogStoredInput {
    /// Its id.
    pub id: String,
    /// Its localized label.
    pub label: String,
    /// Its localized help text.
    pub description: String,
    /// Its help link.
    pub help_url: String,
}

/// The localized page copy and declarations of one publication; planning never reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogPage {
    /// The localized description.
    pub description: String,
    /// The Creator's links in display order.
    pub links: Vec<(String, Value)>,
    /// The Actions.
    pub actions: Vec<CatalogAction>,
    /// The Stored Inputs.
    pub stored_inputs: Vec<CatalogStoredInput>,
}

/// One publication.
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogAssistant {
    /// Its id.
    pub assistant_id: String,
    /// Its name.
    pub name: String,
    /// Its summary, localized.
    pub summary: String,
    /// Its source digest.
    pub source_digest: String,
    /// Its icon digest.
    pub icon_digest: String,
    /// The providers of the Integrations it declares.
    pub integrations: Vec<String>,
    /// Its Action ids.
    pub actions: Vec<String>,
    /// Its version.
    pub assistant_version: String,
    /// Its Creators.
    pub creators: Vec<String>,
    /// Its page.
    pub page: CatalogPage,
}

/// One bounded, trimmed, control-free line of Assistant display text from a catalog.
#[must_use]
pub fn catalog_text(value: &Value, maximum: usize) -> Option<String> {
    let text = json::as_str(value)?;
    let valid = (1..=maximum).contains(&text::len(text))
        && text::strip(text) == text
        && !text
            .chars()
            .any(|character| (character as u32) < 32 || character as u32 == 127);
    valid.then(|| text.to_owned())
}

/// One localized display text as Team admits it: bounded, trimmed, printable, and NFC.
#[must_use]
pub fn display_text(value: &Value, maximum: usize) -> Option<String> {
    catalog_text(value, maximum).filter(|text| text::isprintable(text) && text::is_nfc(text))
}

fn strings(value: &Value, maximum: usize, item_maximum: usize) -> Option<Vec<String>> {
    let items = json::as_array(value).filter(|items| items.len() <= maximum)?;
    let output: Vec<String> = items
        .iter()
        .map(|item| catalog_text(item, item_maximum))
        .collect::<Option<_>>()?;
    let mut unique = output.clone();
    unique.sort_unstable();
    unique.dedup();
    (unique.len() == output.len()).then_some(output)
}

fn stored_inputs(value: &Value) -> Option<Vec<CatalogStoredInput>> {
    let items = json::as_array(value).filter(|items| items.len() <= MAX_DETAILS_STORED_INPUTS)?;
    let mut output: Vec<CatalogStoredInput> = Vec::with_capacity(items.len());
    for item in items {
        if !json::has_exactly(item, &["id", "label", "description", "help_url"]) {
            return None;
        }
        let id = canonical_identifier(item.get("id")?)?.to_owned();
        let help_url = canonical_help_url(item.get("help_url")?)?.to_owned();
        if output.iter().any(|known| known.id == id) {
            return None;
        }
        output.push(CatalogStoredInput {
            id,
            label: display_text(item.get("label")?, MAX_DETAILS_LINE_CHARS)?,
            description: display_text(item.get("description")?, MAX_STORED_INPUT_HELP_CHARS)?,
            help_url,
        });
    }
    Some(output)
}

/// The declared Integrations' providers: unique, in ascending order, each named by its provider.
fn integrations(value: &Value) -> Option<Vec<String>> {
    let items = json::as_array(value).filter(|items| items.len() <= MAX_DETAILS_INTEGRATIONS)?;
    let mut output = Vec::with_capacity(items.len());
    for item in items {
        if !json::has_exactly(item, &["id", "provider", "scopes"]) {
            return None;
        }
        let id = canonical_identifier(item.get("id")?)?;
        if item.get("provider") != item.get("id") {
            return None;
        }
        let scopes = strings(item.get("scopes")?, 32, 128)?;
        if scopes.is_empty()
            || !scopes
                .iter()
                .all(|scope| INTEGRATION_SCOPE_RE.is_full(scope))
        {
            return None;
        }
        output.push(id.to_owned());
    }
    output
        .windows(2)
        .all(|pair| pair[0] < pair[1])
        .then_some(output)
}

fn action(item: &Value) -> Option<CatalogAction> {
    let fields = [
        "id",
        "integrations",
        "human_requests",
        "effect",
        "description",
    ];
    let effect = json::get_str(item, "effect")
        .filter(|effect| matches!(*effect, "read_only" | "mutating"))?;
    if !json::has_exactly(item, &fields) {
        return None;
    }
    let id = canonical_identifier(item.get("id")?)?.to_owned();
    let integrations = strings(item.get("integrations")?, 4, 64)?;
    let requests = strings(item.get("human_requests")?, 8, 25)?;
    let valid = integrations
        .iter()
        .all(|integration| canonical_identifier(&json::text(integration)).is_some())
        && requests
            .iter()
            .all(|kind| HUMAN_REQUEST_KINDS.contains(&kind.as_str()))
        && requests
            .iter()
            .filter(|kind| GATE_KINDS.contains(&kind.as_str()))
            .count()
            <= 1;
    valid.then_some(())?;
    Some(CatalogAction {
        id,
        effect: effect.to_owned(),
        description: display_text(item.get("description")?, MAX_DETAILS_LINE_CHARS)?,
    })
}

fn actions(value: &Value) -> Option<Vec<CatalogAction>> {
    let items =
        json::as_array(value).filter(|items| (1..=MAX_DETAILS_ACTIONS).contains(&items.len()))?;
    let output: Vec<CatalogAction> = items.iter().map(action).collect::<Option<_>>()?;
    let mut ids: Vec<&str> = output.iter().map(|action| action.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    (ids.len() == output.len()).then_some(output)
}

fn identity_valid(value: &Value) -> bool {
    let get = |key| value.get(key).unwrap_or(&Value::Null);
    let platforms = json::strings(["linux/amd64", "linux/arm64"]);
    canonical_assistant_id(get("assistant_id")).is_some()
        && ASSISTANT_VERSION_RE.is_full_value(get("assistant_version"))
        && SOURCE_DIGEST_RE.is_full_value(get("source_digest"))
        && SOURCE_DIGEST_RE.is_full_value(get("icon_digest"))
        && json::equal(get("platforms"), &platforms)
        && GITHUB_REPOSITORY_RE.is_full_value(get("github"))
}

fn assistant(value: &Value) -> Option<CatalogAssistant> {
    if !json::has_exactly(value, &ASSISTANT_FIELDS) || !identity_valid(value) {
        return None;
    }
    let get = |key| value.get(key).unwrap_or(&Value::Null);
    let creators = strings(get("creators"), MAX_DETAILS_CREATORS, 39)?;
    if creators.is_empty()
        || !creators
            .iter()
            .all(|creator| DETAILS_CREATOR_RE.is_full(creator))
    {
        return None;
    }
    let hosts = strings(get("allowed_hosts"), 32, 253)?;
    if !hosts.iter().all(|host| ALLOWED_HOST_RE.is_full(host)) {
        return None;
    }
    let actions = actions(get("actions"))?;
    let text_of = |key| json::get_str(value, key).unwrap_or_default().to_owned();
    Some(CatalogAssistant {
        assistant_id: text_of("assistant_id"),
        name: catalog_text(get("name"), MAX_DETAILS_NAME_CHARS)?,
        summary: catalog_text(get("summary"), MAX_SNAPSHOT_SUMMARY_CHARS)?,
        source_digest: text_of("source_digest"),
        icon_digest: text_of("icon_digest"),
        integrations: integrations(get("integrations"))?,
        actions: actions.iter().map(|action| action.id.clone()).collect(),
        assistant_version: text_of("assistant_version"),
        creators,
        page: CatalogPage {
            description: display_text(get("description"), MAX_DETAILS_DESCRIPTION_CHARS)?,
            links: json::members(&canonical_creator_links(get("links"))?)?.to_vec(),
            actions,
            stored_inputs: stored_inputs(get("stored_inputs"))?,
        },
    })
}

/// The exact bounded Store projection in exactly `locale`, or nothing of it.
///
/// # Errors
///
/// Returns [`Unavailable`] for any other snapshot.
pub fn validate_catalog(value: &Value, locale: &str) -> Result<Vec<CatalogAssistant>, Unavailable> {
    let valid = json::has_exactly(value, &["version", "locale", "assistants"])
        && value.get("version").and_then(json::as_int) == Some(1)
        && canonical_locale(&json::text(locale)).is_some()
        && json::get_str(value, "locale") == Some(locale);
    let raw = value
        .get("assistants")
        .and_then(json::as_array)
        .filter(|raw| valid && raw.len() <= MAX_ASSISTANTS)
        .ok_or(Unavailable)?;
    let assistants: Vec<CatalogAssistant> = raw
        .iter()
        .map(assistant)
        .collect::<Option<_>>()
        .ok_or(Unavailable)?;
    if !assistants
        .windows(2)
        .all(|pair| pair[0].assistant_id < pair[1].assistant_id)
    {
        return Err(Unavailable);
    }
    Ok(assistants)
}

fn media_type(fetched: &outbound::Fetched) -> String {
    fetched
        .header("content-type")
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// Fetches one host-pinned Store snapshot in one interface language without redirects or stale fallback.
///
/// # Errors
///
/// Returns [`Unavailable`] for any failure.
pub async fn fetch_catalog(
    client: &outbound::Client,
    locale: &str,
) -> Result<Vec<CatalogAssistant>, Unavailable> {
    if canonical_locale(&json::text(locale)).is_none() {
        return Err(Unavailable);
    }
    let path = format!("{CATALOG_PATH}?locale={locale}");
    let fetched = client
        .get(
            CATALOG_HOST,
            &path,
            &[("Accept", "application/json")],
            CATALOG_TIMEOUT,
        )
        .await
        .map_err(|_| Unavailable)?;
    if fetched.status != 200 || media_type(&fetched) != "application/json" {
        return Err(Unavailable);
    }
    if let Some(length) = fetched.header("content-length") {
        let length: usize = length.parse().map_err(|_| Unavailable)?;
        if !(1..=MAX_CATALOG_BYTES).contains(&length) {
            return Err(Unavailable);
        }
    }
    let raw = fetched
        .read(MAX_CATALOG_BYTES)
        .await
        .map_err(|_| Unavailable)?;
    if raw.is_empty() {
        return Err(Unavailable);
    }
    validate_catalog(&json::parse(&raw).map_err(|_| Unavailable)?, locale)
}

struct Entry {
    expires_at_ms: i64,
    assistants: Result<Arc<Vec<CatalogAssistant>>, Unavailable>,
}

/// One short valid snapshot per interface language, refreshed one at a time.
pub struct StoreCatalog {
    clock: Arc<Clock>,
    entries: Mutex<HashMap<String, Entry>>,
    refresh: tokio::sync::Mutex<()>,
    icons: Mutex<IconCache>,
}

#[derive(Default)]
struct IconCache {
    order: VecDeque<(String, String)>,
    icons: HashMap<(String, String), Arc<Vec<u8>>>,
    bytes: usize,
}

impl IconCache {
    fn get(&mut self, key: &(String, String)) -> Option<Arc<Vec<u8>>> {
        let icon = self.icons.get(key).cloned()?;
        self.order.retain(|known| known != key);
        self.order.push_back(key.clone());
        Some(icon)
    }

    fn remember(&mut self, key: (String, String), contents: Arc<Vec<u8>>) {
        if let Some(previous) = self.icons.remove(&key) {
            self.bytes -= previous.len();
            self.order.retain(|known| *known != key);
        }
        self.bytes += contents.len();
        self.order.push_back(key.clone());
        self.icons.insert(key, contents);
        while self.icons.len() > MAX_CACHED_ICONS || self.bytes > MAX_CACHED_ICON_BYTES {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            if let Some(contents) = self.icons.remove(&evicted) {
                self.bytes -= contents.len();
            }
        }
    }
}

impl StoreCatalog {
    /// No snapshot yet.
    #[must_use]
    pub fn new(clock: Arc<Clock>) -> Self {
        Self {
            clock,
            entries: Mutex::new(HashMap::new()),
            refresh: tokio::sync::Mutex::new(()),
            icons: Mutex::new(IconCache::default()),
        }
    }

    fn cached(&self, locale: &str) -> Option<Result<Arc<Vec<CatalogAssistant>>, Unavailable>> {
        let entries = lock(&self.entries);
        let entry = entries.get(locale)?;
        (entry.expires_at_ms > self.clock.monotonic_ms()).then(|| entry.assistants.clone())
    }

    /// The catalog in `locale`: a fresh snapshot, or one loaded now; a failed load is remembered as briefly.
    ///
    /// # Errors
    ///
    /// Returns [`Unavailable`] when no valid snapshot can be had.
    pub async fn get(
        &self,
        client: &outbound::Client,
        locale: &str,
    ) -> Result<Arc<Vec<CatalogAssistant>>, Unavailable> {
        if canonical_locale(&json::text(locale)).is_none() {
            return Err(Unavailable);
        }
        if let Some(cached) = self.cached(locale) {
            return cached;
        }
        let _refresh = self.refresh.lock().await;
        if let Some(cached) = self.cached(locale) {
            return cached;
        }
        let loaded = fetch_catalog(client, locale).await.map(Arc::new);
        lock(&self.entries).insert(
            locale.to_owned(),
            Entry {
                expires_at_ms: self.clock.monotonic_ms() + CATALOG_TTL_MS,
                assistants: loaded.clone(),
            },
        );
        loaded
    }

    /// One current public Assistant icon, resolved from the catalog, never from a browser-supplied digest.
    ///
    /// # Errors
    ///
    /// Returns [`IconError`].
    pub async fn icon(
        &self,
        client: &outbound::Client,
        assistant_id: &str,
    ) -> Result<Arc<Vec<u8>>, IconError> {
        if canonical_assistant_id(&json::text(assistant_id)).is_none() {
            return Err(IconError::NotFound);
        }
        let assistants = self
            .get(client, PLANNING_LOCALE)
            .await
            .map_err(|_| IconError::Unavailable)?;
        let assistant = assistants
            .iter()
            .find(|item| item.assistant_id == assistant_id)
            .ok_or(IconError::NotFound)?;
        let key = (
            assistant.source_digest.clone(),
            assistant.icon_digest.clone(),
        );
        if let Some(cached) = lock(&self.icons).get(&key) {
            return Ok(cached);
        }
        let contents = Arc::new(
            fetch_icon(client, assistant)
                .await
                .map_err(|_| IconError::Unavailable)?,
        );
        lock(&self.icons).remember(key, Arc::clone(&contents));
        Ok(contents)
    }
}

async fn fetch_icon(
    client: &outbound::Client,
    assistant: &CatalogAssistant,
) -> Result<Vec<u8>, Unavailable> {
    let source = assistant.source_digest.trim_start_matches("sha256:");
    let icon = assistant.icon_digest.trim_start_matches("sha256:");
    let path = format!("/api/assistant-icons/{source}/{icon}.png");
    let fetched = client
        .get(
            CATALOG_HOST,
            &path,
            &[("Accept", "image/png")],
            CATALOG_TIMEOUT,
        )
        .await
        .map_err(|_| Unavailable)?;
    if fetched.status != 200 || media_type(&fetched) != "image/png" {
        return Err(Unavailable);
    }
    let length = fetched
        .header("content-length")
        .filter(|length| !length.is_empty() && length.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|length| length.parse::<usize>().ok())
        .filter(|length| (1..=MAX_ICON_BYTES).contains(length))
        .ok_or(Unavailable)?;
    let contents = fetched
        .read(MAX_ICON_BYTES)
        .await
        .map_err(|_| Unavailable)?;
    if contents.len() != length || HEXLOWER.encode(&Sha256::digest(&contents)) != icon {
        return Err(Unavailable);
    }
    Ok(contents)
}

#[cfg(test)]
mod tests;
