//! Each Team's chat run on the session socket (ADR-0119).

use std::sync::Arc;

use crate::{
    json::Value,
    session::socket::{Channel, Socket},
};

struct Pending;

impl Channel for Pending {
    fn start(&self) {}

    fn submit(&self, _frame: Value) -> bool {
        true
    }

    fn leave(&self) {}
}

/// A Team's chat channel on `socket`.
#[must_use]
pub fn channel(socket: &Arc<Socket>, team_id: &str, locale: &str) -> Arc<dyn Channel> {
    let _ = (socket, team_id, locale);
    Arc::new(Pending)
}
