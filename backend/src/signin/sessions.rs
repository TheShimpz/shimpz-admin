//! The last Supervisor activity of each session this process issued, keyed by its token's digest.
//!
//! A session it never issued or no longer tracks is unknown and refused. Only the Supervisor's own input moves
//! `last_seen` (the session socket's activity frame), so nothing a page does on its own keeps a session alive. Each
//! listener hears which sessions stopped being tracked (`None` for every session), whether they idled out, were evicted
//! for capacity, or all ended at once. A restart forgets them all, so everyone signs in again.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use sha2::{Digest, Sha256};

use crate::{sync::lock, time::clock::Clock};

/// A session ends after this long without Supervisor activity.
pub const IDLE_MS: i64 = 3600 * 1000;
/// At most this many sessions are tracked; the least recently active one is evicted for a new one.
pub const MAX_TRACKED: usize = 64;

/// Hears the sessions that stopped being tracked, or `None` for every session.
pub type Listener = Arc<dyn Fn(Option<&HashSet<String>>) + Send + Sync>;

#[derive(Default)]
struct Tracked {
    last_seen: HashMap<String, (i64, u64)>,
    order: u64,
}

/// The tracked sessions.
pub struct Sessions {
    clock: Arc<Clock>,
    idle_ms: i64,
    capacity: usize,
    tracked: Mutex<Tracked>,
    listeners: Mutex<Vec<Listener>>,
}

/// The digest a session is tracked by; its token is never kept.
#[must_use]
pub fn session_key(token: &str) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(token.as_bytes()))
}

impl Sessions {
    /// No session tracked yet.
    #[must_use]
    pub fn new(clock: Arc<Clock>) -> Self {
        Self {
            clock,
            idle_ms: IDLE_MS,
            capacity: MAX_TRACKED,
            tracked: Mutex::new(Tracked::default()),
            listeners: Mutex::new(Vec::new()),
        }
    }

    /// Hears every session that stops being tracked, so what it holds open can end at once.
    pub fn listen(&self, listener: Listener) {
        lock(&self.listeners).push(listener);
    }

    fn ended(&self, keys: Option<&HashSet<String>>) {
        if keys.is_some_and(HashSet::is_empty) {
            return;
        }
        let listeners: Vec<Listener> = lock(&self.listeners).clone();
        for listener in listeners {
            listener(keys);
        }
    }

    /// Tracks a session just issued, ending idle ones and evicting the least recently active beyond capacity.
    pub fn register(&self, token: &str) {
        let ended = {
            let mut tracked = lock(&self.tracked);
            let now = self.clock.monotonic_ms();
            let mut ended: HashSet<String> = tracked
                .last_seen
                .iter()
                .filter(|(_, (seen, _))| now - seen >= self.idle_ms)
                .map(|(key, _)| key.clone())
                .collect();
            for key in &ended {
                tracked.last_seen.remove(key);
            }
            while tracked.last_seen.len() >= self.capacity {
                let Some(evicted) = tracked
                    .last_seen
                    .iter()
                    .min_by_key(|(_, (seen, order))| (*seen, *order))
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                tracked.last_seen.remove(&evicted);
                ended.insert(evicted);
            }
            tracked.order += 1;
            let order = tracked.order;
            tracked.last_seen.insert(session_key(token), (now, order));
            ended
        };
        self.ended(Some(&ended));
    }

    /// Whether the session is tracked and not idle; Supervisor `activity` also restarts its idle time.
    pub fn current(&self, token: &str, activity: bool) -> bool {
        let key = session_key(token);
        let idle = {
            let mut tracked = lock(&self.tracked);
            let now = self.clock.monotonic_ms();
            let Some((seen, order)) = tracked.last_seen.get(&key).copied() else {
                return false;
            };
            let idle = now - seen >= self.idle_ms;
            if idle {
                tracked.last_seen.remove(&key);
            } else if activity {
                tracked.last_seen.insert(key.clone(), (now, order));
            }
            idle
        };
        if idle {
            self.ended(Some(&HashSet::from([key])));
            return false;
        }
        true
    }

    /// Milliseconds until the session idles out unless it is active meanwhile, or `None` when it is not tracked.
    #[must_use]
    pub fn idle_remaining_ms(&self, token: &str) -> Option<i64> {
        let tracked = lock(&self.tracked);
        tracked
            .last_seen
            .get(&session_key(token))
            .map(|(seen, _)| (seen + self.idle_ms - self.clock.monotonic_ms()).max(0))
    }

    /// Every session ended, such as when the session secret rotated: none is tracked any more.
    pub fn end_all(&self) {
        lock(&self.tracked).last_seen.clear();
        self.ended(None);
    }
}
