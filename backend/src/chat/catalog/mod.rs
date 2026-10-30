//! What an Assistant plan may offer and the Assistants pages show: the public Store catalog, fetched and cached per
//! interface language, and the Space's staged Local snapshots.

pub mod local;
pub mod store;

use local::LocalAssistant;
use store::CatalogAssistant;

/// One Assistant a plan may offer: a public Store publication, or a staged Local snapshot.
#[derive(Clone, Debug, PartialEq)]
pub enum Offer {
    /// A publication.
    Published(CatalogAssistant),
    /// A staged snapshot.
    Local(LocalAssistant),
}

impl Offer {
    /// Its id.
    #[must_use]
    pub fn assistant_id(&self) -> &str {
        match self {
            Self::Published(assistant) => &assistant.assistant_id,
            Self::Local(assistant) => &assistant.assistant_id,
        }
    }

    /// Its name.
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::Published(assistant) => &assistant.name,
            Self::Local(assistant) => &assistant.name,
        }
    }

    /// Its summary.
    #[must_use]
    pub fn summary(&self) -> &str {
        match self {
            Self::Published(assistant) => &assistant.summary,
            Self::Local(assistant) => &assistant.summary,
        }
    }

    /// The providers of its Integrations.
    #[must_use]
    pub fn integrations(&self) -> &[String] {
        match self {
            Self::Published(assistant) => &assistant.integrations,
            Self::Local(assistant) => &assistant.integrations,
        }
    }

    /// Its Action ids.
    #[must_use]
    pub fn actions(&self) -> &[String] {
        match self {
            Self::Published(assistant) => &assistant.actions,
            Self::Local(assistant) => &assistant.actions,
        }
    }

    /// Its version.
    #[must_use]
    pub fn version(&self) -> &str {
        match self {
            Self::Published(assistant) => &assistant.assistant_version,
            Self::Local(assistant) => &assistant.assistant_version,
        }
    }

    /// The Creator a card shows: a staged snapshot's first declared one, or a publication's first catalog Creator.
    #[must_use]
    pub fn creator(&self) -> &str {
        match self {
            Self::Published(assistant) => assistant.creators.first().map_or("", String::as_str),
            Self::Local(assistant) => &assistant.creator,
        }
    }

    /// `local` or `published`.
    #[must_use]
    pub const fn provenance(&self) -> &'static str {
        match self {
            Self::Published(_) => "published",
            Self::Local(_) => "local",
        }
    }

    /// The same Assistant shown with another summary.
    #[must_use]
    pub fn with_summary(&self, summary: String) -> Self {
        match self {
            Self::Published(assistant) => Self::Published(CatalogAssistant {
                summary,
                ..assistant.clone()
            }),
            Self::Local(assistant) => Self::Local(LocalAssistant {
                summary,
                ..assistant.clone()
            }),
        }
    }
}
