//! One structured preparation path for every fresh Local chat objective: classify the message once while
//! speculatively planning capabilities, then keep only the result the route needs (ADR-0077 amendment).

use std::{sync::Arc, time::Duration};

use team_protocol::{turn::MAX_INTENT_ROUTE_REPLY_CHARS, websocket::public_text};
use tokio::sync::watch;

use super::{
    guidance::{self, Guidance},
    inventory,
    plan::{self, Gap, Preparation, Selection},
    proposal::{self, AssistantReference, UninstallCandidate, UninstallTarget},
    uninstall,
};
use crate::{
    chat::{
        catalog::Offer,
        local::{
            Answer,
            route::{IntentRouteContext, RouteRequest, intent_route},
        },
    },
    fault::Fault,
    history::context::Entry,
    json::{self, Value},
    lanes::Ended,
    process::app::App,
    space::keys::decision,
    team::transport::Team,
};

/// How long classification waits for the plan's shortlist to describe it to the decision provider.
pub const GAP_WAIT: Duration = Duration::from_millis(400);

/// What a classification may know beside the message.
#[derive(Clone, Debug, Default)]
pub struct Context {
    /// The Assistant a recent lifecycle turn named.
    pub reference: Option<AssistantReference>,
    /// The committed conversation before the message.
    pub conversation: Vec<Entry>,
}

/// One route answer.
#[derive(Clone, Debug, Default)]
struct Route {
    intent: String,
    query: String,
    assistant_ids: Vec<String>,
    reply: String,
    task_follows: bool,
    capability_free: bool,
}

/// What one message's preparation resolved to.
#[derive(Clone, Debug, PartialEq)]
pub struct Prepared {
    /// `ordinary-task`, `assistant-install`, `assistant-uninstall`, or `unresolved`.
    pub intent: &'static str,
    /// A task's capability preparation.
    pub preparation: Option<Preparation>,
    /// The one Assistant an uninstall request selected.
    pub uninstall: Option<UninstallTarget>,
    /// The guidance the turn ends with.
    pub guidance: Option<Guidance>,
    /// The status the route ends with.
    pub error_status: Option<u16>,
}

impl Prepared {
    fn new(intent: &'static str) -> Self {
        Self {
            intent,
            preparation: None,
            uninstall: None,
            guidance: None,
            error_status: None,
        }
    }

    fn guided(intent: &'static str, guidance: Guidance) -> Self {
        Self {
            guidance: Some(guidance),
            ..Self::new(intent)
        }
    }

    fn with_preparation(intent: &'static str, preparation: Preparation) -> Self {
        Self {
            preparation: Some(preparation),
            ..Self::new(intent)
        }
    }
}

/// Structured routing failed: its status, and chat's own public refusal when it names a remedy.
#[derive(Clone, Debug, PartialEq)]
pub struct RouteError {
    /// The status.
    pub status: u16,
    /// The refusal the turn ends with instead.
    pub event: Option<Value>,
}

impl RouteError {
    /// A failure of `status`.
    #[must_use]
    pub const fn status(status: u16) -> Self {
        Self {
            status,
            event: None,
        }
    }
}

impl From<Fault> for RouteError {
    fn from(_: Fault) -> Self {
        Self::status(503)
    }
}

fn intent_name(intent: &str) -> &'static str {
    match intent {
        "ordinary-task" => "ordinary-task",
        "assistant-install" => "assistant-install",
        "assistant-uninstall" => "assistant-uninstall",
        _ => "unresolved",
    }
}

fn refusal(answer: &Answer, team_id: &str) -> Option<Value> {
    (answer.public && answer.reply.get_str("code") == Some("credential-record-invalid"))
        .then(|| answer.websocket_event(team_id))
        .flatten()
}

fn guidance_reply_valid(reply: &str) -> bool {
    public_text(&json::text(reply), MAX_INTENT_ROUTE_REPLY_CHARS).is_ok_and(|shown| shown == reply)
}

/// Whether a route answer's capability verdict, if it carries one, fits its intent.
fn capability_valid(capability: Option<&Value>, intent: &str) -> bool {
    match capability.map(json::as_str) {
        None | Some(Some("possible")) => true,
        Some(Some("not-needed")) => intent == "ordinary-task",
        Some(_) => false,
    }
}

