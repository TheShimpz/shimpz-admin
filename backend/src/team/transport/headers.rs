//! What authorizes one Team request: Team's bearer, the Supervisor's or Routine's assertion over the exact request,
//! and the private headers that carry a model credential or the decision key.

use std::{os::unix::fs::MetadataExt, path::Path, path::PathBuf};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use team_protocol::supervisor::{ASSERTION_HEADER, ROUTINE_ASSERTION_HEADER};
use zeroize::Zeroizing;

use super::{Team, TeamClient};
use crate::{
    fault::Fault,
    json::Value,
    keys::models,
    supervisor::{
        assertion::{self, AuthorityKind, RequestBinding},
        identity::LocalIdentity,
    },
    sync::lock,
};

/// The header that names an uploaded file.
pub const FILE_NAME_HEADER: &str = "X-Shimpz-Filename";
const FILENAME_SAFE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'_')
    .remove(b'.')
    .remove(b'-')
    .remove(b'~');

/// One validated Supervisor authority bound to downstream Team calls: a session's cookie value (or the host reset
/// binding) and the current signing identity.
#[derive(Clone)]
pub struct Scope {
    value: Zeroizing<String>,
    identity: LocalIdentity,
    kind: AuthorityKind,
}

impl Scope {
    /// One authority: `value` is 1 to 2,048 printable ASCII characters.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::TeamRequest`] for any other value.
    pub fn new(value: &str, identity: LocalIdentity, kind: AuthorityKind) -> Result<Self, Fault> {
        if !(1..=2048).contains(&value.len())
            || !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        {
            return Err(Fault::team_request("Supervisor session is unavailable"));
        }
        Ok(Self {
            value: Zeroizing::new(value.to_owned()),
            identity,
            kind,
        })
    }

    /// The authority's value (a session cookie or the host reset binding).
    #[must_use]
    pub fn value(&self) -> &str {
        &self.value
    }

    /// The signing identity.
    #[must_use]
    pub const fn identity(&self) -> &LocalIdentity {
        &self.identity
    }
}

/// The private bindings one request carries.
#[derive(Clone, Default)]
pub struct Bindings {
    /// The model provider and its key, sent in private headers and bound by digest.
    pub model: Option<(String, Zeroizing<String>)>,
    /// The human assurance this request carries.
    pub assurance: Option<Value>,
    /// The decision key, sent in a private header and bound by digest.
    pub decision: Option<Zeroizing<String>>,
    /// Admin's Routine identity and the run's lease token: the request is signed by it, never by a session.
    pub routine: Option<(LocalIdentity, Zeroizing<String>)>,
}

impl std::fmt::Debug for Bindings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Bindings")
    }
}

/// A request's body with its media type and, for an uploaded file, its name.
#[derive(Default)]
pub struct Entity<'a> {
    /// The body.
    pub body: Option<&'a [u8]>,
    /// Its media type.
    pub content_type: Option<&'a str>,
    /// An uploaded file's name.
    pub filename: Option<&'a str>,
}

pub(super) struct TokenCache {
    identity: (u64, u64, i64, i64, u64),
    token: Zeroizing<String>,
}

fn identity(path: &Path) -> Option<(u64, u64, i64, i64, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((
        metadata.dev(),
        metadata.ino(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.size(),
    ))
}

impl TeamClient {
    pub(super) fn team_token(&self) -> Option<Zeroizing<String>> {
        let path: PathBuf = self.token_file.clone();
        let current = identity(&path)?;
        let mut cache = lock(&self.token);
        if let Some(cached) = cache.as_ref()
            && cached.identity == current
        {
            return Some(cached.token.clone());
        }
        let raw = Zeroizing::new(std::fs::read(&path).ok()?);
        let text = std::str::from_utf8(&raw).ok()?;
        let token = Zeroizing::new(
            text.trim_matches(|character: char| team_protocol::python::text::isspace(character))
                .to_owned(),
        );
        if token.is_empty() || identity(&path)? != current {
            return None;
        }
        *cache = Some(TokenCache {
            identity: current,
            token: token.clone(),
        });
        Some(token)
    }

    pub(super) fn forget_token(&self) {
        *lock(&self.token) = None;
    }
}

fn private_key(value: &str) -> bool {
    (16..=8 * 1024).contains(&value.len()) && value.bytes().all(|byte| (33..=126).contains(&byte))
}

fn binding(
    method: &str,
    path: &str,
    entity: &Entity<'_>,
    bindings: &Bindings,
) -> Result<RequestBinding, ()> {
    let body = match (entity.filename, entity.body, entity.content_type) {
        (Some(filename), Some(body), Some(media_type)) => {
            assertion::file_body(body, filename, media_type)
        }
        (Some(_), _, _) => return Err(()),
        (None, Some(body), _) => assertion::json_body(body),
        (None, None, _) => assertion::empty_body(),
    };
    Ok(RequestBinding {
        method: method.to_owned(),
        path: path.to_owned(),
        body,
        model: bindings
            .model
            .as_ref()
            .map(|(provider, key)| assertion::model_binding(provider, key)),
        assurance: bindings.assurance.clone(),
        decision: bindings
            .decision
            .as_ref()
            .map(|key| assertion::decision_binding(key)),
    })
}

impl Team {
    /// Every header of one request; `Err` when the request cannot be authorized (no bearer, an invalid private
    /// credential, or a signing failure), which answers as an unavailable Team.
    pub(super) fn request_headers(
        &self,
        method: &str,
        path: &str,
        entity: &Entity<'_>,
        accept: &str,
        bindings: &Bindings,
    ) -> Result<Vec<(String, String)>, ()> {
        let token = self.client.team_token().ok_or(())?;
        let mut headers = vec![
            ("Accept".to_owned(), accept.to_owned()),
            (
                "Authorization".to_owned(),
                format!("Bearer {}", token.as_str()),
            ),
        ];
        if let Some(content_type) = entity.content_type {
            headers.push(("Content-Type".to_owned(), content_type.to_owned()));
        }
        if let Some(filename) = entity.filename {
            headers.push((
                FILE_NAME_HEADER.to_owned(),
                utf8_percent_encode(filename, FILENAME_SAFE).to_string(),
            ));
        }
        if let Some((provider, key)) = &bindings.model {
            if !models::is_provider(provider) || !private_key(key) {
                return Err(());
            }
            headers.push(("X-Shimpz-Model-Provider".to_owned(), provider.clone()));
            headers.push(("X-Shimpz-Model-Api-Key".to_owned(), key.to_string()));
        }
        if let Some(key) = &bindings.decision {
            if !private_key(key) {
                return Err(());
            }
            headers.push(("X-Shimpz-Decision-Api-Key".to_owned(), key.to_string()));
        }
        let now = self.client.clock.now_secs();
        let request = binding(method, path, entity, bindings)?;
        if let Some((identity, lease)) = &bindings.routine {
            let signed =
                assertion::sign_routine_request(identity, lease, &request, now).map_err(|_| ())?;
            headers.push((
                ROUTINE_ASSERTION_HEADER.to_owned(),
                format!("Bearer {signed}"),
            ));
            return Ok(headers);
        }
        if let Some(scope) = &self.scope {
            let signed =
                assertion::sign_request(&scope.identity, &scope.value, scope.kind, &request, now)
                    .map_err(|_| ())?;
            headers.push((ASSERTION_HEADER.to_owned(), format!("Bearer {signed}")));
        }
        Ok(headers)
    }
}
