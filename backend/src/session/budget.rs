//! Session-scoped admission budgets of the session socket (ADR-0114 decision 8).
//!
//! Budgets belong to the session, never to one socket, so reconnecting never replenishes them. Each counts admitted
//! events in a sliding minute.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use crate::{sync::lock, time::clock::Clock};

/// The sliding window.
pub const WINDOW_MS: i64 = 60_000;
/// Socket opens per session per minute.
pub const SOCKET_OPENS: usize = 30;
/// Calls per session per minute.
pub const CALLS: usize = 600;
/// Subscribe, unsubscribe, attach, and detach changes per session per minute.
pub const SOCKET_CHANGES: usize = 120;
/// The shortest time between two restarts of one session's idle time.
pub const RENEWAL_MS: i64 = 30_000;

/// One sliding-window budget per session digest.
pub struct Budget {
    limit: usize,
    clock: Arc<Clock>,
    events: Mutex<HashMap<String, VecDeque<i64>>>,
}

impl Budget {
    /// A budget of `limit` events per session per minute.
    #[must_use]
    pub fn new(limit: usize, clock: Arc<Clock>) -> Self {
        Self {
            limit,
            clock,
            events: Mutex::new(HashMap::new()),
        }
    }

    /// Counts one event for the session, or refuses it once its minute is spent.
    pub fn admit(&self, session: &str) -> bool {
        let now = self.clock.monotonic_ms();
        let mut events = lock(&self.events);
        events.retain(|_, seen| seen.back().is_some_and(|last| now - last < WINDOW_MS));
        let seen = events.entry(session.to_owned()).or_default();
        while seen.front().is_some_and(|first| now - first >= WINDOW_MS) {
            seen.pop_front();
        }
        if seen.len() >= self.limit {
            return false;
        }
        seen.push_back(now);
        true
    }
}

/// When each session's idle time last restarted, so activity from its other tabs meanwhile changes nothing.
pub struct Renewals {
    clock: Arc<Clock>,
    renewed: Mutex<HashMap<String, i64>>,
}

impl Renewals {
    /// No renewal yet.
    #[must_use]
    pub fn new(clock: Arc<Clock>) -> Self {
        Self {
            clock,
            renewed: Mutex::new(HashMap::new()),
        }
    }

    /// Whether the session's idle time may restart now; a restart that is due is counted at once.
    pub fn due(&self, session: &str) -> bool {
        let now = self.clock.monotonic_ms();
        let mut renewed = lock(&self.renewed);
        renewed.retain(|_, at| now - *at < RENEWAL_MS);
        if renewed.contains_key(session) {
            return false;
        }
        renewed.insert(session.to_owned(), now);
        true
    }
}

/// Every budget of the session socket.
pub struct Budgets {
    /// Socket opens.
    pub opens: Budget,
    /// Calls, chat frames, and activity.
    pub calls: Budget,
    /// Changes to what a socket holds.
    pub changes: Budget,
    /// Idle-time restarts.
    pub renewals: Renewals,
}

impl Budgets {
    /// Fresh budgets on `clock`.
    #[must_use]
    pub fn new(clock: &Arc<Clock>) -> Self {
        Self {
            opens: Budget::new(SOCKET_OPENS, Arc::clone(clock)),
            calls: Budget::new(CALLS, Arc::clone(clock)),
            changes: Budget::new(SOCKET_CHANGES, Arc::clone(clock)),
            renewals: Renewals::new(Arc::clone(clock)),
        }
    }
}

#[cfg(test)]
mod tests;