/// Whether a route answer's fields fit what was asked.
fn answer_valid(body: &Value, team_id: &str, expected: Option<&str>, task_follows: bool) -> bool {
    let intent = json::get_str(body, "intent").unwrap_or_default();
    let query = json::get_str(body, "query").unwrap_or_default();
    let reply = json::get_str(body, "reply").unwrap_or_default();
    let reply_valid = if expected.is_none() {
        let requires = intent == "unresolved"
            || (matches!(intent, "assistant-install" | "assistant-uninstall") && query.is_empty());
        reply.is_empty() != requires
    } else {
        (intent == "unresolved") != reply.is_empty()
    };
    !(task_follows && (expected.is_some() || intent != "assistant-install"))
        && json::get_str(body, "team_id") == Some(team_id)
        && matches!(
            intent,
            "ordinary-task" | "assistant-install" | "assistant-uninstall" | "unresolved"
        )
        && (reply.is_empty() || guidance_reply_valid(reply))
        && reply_valid
}

fn project(body: &Value, team_id: &str, expected: Option<&str>) -> Option<Route> {
    let mut body = body.clone();
    let capability = json::remove(&mut body, "capability");
    if !json::has_exactly(
        &body,
        &[
            "team_id",
            "intent",
            "query",
            "assistant_ids",
            "reply",
            "task_follows",
        ],
    ) {
        return None;
    }
    let Some(Value::Bool(task_follows)) = body.get("task_follows").cloned() else {
        return None;
    };
    let intent = json::get_str(&body, "intent")?;
    let query = json::get_str(&body, "query")?;
    let reply = json::get_str(&body, "reply")?;
    let ids: Vec<String> = json::as_array(body.get("assistant_ids")?)?
        .iter()
        .map(|id| json::as_str(id).map(str::to_owned))
        .collect::<Option<_>>()?;
    let valid = answer_valid(&body, team_id, expected, task_follows)
        && capability_valid(capability.as_ref(), intent);
    valid.then(|| Route {
        intent: intent.to_owned(),
        query: query.to_owned(),
        assistant_ids: ids,
        reply: reply.to_owned(),
        task_follows,
        capability_free: capability.as_ref().and_then(json::as_str) == Some("not-needed"),
    })
}

async fn route(
    app: &App,
    team: &Team,
    team_id: &str,
    request: &RouteRequest<'_>,
) -> Result<Route, RouteError> {
    let answer = intent_route(app, team, team_id, request).await?;
    if !answer.reply.success() {
        let status = if (400..=599).contains(&answer.reply.status) {
            answer.reply.status
        } else {
            502
        };
        return Err(RouteError {
            status,
            event: refusal(&answer, team_id),
        });
    }
    project(&answer.reply.body, team_id, request.expected).ok_or(RouteError::status(502))
}

fn selection_context(locale: &str) -> IntentRouteContext {
    IntentRouteContext {
        locale: Some(locale.to_owned()),
        ..IntentRouteContext::default()
    }
}

fn target_guidance(intent: &'static str, reply: &str) -> Guidance {
    Guidance {
        code: if intent == "assistant-install" {
            "assistant-install-target-required"
        } else {
            "assistant-uninstall-target-required"
        },
        reply: reply.to_owned(),
    }
}

fn platform(code: &'static str, locale: &str) -> Result<Guidance, RouteError> {
    guidance::platform(code, locale).ok_or(RouteError::status(503))
}

fn directory_entry(offer: &Offer) -> Value {
    json::object(vec![
        ("id", json::text(offer.assistant_id())),
        ("name", json::text(offer.name())),
        ("summary", json::text(offer.summary())),
    ])
}

fn uninstall_entry(candidate: &UninstallCandidate) -> Value {
    json::object(vec![
        ("id", json::text(&candidate.assistant.assistant_id)),
        ("name", json::text(&candidate.assistant.name)),
        ("summary", json::text("")),
    ])
}

async fn prepare_install(
    app: &App,
    team: &Team,
    team_id: &str,
    payload: &Value,
    classification: &Route,
) -> Result<Prepared, RouteError> {
    let locale = json::get_str(payload, "locale").unwrap_or_default();
    let (installed, available) = tokio::join!(
        inventory::installed_inventory(team, team_id),
        plan::planning_catalog(app, team)
    );
    let (installed, available) = (installed?, available?);
    let shortlist = proposal::install_shortlist(&classification.query, &available);
    let directory: Vec<Value> = shortlist.iter().map(directory_entry).collect();
    let query = json::text(&classification.query);
    let context = selection_context(locale);
    let request = RouteRequest {
        objective: &query,
        expected: Some("assistant-install"),
        candidates: &directory,
        context: &context,
        installable: &[],
    };
    let selection = route(app, team, team_id, &request).await?;
    if selection.intent == "unresolved" {
        return Ok(Prepared::guided(
            "assistant-install",
            target_guidance("assistant-install", &selection.reply),
        ));
    }
    let bound = Selection {
        selected_ids: &selection.assistant_ids,
        installed: &installed,
        available: &available,
        task_follows: classification.task_follows,
    };
    let preparation = plan::prepare_install(app, team, team_id, payload, &bound).await;
    Ok(Prepared::with_preparation("assistant-install", preparation))
}

