//! Where a run's delivery writes: every attached page, and, while one frame dispatches, a refusal to only the page
//! that sent it (ADR-0119).

use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, Ordering},
};

use super::Run;
use crate::{
    json::{self, Value},
    session::socket::Socket,
};

struct ObserverInner {
    socket: Weak<Socket>,
    team_id: String,
}

/// One attached page's view of a Team's chat run: the session socket's frames of that Team.
#[derive(Clone)]
pub struct Observer(Arc<ObserverInner>);

impl PartialEq for Observer {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Observer {
    /// A page on `socket` watching `team_id`.
    #[must_use]
    pub fn new(socket: &Arc<Socket>, team_id: &str) -> Self {
        Self(Arc::new(ObserverInner {
            socket: Arc::downgrade(socket),
            team_id: team_id.to_owned(),
        }))
    }

    /// Queues one event now; whether the page's socket took it.
    #[must_use]
    pub fn push(&self, event: &Value) -> bool {
        self.0
            .socket
            .upgrade()
            .is_some_and(|socket| socket.send_chat(&self.0.team_id, event).is_ok())
    }

    /// Ends the page's whole session socket.
    pub fn close(&self, code: u16) {
        if let Some(socket) = self.0.socket.upgrade() {
            socket.end(code);
        }
    }
}

struct Framed {
    observer: Option<Observer>,
    dispatching: AtomicBool,
}

/// What a run's delivery writes to.
#[derive(Clone)]
pub struct Relay {
    run: Arc<Run>,
    framed: Option<Arc<Framed>>,
}

impl Relay {
    /// Every event to every page attached now.
    #[must_use]
    pub const fn run(run: Arc<Run>) -> Self {
        Self { run, framed: None }
    }

    /// One frame's dispatch: a refusal while it dispatches reaches only the page that sent it.
    #[must_use]
    pub fn framed(run: Arc<Run>, observer: Option<Observer>) -> Self {
        Self {
            run,
            framed: Some(Arc::new(Framed {
                observer,
                dispatching: AtomicBool::new(true),
            })),
        }
    }

    /// The frame's dispatch ended: what its started work sends reaches every page.
    pub fn dispatched(&self) {
        if let Some(framed) = &self.framed {
            framed.dispatching.store(false, Ordering::SeqCst);
        }
    }

    /// Sends one event.
    pub fn send(&self, event: &Value) {
        if let Some(framed) = &self.framed
            && framed.dispatching.load(Ordering::SeqCst)
            && json::get_str(event, "type") == Some("error")
            && let Some(observer) = &framed.observer
        {
            self.run.push_to(observer, event);
            return;
        }
        self.run.publish(event);
    }

    /// Closes every page.
    pub fn close(&self, code: u16) {
        self.run.close_pages(code);
    }
}
