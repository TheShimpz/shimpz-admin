//! The background tasks one Admin process runs for its life: the Routine scheduler, the Supervisor key rotation's
//! retry, and the sweeps that end work whose authority lapsed.

use std::sync::Arc;

use crate::app::App;

/// Starts every background task of `app`.
pub fn start(app: &Arc<App>) {
    crate::team::sign_ins::listen(app);
    crate::routine::scheduler::start(app);
}
