//! Invalidation topics of the Admin session socket (ADR-0114).
//!
//! A topic names state a screen shows; a change only says that the state changed, never what it is now. Each topic has
//! a monotonic revision within this process's epoch, so a read can say which revision it reflects and a client
//! recognizes a stale one. Any task may raise a change: listeners schedule their own delivery.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
};

use super::frames;

/// Hears each topic change with the topic's new revision.
pub type Listener = Arc<dyn Fn(&str, u64) + Send + Sync>;

/// The topics of one Admin process.
pub struct Topics {
    /// This process's epoch: a new one invalidates every topic a client holds.
    pub epoch: String,
    revisions: Mutex<HashMap<String, u64>>,
    listeners: Mutex<HashMap<u64, Listener>>,
    next: Mutex<u64>,
}

impl Default for Topics {
    fn default() -> Self {
        Self::new()
    }
}

impl Topics {
    /// A fresh epoch with every topic at revision 0.
    #[must_use]
    pub fn new() -> Self {
        Self {
            epoch: crate::random::hex(16),
            revisions: Mutex::new(HashMap::new()),
            listeners: Mutex::new(HashMap::new()),
            next: Mutex::new(0),
        }
    }

    /// The topic's current revision; a topic that never changed is at revision 0.
    #[must_use]
    pub fn revision(&self, topic: &str) -> u64 {
        self.revisions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(topic)
            .copied()
            .unwrap_or(0)
    }

    /// Advances one topic's revision and tells every listener; a name outside the topic grammar changes nothing.
    pub fn changed(&self, topic: &str) -> u64 {
        if !frames::is_topic(topic) {
            return 0;
        }
        let current = {
            let mut revisions = self
                .revisions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let entry = revisions.entry(topic.to_owned()).or_insert(0);
            *entry += 1;
            *entry
        };
        let listeners: Vec<Listener> = self
            .listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        for listener in listeners {
            listener(topic, current);
        }
        current
    }

    /// Raises each named topic of one Team, such as `history` and `routines`.
    pub fn team_changed(&self, team_id: &str, names: &[&str]) {
        for name in names {
            self.changed(&format!("team/{team_id}/{name}"));
        }
    }

    /// Adds a listener; the returned id forgets it.
    pub fn listen(&self, listener: Listener) -> u64 {
        let id = {
            let mut next = self.next.lock().unwrap_or_else(PoisonError::into_inner);
            *next += 1;
            *next
        };
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, listener);
        id
    }

    /// Forgets one listener.
    pub fn forget(&self, id: u64) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    }
}