/// Selects one installed Assistant from the uninstall directory.
async fn uninstall_selection(
    app: &App,
    team: &Team,
    team_id: &str,
    query: &str,
    locale: &str,
    shortlist: &[UninstallCandidate],
) -> Result<Route, RouteError> {
    let entries: Vec<Value> = shortlist.iter().map(uninstall_entry).collect();
    let objective = json::text(query);
    let context = selection_context(locale);
    let request = RouteRequest {
        objective: &objective,
        expected: Some("assistant-uninstall"),
        candidates: &entries,
        context: &context,
        installable: &[],
    };
    route(app, team, team_id, &request).await
}

async fn prepare_uninstall(
    app: &App,
    team: &Team,
    team_id: &str,
    query: &str,
    locale: &str,
) -> Result<Prepared, RouteError> {
    let directory = uninstall::candidates(team, team_id).await?;
    let shortlist = proposal::uninstall_shortlist(query, &directory.candidates);
    let selection = uninstall_selection(app, team, team_id, query, locale, &shortlist).await?;
    if selection.intent == "unresolved" {
        let guidance = target_guidance("assistant-uninstall", &selection.reply);
        return Ok(Prepared::guided("assistant-uninstall", guidance));
    }
    let chosen = |candidate: &&UninstallCandidate| {
        selection
            .assistant_ids
            .contains(&candidate.assistant.assistant_id)
    };
    let matches: Vec<&UninstallCandidate> = shortlist.iter().filter(chosen).collect();
    let [candidate] = matches.as_slice() else {
        return Err(RouteError::status(502));
    };
    let id = &candidate.assistant.assistant_id;
    if directory.refused.contains(id) {
        let guidance = platform("assistant-uninstall-replacement", locale)?;
        return Ok(Prepared::guided("assistant-uninstall", guidance));
    }
    let creator = inventory::binding_creator(team, team_id, id, &candidate.version)
        .await
        .map_err(|_| RouteError::status(502))?;
    let target = UninstallTarget {
        candidate: (*candidate).clone(),
        creator,
    };
    Ok(Prepared {
        uninstall: Some(target),
        ..Prepared::new("assistant-uninstall")
    })
}

async fn lifecycle(
    app: &App,
    team: &Team,
    team_id: &str,
    payload: &Value,
    classification: &Route,
    allow_uninstall: bool,
) -> Result<Prepared, RouteError> {
    let locale = json::get_str(payload, "locale").unwrap_or_default();
    let intent = intent_name(&classification.intent);
    let attached = payload
        .get("files")
        .and_then(json::as_array)
        .is_some_and(|files| !files.is_empty());
    if attached {
        return Ok(Prepared::guided(
            intent,
            platform("assistant-lifecycle-attachments", locale)?,
        ));
    }
    match intent {
        "unresolved" => Ok(Prepared::guided(
            "unresolved",
            Guidance {
                code: "assistant-lifecycle-ambiguous",
                reply: classification.reply.clone(),
            },
        )),
        "assistant-install" if classification.query.is_empty() => Ok(Prepared::guided(
            intent,
            target_guidance(intent, &classification.reply),
        )),
        "assistant-install" => prepare_install(app, team, team_id, payload, classification).await,
        _ if !allow_uninstall => Ok(Prepared {
            error_status: Some(422),
            ..Prepared::new("unresolved")
        }),
        _ if classification.query.is_empty() => Ok(Prepared::guided(
            intent,
            target_guidance(intent, &classification.reply),
        )),
        _ => prepare_uninstall(app, team, team_id, &classification.query, locale).await,
    }
}

/// The speculative capability plan, which publishes its gap as soon as it exists.
type Speculation = crate::lanes::Job<Result<Preparation, Fault>>;
type GapSlot = watch::Receiver<Option<Result<Option<Gap>, ()>>>;

fn speculate(
    app: &Arc<App>,
    team: &Team,
    team_id: &str,
    payload: &Value,
) -> Option<(Speculation, GapSlot)> {
    let (sender, receiver) = watch::channel(None);
    let (app_handle, team, team_id, payload) = (
        Arc::clone(app),
        team.clone(),
        team_id.to_owned(),
        payload.clone(),
    );
    let job = app.domains.chat.lanes.capability.submit(async move {
        let app = app_handle;
        let gap = plan::capability_gap(&app, &team, &team_id, &payload).await;
        let _ = sender.send(Some(gap.clone().map_err(|_| ())));
        let gap = gap?;
        Ok(plan::plan_gap(&app, &team, &team_id, &payload, gap.as_ref()).await)
    });
    job.ok().map(|job| (job, receiver))
}

