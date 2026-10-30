//! Local chat over the session socket (`shimpz.chat.v7`): each Team's run, the Space's chat gate, delivery, and the
//! Assistant lifecycle a message can ask for.

pub mod assets;
pub mod assistants;
pub mod catalog;
pub mod connection;
pub mod delivery;
pub mod gate;
pub mod human;
pub mod lifecycle;
pub mod local;
pub mod methods;
pub mod payloads;
pub mod projection;
pub mod run;
pub mod socket;
pub mod task_resume;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

use crate::{clock::Clock, config::Config, lanes::Lane};

/// Chat's bounded worker lanes: a slow provider never consumes the worker needed to stop its turn.
pub struct Lanes {
    /// Team turns.
    pub turn: Lane,
    /// Stops.
    pub stop: Lane,
    /// Syncs and continuations.
    pub sync: Lane,
    /// Structured route preparations.
    pub plan: Lane,
    /// Install plans and approved uninstalls.
    pub lifecycle: Lane,
    /// Speculative capability plans beside classification.
    pub capability: Lane,
    /// Store icons.
    pub icon: Lane,
    /// Store catalog pages.
    pub catalog: Lane,
}

impl Default for Lanes {
    fn default() -> Self {
        Self {
            turn: Lane::new(2, 2),
            stop: Lane::new(2, 4),
            sync: Lane::new(2, 4),
            plan: Lane::new(2, 2),
            lifecycle: Lane::new(2, 2),
            capability: Lane::new(4, 8),
            icon: Lane::new(2, 2),
            catalog: Lane::new(1, 1),
        }
    }
}

/// Chat's process state: each Team's run, the Space's gate, the catalogs, and the lanes.
pub struct State {
    /// Each Team's chat run in this process.
    pub runs: Mutex<HashMap<String, Arc<run::Run>>>,
    /// The Space's chat gate.
    pub gate: Arc<gate::Gate>,
    /// The public Store catalog.
    pub catalog: catalog::store::StoreCatalog,
    /// The lanes.
    pub lanes: Lanes,
    /// Whether runs follow session ends.
    pub listening: AtomicBool,
    /// The sweep of ended and idle runs.
    pub sweep: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl State {
    /// The domain's state at start.
    #[must_use]
    pub fn new(_config: &Config, clock: &Arc<Clock>) -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
            gate: Arc::new(gate::Gate::default()),
            catalog: catalog::store::StoreCatalog::new(Arc::clone(clock)),
            lanes: Lanes::default(),
            listening: AtomicBool::new(false),
            sweep: Mutex::new(None),
        }
    }
}
