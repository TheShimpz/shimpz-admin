//! Every Admin operation a session socket call names (ADR-0114 decision 3), each answering exactly as its HTTP route
//! did: the same validation, Team identity checks, limits, lanes, and audit.

use futures_util::future::BoxFuture;

use super::{calls::Call, frames};
use crate::{
    chat,
    fault::{Outcome, Reply},
    routine, signin, space,
    space::keys,
    team,
};

/// A method whose port has not landed yet.
///
/// # Errors
///
/// Never.
pub async fn unported(_call: &Call) -> Outcome {
    tokio::task::yield_now().await;
    Ok(Reply::detail(501, "not implemented"))
}

fn subscribe(call: &Call) -> Reply {
    let named = frames::topics(&call.params).unwrap_or_default();
    let reply = call.socket.subscribe(&named);
    call.app().domains.session.watcher.refresh(call.app());
    reply
}

fn unsubscribe(call: &Call) -> Reply {
    let named = frames::topics(&call.params).unwrap_or_default();
    let reply = call.socket.unsubscribe(&named);
    call.app().domains.session.watcher.refresh(call.app());
    reply
}

type Handler = for<'a> fn(&'a Call) -> BoxFuture<'a, Outcome>;

macro_rules! handlers {
    ($($name:literal => $handler:expr),* $(,)?) => {
        &[$(($name, |call: &Call| -> BoxFuture<'_, Outcome> { Box::pin($handler(call)) })),*]
    };
}

macro_rules! now {
    ($operation:expr) => {
        |call: &Call| std::future::ready(Ok($operation(call)))
    };
}

/// Each method and the operation it runs.
const HANDLERS: &[(&str, Handler)] = handlers! {
    "teams.list" => team::methods::teams_list,
    "teams.create" => team::methods::teams_create,
    "teams.rename" => team::methods::teams_rename,
    "teams.reorder" => team::methods::teams_reorder,
    "teams.delete" => team::methods::teams_delete,
    "history.page" => chat::methods::history_page,
    "routines.list" => routine::methods::routines_list,
    "platform.release" => space::methods::platform_release,
    "security.summary" => signin::methods::security_summary,
    "inference.read" => team::methods::inference_read,
    "inference.save" => team::methods::inference_save,
    "assistants.registry" => team::methods::assistants_registry,
    "assistants.list" => team::methods::assistants_list,
    "assistants.install" => team::methods::assistants_install,
    "assistants.install_local" => team::methods::assistants_install_local,
    "assistants.uninstall" => team::methods::assistants_uninstall,
    "assistants.summary" => team::methods::assistants_summary,
    "assistants.details" => team::methods::assistants_details,
    "snapshots.list" => team::methods::snapshots_list,
    "snapshots.summary" => team::methods::snapshots_summary,
    "snapshots.details" => team::methods::snapshots_details,
    "models.list" => keys::methods::models_list,
    "models.save" => keys::methods::models_save,
    "decision.read" => keys::methods::decision_read,
    "decision.save" => keys::methods::decision_save,
    "decision.remove" => keys::methods::decision_remove,
    "chat_limit.read" => chat::methods::chat_limit_read,
    "chat_limit.save" => chat::methods::chat_limit_save,
    "integrations.list" => chat::methods::integrations_list,
    "integrations.authorize" => chat::methods::integrations_authorize,
    "integrations.complete" => chat::methods::integrations_complete,
    "integrations.cancel" => chat::methods::integrations_cancel,
    "stored_inputs.list" => team::methods::stored_inputs_list,
    "stored_inputs.clear" => team::methods::stored_inputs_clear,
    "files.acknowledge" => team::methods::files_acknowledge,
    "browser.view" => team::methods::browser_view,
    "sign_in.start" => team::methods::sign_in_start,
    "sign_in.save" => team::methods::sign_in_save,
    "sign_in.cancel" => team::methods::sign_in_cancel,
    "sign_in.read" => team::methods::sign_in_read,
    "sign_in.deletion" => team::methods::sign_in_deletion,
    "sign_in.delete" => team::methods::sign_in_delete,
    "store.catalog" => chat::methods::store_catalog,
    "routines.pause" => routine::methods::routines_pause,
    "routines.resume" => routine::methods::routines_resume,
    "routines.deletion" => routine::methods::routines_deletion,
    "routines.delete" => routine::methods::routines_delete,
    "routines.plan_steps" => routine::methods::routines_plan_steps,
    "routines.run_steps" => routine::methods::routines_run_steps,
    "routines.diagnostics" => routine::methods::routines_diagnostics,
    "routines.card" => routine::methods::routines_card,
    "routines.card_answer" => routine::methods::routines_card_answer,
    "routines.challenge" => routine::methods::routines_challenge,
    "routines.human" => routine::methods::routines_human,
    "routines.integrations" => routine::methods::routines_integrations,
    "routines.proposal_confirm" => routine::methods::routines_proposal_confirm,
    "routines.proposal_revoke" => routine::methods::routines_proposal_revoke,
    "security.acknowledge" => signin::methods::security_acknowledge,
    "recovery_codes.confirmation" => signin::methods::recovery_codes_confirmation,
    "recovery_codes.replace" => signin::methods::recovery_codes_replace,
    "supervisor_key.confirmation" => signin::methods::supervisor_key_confirmation,
    "supervisor_key.rotate" => signin::methods::supervisor_key_rotate,
    "subscribe" => now!(subscribe),
    "unsubscribe" => now!(unsubscribe),
    "chat.attach" => now!(|call: &Call| call.socket.attach(call.param("team_id"), call.param("locale"))),
    "chat.detach" => now!(|call: &Call| call.socket.detach(call.param("team_id"))),
};

/// Runs the call's method.
///
/// # Errors
///
/// Returns the method's fault.
pub async fn dispatch(call: &Call) -> Outcome {
    match HANDLERS.iter().find(|(name, _)| *name == call.method) {
        Some((_, handler)) => handler(call).await,
        None => unported(call).await,
    }
}

#[cfg(test)]
mod tests;