/// The plan's shortlist for classification, when a decision key may receive it and it exists within the wait.
async fn installable(app: &App, slot: &GapSlot) -> Vec<Value> {
    if !matches!(decision::resolve(&app.store), Ok(Some(_))) {
        return Vec::new();
    }
    let mut slot = slot.clone();
    let Ok(Ok(published)) = tokio::time::timeout(GAP_WAIT, slot.wait_for(Option::is_some)).await
    else {
        return Vec::new();
    };
    match &*published {
        Some(Ok(Some(gap))) if !gap.shortlist.is_empty() => gap.installable(),
        _ => Vec::new(),
    }
}

async fn ordinary(
    app: &App,
    team: &Team,
    team_id: &str,
    payload: &Value,
    classification: &Route,
    speculation: Option<Speculation>,
) -> Result<Prepared, RouteError> {
    if classification.capability_free
        && let Some(job) = &speculation
    {
        let _ = job.cancel();
        return Ok(Prepared::with_preparation(
            "ordinary-task",
            Preparation::default(),
        ));
    }
    let preparation = match speculation {
        Some(job) => match job.wait().await {
            Ended::Done(preparation) => preparation?,
            Ended::Cancelled | Ended::Panicked => return Err(RouteError::status(503)),
        },
        None => plan::prepare_capability(app, team, team_id, payload).await?,
    };
    let attached = payload
        .get("files")
        .and_then(json::as_array)
        .is_some_and(|files| !files.is_empty());
    if attached && preparation.plan.is_some() {
        let locale = json::get_str(payload, "locale").unwrap_or_default();
        return Ok(Prepared::guided(
            "ordinary-task",
            platform("assistant-capability-attachments", locale)?,
        ));
    }
    Ok(Prepared::with_preparation("ordinary-task", preparation))
}

/// Classifies one message, describing the plan's shortlist when it exists in time.
async fn classify(
    app: &App,
    team: &Team,
    team_id: &str,
    payload: &Value,
    context: Context,
    slot: Option<&GapSlot>,
) -> Result<Route, RouteError> {
    let described = match slot {
        Some(slot) => installable(app, slot).await,
        None => Vec::new(),
    };
    let route_context = IntentRouteContext {
        reference: context.reference,
        conversation: context.conversation,
        locale: json::get_str(payload, "locale").map(str::to_owned),
    };
    let message = payload.get("message").cloned().unwrap_or(Value::Null);
    let request = RouteRequest {
        objective: &message,
        expected: None,
        candidates: &[],
        context: &route_context,
        installable: &described,
    };
    route(app, team, team_id, &request).await
}

async fn prepare_with(
    app: &Arc<App>,
    team: &Team,
    team_id: &str,
    payload: &Value,
    context: Context,
    allow_uninstall: bool,
) -> Result<Prepared, RouteError> {
    let speculation = speculate(app, team, team_id, payload);
    let classified = classify(
        app,
        team,
        team_id,
        payload,
        context,
        speculation.as_ref().map(|(_, slot)| slot),
    )
    .await;
    let classification = match classified {
        Ok(classification) => classification,
        Err(error) => {
            if let Some((job, _)) = &speculation {
                let _ = job.cancel();
            }
            return Err(error);
        }
    };
    let speculation = speculation.map(|(job, _)| job);
    if classification.intent == "ordinary-task" {
        return ordinary(app, team, team_id, payload, &classification, speculation).await;
    }
    if let Some(job) = &speculation {
        let _ = job.cancel();
    }
    lifecycle(
        app,
        team,
        team_id,
        payload,
        &classification,
        allow_uninstall,
    )
    .await
}

/// Classifies a fresh chat turn and opens only its required bounded directory.
///
/// # Errors
///
/// Returns [`RouteError`] when routing could not complete.
pub async fn prepare(
    app: &Arc<App>,
    team: &Team,
    team_id: &str,
    payload: &Value,
    context: Context,
) -> Result<Prepared, RouteError> {
    prepare_with(app, team, team_id, payload, context, true).await
}

/// Reclassifies a reconnect objective without admitting destructive lifecycle work.
///
/// # Errors
///
/// Returns [`RouteError`] when routing could not complete.
pub async fn prepare_resume(
    app: &Arc<App>,
    team: &Team,
    team_id: &str,
    payload: &Value,
) -> Result<Prepared, RouteError> {
    prepare_with(app, team, team_id, payload, Context::default(), false).await
}
