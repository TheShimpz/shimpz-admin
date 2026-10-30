//! Settling the durable turns no run of this process owns (ADR-0125): every turn an earlier Admin process left at its
//! start, and every turn whose run could not reach Team or settle it, every [`SWEEP`].
//!
//! A turn whose grant still holds is sent again exactly as it was, under its original session, with the provider key
//! Admin holds now: Team answers with its kept terminal, attaches to it, or resumes it. Its ending is committed to the
//! Team's history (idempotently: a commit repeated after a crash is the same row), then Team is told it was delivered
//! and the record goes. A turn whose grant ended is revoked at Team, so nothing of it runs again, and kept in the
//! history as failed. Team that cannot be reached leaves the turn for the next sweep.

use std::{sync::Arc, time::Duration};

use super::{Pending, grant_current};
use crate::{
    chat::{
        delivery::history_terminal,
        local::{Answer, model_credential, turn::projected},
        projection::{error_terminal, first_challenge, turn_terminal},
    },
    fault::Reply,
    history::delivery as history,
    json::{self, Value},
    process::app::App,
    team::{bridge, transport::Team},
};

/// How often the turns no run owns are settled.
pub const SWEEP: Duration = Duration::from_secs(30);

/// Whether Team was not reached, or lost the turn's run without its terminal: the turn is sent again later.
#[must_use]
pub fn unreached(response: &Reply) -> bool {
    (response.status == 502 && response.get_str("detail") == Some("team unavailable"))
        || (response.status == 503 && response.get_str("code") == Some("turn-interrupted"))
}

/// Starts the sweep, which also settles at once what an earlier Admin process left.
pub fn start(app: &Arc<App>) {
    super::listen(app);
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let weak = Arc::downgrade(app);
    runtime.spawn(async move {
        loop {
            let Some(app) = weak.upgrade() else {
                return;
            };
            sweep(&app).await;
            drop(app);
            tokio::time::sleep(SWEEP).await;
        }
    });
}

/// Settles every turn no run of this process owns, one at a time.
pub async fn sweep(app: &Arc<App>) {
    let Ok(turns) = app.domains.chat.turns.unowned() else {
        return;
    };
    for pending in turns {
        settle(app, &pending).await;
    }
}

fn request_of(pending: &Pending) -> Value {
    json::get(&pending.body, "request")
        .cloned()
        .unwrap_or(Value::Null)
}

/// Commits the turn's ending to its Team's history: a challenge binds the turn, anything else ends it.
async fn commit(app: &App, pending: &Pending, answer: &Answer) -> bool {
    let (team_id, turn) = (pending.team_id.as_str(), pending.history_id.as_deref());
    if first_challenge(answer, team_id).is_some() {
        return history::challenge(&app.domains.history.store, team_id, turn)
            .await
            .is_ok();
    }
    let event = turn_terminal(answer, team_id);
    history_terminal(app, team_id, turn, &event, true, None)
        .await
        .is_ok()
}

/// Tells Team the turn was delivered or revoked; the record goes once Team settled it.
async fn settled(app: &App, team: &Team, pending: &Pending, revoked: bool) {
    let request = request_of(pending);
    let response = bridge::settle_chat(team, &pending.team_id, &request, revoked).await;
    let gone = response.is_ok_and(|response| {
        response.success() || response.status == 404 || response.status == 409
    });
    if gone {
        let _ = app
            .domains
            .chat
            .turns
            .remove(&pending.team_id, &pending.nonce);
    }
}

/// Whether the turn's history already holds its ending (a reply committed before a crash).
async fn ended(app: &App, pending: &Pending) -> Result<bool, ()> {
    let Some(turn) = pending.history_id.clone() else {
        return Ok(true);
    };
    let team = pending.team_id.clone();
    history::blocking(&app.domains.history.store, move |store| {
        store.ended(&team, &turn)
    })
    .await
    .map_err(drop)
}

/// Ends a turn whose grant ended: revoked at Team first, so nothing of it runs again, then kept as failed unless its
/// history already holds its ending.
async fn revoke(app: &App, pending: &Pending) {
    let Ok(team) = app.granted_team(&pending.grant.session) else {
        return;
    };
    let request = request_of(pending);
    let Ok(response) = bridge::settle_chat(&team, &pending.team_id, &request, true).await else {
        return;
    };
    if unreached(&response) {
        return;
    }
    let Ok(ended) = ended(app, pending).await else {
        return;
    };
    let event = error_terminal(403, "the session that sent this message ended");
    let turn = pending.history_id.as_deref();
    if ended
        || history_terminal(app, &pending.team_id, turn, &event, true, None)
            .await
            .is_ok()
    {
        let _ = app
            .domains
            .chat
            .turns
            .remove(&pending.team_id, &pending.nonce);
    }
}

/// Settles one turn: sent again and delivered while its grant holds, revoked otherwise.
pub async fn settle(app: &Arc<App>, pending: &Pending) {
    if pending.revoked || !current(app, pending) {
        return revoke(app, pending).await;
    }
    let Ok(team) = app.granted_team(&pending.grant.session) else {
        return;
    };
    let credential = match model_credential(app, &team, &pending.team_id).await {
        Ok(Ok(credential)) => credential,
        // Without a provider key the turn cannot go on: it ends as Team would have ended it.
        Ok(Err(refusal)) => {
            if commit(app, pending, &refusal).await {
                settled(app, &team, pending, true).await;
            }
            return;
        }
        Err(_) => return,
    };
    resend(app, &team, pending, &credential).await;
}

/// Sends the turn again, watching its grant all the while: a session that ends meanwhile revokes it, and nothing of
/// it is delivered.
async fn resend(app: &App, team: &Team, pending: &Pending, credential: &bridge::Credential) {
    let progress = |_: Value| {};
    let sending = bridge::chat(team, &pending.team_id, &pending.body, credential, &progress);
    let sent = tokio::select! {
        sent = sending => sent,
        () = lapsed(app, pending) => return revoke(app, pending).await,
    };
    if !current(app, pending) {
        return revoke(app, pending).await;
    }
    if let Ok(response) = sent {
        delivered(app, team, pending, &response, credential.api_key.as_str()).await;
    }
}

/// Whether the turn may still be delivered: not revoked, and its grant holding.
fn current(app: &App, pending: &Pending) -> bool {
    !app.domains
        .chat
        .turns
        .revoked(&pending.team_id, &pending.nonce)
        && grant_current(app, &pending.grant)
}

/// Resolves once the turn's session ends or its grant lapses, while it is sent again.
async fn lapsed(app: &App, pending: &Pending) {
    while current(app, pending) {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Team's answer to a turn sent again: its ending committed and settled, nothing while Team cannot be reached, and
/// the record gone when Team settled it already.
async fn delivered(app: &App, team: &Team, pending: &Pending, response: &Reply, api_key: &str) {
    if unreached(response) {
        return;
    }
    if response.status == 409 && response.get_str("code") == Some("turn-delivered") {
        // Team settled it already: its ending is in the history or it was revoked.
        let _ = app
            .domains
            .chat
            .turns
            .remove(&pending.team_id, &pending.nonce);
        return;
    }
    let locale = json::get_str(&pending.body, "locale");
    let answer = projected(response, &pending.team_id, locale, api_key);
    if commit(app, pending, &answer).await {
        settled(app, team, pending, false).await;
    }
}
