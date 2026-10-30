//! The process-wide registry of open session sockets (ADR-0114 decision 5).
//!
//! Every open socket is registered under its session's digest. When sessions stop being tracked (logout and every
//! other rotation of the session secret, factor suspension, capacity eviction, idling out), the registry closes their
//! sockets at once with 4401, the close that means signed out. Absolute and idle expiry of a quiet socket are each
//! socket's own timer.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use super::{frames, socket::Socket};
use crate::{signin::tickets::Binding, sync::lock};

/// The close that means signed out.
pub const SIGNED_OUT: u16 = 4401;

/// The open sockets by session digest.
#[derive(Default)]
pub struct Registry {
    sockets: Mutex<HashMap<String, Vec<Arc<Socket>>>>,
}

impl Registry {
    /// Registers one socket, or refuses it when its session already holds as many as it may.
    pub fn add(&self, socket: &Arc<Socket>) -> bool {
        let mut sockets = lock(&self.sockets);
        let held = sockets.entry(socket.session().to_owned()).or_default();
        if held.len() >= frames::MAX_SOCKETS_PER_SESSION {
            return false;
        }
        held.push(Arc::clone(socket));
        true
    }

    /// Forgets one socket.
    pub fn remove(&self, socket: &Socket) {
        let mut sockets = lock(&self.sockets);
        if let Some(held) = sockets.get_mut(socket.session()) {
            held.retain(|known| !std::ptr::eq(Arc::as_ptr(known), socket));
            if held.is_empty() {
                sockets.remove(socket.session());
            }
        }
    }

    /// Whether the socket a step-up ticket is bound to is still open in its session.
    #[must_use]
    pub fn live(&self, binding: &Binding) -> bool {
        lock(&self.sockets)
            .get(&binding.session)
            .is_some_and(|held| {
                held.iter()
                    .any(|socket| socket.binding().socket == binding.socket)
            })
    }

    /// Every open socket.
    #[must_use]
    pub fn sockets(&self) -> Vec<Arc<Socket>> {
        lock(&self.sockets).values().flatten().cloned().collect()
    }

    /// Tells every socket of the session that its idle time restarted.
    pub fn renewed(&self, session: &str) {
        let held = lock(&self.sockets)
            .get(session)
            .cloned()
            .unwrap_or_default();
        for socket in held {
            socket.send_deadlines();
        }
    }

    /// Closes every socket of these sessions, or of every session when `None`, as signed out.
    pub fn end_sessions(&self, sessions: Option<&HashSet<String>>) {
        let ended: Vec<Arc<Socket>> = lock(&self.sockets)
            .iter()
            .filter(|(session, _)| sessions.is_none_or(|ended| ended.contains(*session)))
            .flat_map(|(_, held)| held.iter().cloned())
            .collect();
        for socket in ended {
            socket.end(SIGNED_OUT);
        }
    }
}
