//! Stateless gap planning and sequential fresh Assistant installation for one chat task.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use team_protocol::{
    payload::{MAX_CHAT_ASSISTANTS, MAX_TEAM_ASSISTANTS},
    turn::{MAX_CAPABILITY_SELECTED, MAX_INTENT_ROUTE_SELECTED},
};

use super::{
    install::{ASSISTANT_LIMIT_REACHED, install},
    inventory::{self, Installed},
    proposal::{self, Capability},
};
use crate::{
    app::App,
    chat::{
        catalog::{
            Offer,
            local::{self, localized_summary},
            store::PLANNING_LOCALE,
        },
        local::route,
    },
    fault::Fault,
    json::{self, Value},
    team::{bridge, transport::Team},
};

/// One admitted install plan.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    /// Its id.
    pub plan_id: String,
    /// The Team.
    pub team_id: String,
    /// The Assistants it installs, in order.
    pub assistants: Vec<Offer>,
    /// The Assistant scope the original task dispatches with afterwards.
    pub dispatch_ids: Vec<String>,
    /// Whether the plan ends its turn.
    pub terminal: bool,
    /// The Assistants an install request named.
    pub lifecycle_ids: Vec<String>,
}

/// A selection that already runs.
#[derive(Clone, Debug, PartialEq)]
pub struct AlreadyInstalled {
    /// Its id.
    pub plan_id: String,
    /// The Team.
    pub team_id: String,
    /// Its cards' items.
    pub assistants: Vec<Value>,
    /// The scope the task continues with, if a task follows.
    pub dispatch_ids: Vec<String>,
}

/// What a task's preparation resolved to.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Preparation {
    /// A plan to run.
    pub plan: Option<Plan>,
    /// A selection that already runs.
    pub already_installed: Option<AlreadyInstalled>,
    /// The status the preparation failed with.
    pub error_status: Option<u16>,
    /// Team's closed refusal code.
    pub error_code: Option<&'static str>,
}

/// A plan beyond the Team's Assistant bound, refused before Team admission with Team's own code.
#[must_use]
pub fn limit_reached() -> Preparation {
    Preparation {
        error_status: Some(409),
        error_code: Some(ASSISTANT_LIMIT_REACHED),
        ..Preparation::default()
    }
}

fn failed(status: u16) -> Preparation {
    Preparation {
        error_status: Some(status),
        ..Preparation::default()
    }
}

/// How one plan ended.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// `installed`, `failed`, or `stopped`.
    pub state: &'static str,
    /// Its items.
    pub assistants: Vec<Value>,
    /// The status it failed with.
    pub status: Option<u16>,
    /// Team's closed refusal code.
    pub code: Option<&'static str>,
}

fn providers(integrations: &[String]) -> Value {
    let mut sorted = integrations.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    json::strings(sorted)
}

fn planner_candidate(offer: &Offer) -> Value {
    json::object(vec![
        ("id", json::text(offer.assistant_id())),
        ("name", json::text(offer.name())),
        ("summary", json::text(offer.summary())),
        (
            "actions",
            json::strings(offer.actions().iter().map(String::as_str)),
        ),
        ("integrations", integration_pairs(offer.integrations())),
    ])
}

fn integration_pairs(providers: &[String]) -> Value {
    Value::Array(
        providers
            .iter()
            .map(|provider| {
                json::object(vec![
                    ("id", json::text(provider)),
                    ("provider", json::text(provider)),
                ])
            })
            .collect(),
    )
}

fn enabled_candidate(capability: &Capability) -> Value {
    let mut actions = capability.actions.clone();
    actions.sort_unstable();
    actions.dedup();
    let mut integrations = capability.integrations.clone();
    integrations.sort_unstable();
    integrations.dedup();
    let summary = if capability.summary.is_empty() {
        &capability.name
    } else {
        &capability.summary
    };
    json::object(vec![
        ("id", json::text(&capability.assistant_id)),
        ("name", json::text(&capability.name)),
        ("summary", json::text(summary)),
        ("actions", json::strings(actions)),
        ("integrations", integration_pairs(&integrations)),
    ])
}

/// What a plan may offer: every staged snapshot Team admitted, and each publication no staged identity shadows.
///
/// # Errors
///
/// Returns [`Fault::Internal`] when the Store catalog or the Local inventory is unavailable.
pub async fn planning_catalog(app: &App, team: &Team) -> Result<Vec<Offer>, Fault> {
    let catalog = &app.domains.chat.catalog;
    let (staged, public) = tokio::join!(
        bridge::list_local_assistants(team),
        catalog.get(&app.outbound, PLANNING_LOCALE)
    );
    let public = public.map_err(|_| Fault::Internal)?;
    let staged = local::primary(&staged).map_err(|_| Fault::Internal)?;
    let mut combined: Vec<Offer> = staged.offerable.into_iter().map(Offer::Local).collect();
    combined.extend(
        public
            .iter()
            .filter(|assistant| !staged.staged_ids.contains(&assistant.assistant_id))
            .cloned()
            .map(Offer::Published),
    );
    combined.sort_by(|left, right| left.assistant_id().cmp(right.assistant_id()));
    Ok(combined)
}

/// The exact current state one message's capability plan reasons over, and the bounded shortlist it offers; a
/// classification describes exactly this shortlist (ADR-0077 amendment).
#[derive(Clone, Debug)]
pub struct Gap {
    /// The installed Assistants.
    pub installed: Installed,
    /// The enabled capabilities.
    pub enabled: Vec<Capability>,
    /// The enabled capabilities kept as planner context.
    pub kept_enabled: Vec<Capability>,
    /// The installable shortlist.
    pub shortlist: Vec<Offer>,
}

impl Gap {
    /// The shortlist as the decision provider receives it: each name and summary, nothing else.
    #[must_use]
    pub fn installable(&self) -> Vec<Value> {
        self.shortlist
            .iter()
            .map(|offer| {
                json::object(vec![
                    ("name", json::text(offer.name())),
                    ("summary", json::text(offer.summary())),
                ])
            })
            .collect()
    }
}

fn scope(payload: &Value) -> Vec<String> {
    payload
        .get("assistant_ids")
        .and_then(json::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(json::as_str)
        .map(str::to_owned)
        .collect()
}

async fn enabled_state(
    team: &Team,
    team_id: &str,
    enabled_ids: &[String],
) -> Result<(Installed, Option<Vec<Capability>>), Fault> {
    if enabled_ids.is_empty() {
        return Ok((
            inventory::installed_inventory(team, team_id).await?,
            Some(Vec::new()),
        ));
    }
    let (installed, registry) = tokio::join!(
        bridge::list_installed_assistants(team, team_id),
        bridge::team_assistant_registry(team, team_id)
    );
    let installed = inventory::installed(&installed?)?;
    let registry = inventory::registry(&registry?)?;
    let enabled = enabled_ids
        .iter()
        .map(|id| {
            let running = installed
                .get(id)
                .is_some_and(|item| item.status == "running");
            registry.get(id).filter(|_| running).cloned()
        })
        .collect::<Option<Vec<_>>>();
    Ok((installed, enabled))
}

/// Exact current state and the bounded shortlist, or `None` when nothing may be planned.
///
/// # Errors
///
/// Returns the inventory's fault.
pub async fn capability_gap(
    app: &App,
    team: &Team,
    team_id: &str,
    payload: &Value,
) -> Result<Option<Gap>, Fault> {
    let enabled_ids = scope(payload);
    let (available, state) = tokio::join!(
        planning_catalog(app, team),
        enabled_state(team, team_id, &enabled_ids)
    );
    let (installed, enabled) = state?;
    let (Some(enabled), Ok(available)) = (enabled, available) else {
        return Ok(None);
    };
    let enabled: Vec<Capability> = enabled
        .into_iter()
        .map(|capability| Capability {
            integrations: available
                .iter()
                .find(|offer| offer.assistant_id() == capability.assistant_id)
                .map(|offer| offer.integrations().to_vec())
                .unwrap_or_default(),
            ..capability
        })
        .collect();
    let installed_ids: Vec<String> = installed.keys().cloned().collect();
    let message = json::get_str(payload, "message").unwrap_or_default();
    let (kept_enabled, shortlist) =
        proposal::capability_candidates(message, &available, &installed_ids, &enabled);
    Ok(Some(Gap {
        installed,
        enabled,
        kept_enabled,
        shortlist,
    }))
}

fn selected_ids(body: &Value, team_id: &str, expected: &[String]) -> Option<Vec<String>> {
    let selected: Vec<String> = body
        .get("assistant_ids")
        .and_then(json::as_array)?
        .iter()
        .map(|item| json::as_str(item).map(str::to_owned))
        .collect::<Option<_>>()?;
    let status = json::get_str(body, "status")?;
    let valid = json::get_str(body, "team_id") == Some(team_id)
        && matches!(status, "sufficient" | "install-required")
        && selected.windows(2).all(|pair| pair[0] < pair[1])
        && selected.len() <= MAX_CAPABILITY_SELECTED
        && selected.iter().all(|id| expected.contains(id))
        && (status == "sufficient") == selected.is_empty();
    valid.then_some(selected)
}

/// The planned Assistants as a person reads them: every summary in the turn's interface language (ADR-0091), from
/// discovery's localized catalog of exactly the same publication or a staged snapshot's own pack; never English in
/// its place.
async fn shown(app: &App, team: &Team, assistants: &[Offer], locale: &str) -> Option<Vec<Offer>> {
    if locale == PLANNING_LOCALE {
        return Some(assistants.to_vec());
    }
    let mut published = None;
    let mut shown = Vec::with_capacity(assistants.len());
    for offer in assistants {
        match offer {
            Offer::Local(assistant) => {
                let summary = localized_summary(team, assistant, locale).await.ok()?;
                shown.push(offer.with_summary(summary));
            }
            Offer::Published(assistant) => {
                if published.is_none() {
                    published = Some(
                        app.domains
                            .chat
                            .catalog
                            .get(&app.outbound, locale)
                            .await
                            .ok()?,
                    );
                }
                let localized = published
                    .as_ref()?
                    .iter()
                    .find(|item| item.assistant_id == assistant.assistant_id)?;
                let mut compared = localized.clone();
                compared.summary.clone_from(&assistant.summary);
                if compared != *assistant {
                    return None;
                }
                shown.push(Offer::Published(localized.clone()));
            }
        }
    }
    Some(shown)
}

async fn shown_preparation(
    app: &App,
    team: &Team,
    preparation: Preparation,
    locale: &str,
) -> Preparation {
    let Some(plan) = preparation.plan.clone() else {
        return preparation;
    };
    match shown(app, team, &plan.assistants, locale).await {
        Some(assistants) => Preparation {
            plan: Some(Plan { assistants, ..plan }),
            ..preparation
        },
        None => failed(502),
    }
}

fn beyond_limit(installed: &Installed, missing: &[String]) -> bool {
    let mut all: Vec<&String> = installed.keys().chain(missing).collect();
    all.sort_unstable();
    all.dedup();
    all.len() > MAX_TEAM_ASSISTANTS
}

/// What one admitted plan installs and dispatches.
struct Planned<'a> {
    team_id: &'a str,
    enabled_ids: &'a [String],
    shortlist: &'a [Offer],
    selected: &'a [String],
    terminal: bool,
    dispatch_selected: Option<&'a [String]>,
    lifecycle_ids: &'a [String],
}

fn prepared_plan(planned: &Planned<'_>) -> Preparation {
    if planned.selected.is_empty() {
        return Preparation::default();
    }
    let mut dispatch_ids: Vec<String> = planned.enabled_ids.to_vec();
    dispatch_ids.extend_from_slice(planned.dispatch_selected.unwrap_or(planned.selected));
    dispatch_ids.sort_unstable();
    dispatch_ids.dedup();
    if dispatch_ids.len() > MAX_CHAT_ASSISTANTS {
        return limit_reached();
    }
    let assistants = planned
        .selected
        .iter()
        .filter_map(|id| {
            planned
                .shortlist
                .iter()
                .find(|offer| offer.assistant_id() == id)
                .cloned()
        })
        .collect();
    Preparation {
        plan: Some(Plan {
            plan_id: crate::random::hex(16),
            team_id: planned.team_id.to_owned(),
            assistants,
            dispatch_ids,
            terminal: planned.terminal,
            lifecycle_ids: planned.lifecycle_ids.to_vec(),
        }),
        ..Preparation::default()
    }
}

/// Team's capability plan over the gap's candidates and the ids it may select, when Team answered it.
async fn plan_answer(
    app: &App,
    team: &Team,
    team_id: &str,
    payload: &Value,
    gap: &Gap,
) -> Option<(crate::chat::local::Answer, Vec<String>)> {
    let mut candidates: Vec<Value> = gap.kept_enabled.iter().map(enabled_candidate).collect();
    candidates.extend(gap.shortlist.iter().map(planner_candidate));
    candidates.sort_by(|left, right| json::get_str(left, "id").cmp(&json::get_str(right, "id")));
    let expected: Vec<String> = candidates
        .iter()
        .filter_map(|item| json::get_str(item, "id"))
        .map(str::to_owned)
        .collect();
    let message = payload.get("message").cloned().unwrap_or(Value::Null);
    let answer = route::capability_plan(app, team, team_id, &message, candidates)
        .await
        .ok()?;
    answer.reply.success().then_some((answer, expected))
}

/// The deterministic missing-capability gate over one resolved gap.
pub async fn plan_gap(
    app: &App,
    team: &Team,
    team_id: &str,
    payload: &Value,
    gap: Option<&Gap>,
) -> Preparation {
    let Some(gap) = gap.filter(|gap| !gap.shortlist.is_empty()) else {
        return Preparation::default();
    };
    let Some((answer, expected)) = plan_answer(app, team, team_id, payload, gap).await else {
        return Preparation::default();
    };
    let Some(selected) = selected_ids(&answer.reply.body, team_id, &expected) else {
        return Preparation::default();
    };
    let missing: Vec<String> = selected
        .into_iter()
        .filter(|id| gap.shortlist.iter().any(|offer| offer.assistant_id() == id))
        .collect();
    if beyond_limit(&gap.installed, &missing) {
        return limit_reached();
    }
    let enabled_ids: Vec<String> = gap
        .enabled
        .iter()
        .map(|capability| capability.assistant_id.clone())
        .collect();
    let prepared = prepared_plan(&Planned {
        team_id,
        enabled_ids: &enabled_ids,
        shortlist: &gap.shortlist,
        selected: &missing,
        terminal: false,
        dispatch_selected: None,
        lifecycle_ids: &[],
    });
    shown_preparation(
        app,
        team,
        prepared,
        json::get_str(payload, "locale").unwrap_or_default(),
    )
    .await
}

/// Resolves exact current state, then applies the missing-capability gate.
///
/// # Errors
///
/// Returns the inventory's fault.
pub async fn prepare_capability(
    app: &App,
    team: &Team,
    team_id: &str,
    payload: &Value,
) -> Result<Preparation, Fault> {
    let gap = capability_gap(app, team, team_id, payload).await?;
    Ok(plan_gap(app, team, team_id, payload, gap.as_ref()).await)
}

async fn already_installed(
    app: &App,
    team: &Team,
    team_id: &str,
    selected: &[Offer],
    installed: &Installed,
    dispatch_ids: Vec<String>,
    locale: &str,
) -> Preparation {
    if dispatch_ids.len() > MAX_CHAT_ASSISTANTS {
        return failed(409);
    }
    let Some(shown) = shown(app, team, selected, locale).await else {
        return failed(502);
    };
    let mut assistants = Vec::with_capacity(shown.len());
    for offer in &shown {
        let Some(current) = installed.get(offer.assistant_id()) else {
            return failed(502);
        };
        let Ok(creator) =
            inventory::binding_creator(team, team_id, offer.assistant_id(), &current.version).await
        else {
            return failed(502);
        };
        assistants.push(json::object(vec![
            ("id", json::text(offer.assistant_id())),
            ("name", json::text(offer.name())),
            ("summary", json::text(offer.summary())),
            ("creator", json::text(creator)),
            ("version", json::text(&current.version)),
            ("providers", providers(offer.integrations())),
            ("provenance", json::text(&current.provenance)),
            ("status", json::text("installed")),
        ]));
    }
    Preparation {
        already_installed: Some(AlreadyInstalled {
            plan_id: crate::random::hex(16),
            team_id: team_id.to_owned(),
            assistants,
            dispatch_ids,
        }),
        ..Preparation::default()
    }
}

/// What a structured install selection is bound to.
pub struct Selection<'a> {
    /// The ids the route selected.
    pub selected_ids: &'a [String],
    /// The installed Assistants.
    pub installed: &'a Installed,
    /// What a plan may offer.
    pub available: &'a [Offer],
    /// Whether the objective also asks for work.
    pub task_follows: bool,
}

/// Binds a structured install selection to exact current state: terminal for an install-only request; when a task
/// follows, its objective is dispatched once after installation or after confirming the selection already runs.
pub async fn prepare_install(
    app: &App,
    team: &Team,
    team_id: &str,
    payload: &Value,
    selection: &Selection<'_>,
) -> Preparation {
    let count = selection.selected_ids.len();
    if count == 0 || count > MAX_INTENT_ROUTE_SELECTED {
        return failed(422);
    }
    let Some(selected) = selection.selected() else {
        return failed(409);
    };
    let locale = json::get_str(payload, "locale").unwrap_or_default();
    let missing = selection.missing();
    let scope = scope(payload);
    if missing.is_empty() {
        let dispatch_ids = if selection.task_follows {
            union(&scope, selection.selected_ids)
        } else {
            Vec::new()
        };
        return already_installed(
            app,
            team,
            team_id,
            &selected,
            selection.installed,
            dispatch_ids,
            locale,
        )
        .await;
    }
    if beyond_limit(selection.installed, &missing) {
        return limit_reached();
    }
    let prepared = prepared_plan(&Planned {
        team_id,
        enabled_ids: &scope,
        shortlist: selection.available,
        selected: &missing,
        terminal: !selection.task_follows,
        dispatch_selected: Some(selection.selected_ids),
        lifecycle_ids: selection.selected_ids,
    });
    shown_preparation(app, team, prepared, locale).await
}

fn union(left: &[String], right: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = left.iter().chain(right).cloned().collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

impl Selection<'_> {
    /// The selected offers, when every selected id is one a plan may offer.
    fn selected(&self) -> Option<Vec<Offer>> {
        self.selected_ids
            .iter()
            .map(|id| {
                self.available
                    .iter()
                    .find(|offer| offer.assistant_id() == id)
                    .cloned()
            })
            .collect()
    }

    /// The selected ids that do not run now.
    fn missing(&self) -> Vec<String> {
        self.selected_ids
            .iter()
            .filter(|id| {
                self.installed
                    .get(*id)
                    .is_none_or(|item| item.status != "running")
            })
            .cloned()
            .collect()
    }
}

fn items(plan: &Plan, states: &[&str]) -> Vec<Value> {
    plan.assistants
        .iter()
        .zip(states)
        .map(|(offer, state)| {
            json::object(vec![
                ("id", json::text(offer.assistant_id())),
                ("name", json::text(offer.name())),
                ("summary", json::text(offer.summary())),
                ("creator", json::text(offer.creator())),
                ("version", json::text(offer.version())),
                ("providers", providers(offer.integrations())),
                ("provenance", json::text(offer.provenance())),
                ("status", json::text(*state)),
            ])
        })
        .collect()
}

/// Every item of a plan before it starts.
#[must_use]
pub fn initial_items(plan: &Plan) -> Vec<Value> {
    items(plan, &vec!["pending"; plan.assistants.len()])
}

/// A plan's progress or terminal event.
#[must_use]
pub fn event(
    plan: &Plan,
    state: &str,
    assistants: Vec<Value>,
    status: Option<u16>,
    code: Option<&str>,
    continuation: Option<&str>,
) -> Value {
    let mut members = vec![
        ("type", json::text("assistant-install-plan")),
        ("state", json::text(state)),
        ("plan_id", json::text(&plan.plan_id)),
        ("team_id", json::text(&plan.team_id)),
        ("assistants", Value::Array(assistants)),
    ];
    if let Some(status) = status {
        members.push(("status", json::int(i64::from(status))));
    }
    if let Some(code) = code {
        members.push(("code", json::text(code)));
    }
    if let Some(continuation) = continuation {
        members.push(("continuation", json::text(continuation)));
    }
    json::object(members)
}

/// One idempotent answer that claims no fresh install; a requested task continues after it.
#[must_use]
pub fn already_installed_event(result: &AlreadyInstalled) -> Value {
    json::object(vec![
        ("type", json::text("assistant-install-plan")),
        ("state", json::text("installed")),
        ("plan_id", json::text(&result.plan_id)),
        ("team_id", json::text(&result.team_id)),
        ("assistants", Value::Array(result.assistants.clone())),
        (
            "continuation",
            json::text(if result.dispatch_ids.is_empty() {
                "none"
            } else {
                "dispatch"
            }),
        ),
        ("outcome", json::text("already-installed")),
    ])
}

/// `None` once the Assistant is proven running, else the failure status and Team's closed code, if any.
async fn install_and_prove_running(
    app: &App,
    team: &Team,
    team_id: &str,
    offer: &Offer,
) -> Option<(u16, Option<&'static str>)> {
    let Ok(result) = install(app, team, team_id, offer).await else {
        return Some((502, None));
    };
    if result.installed.is_none() || !(200..300).contains(&result.status) {
        return Some(if (400..=599).contains(&result.status) {
            (result.status, result.code)
        } else {
            (502, None)
        });
    }
    let Ok(installed) = inventory::installed_inventory(team, team_id).await else {
        return Some((502, None));
    };
    let running = installed
        .get(offer.assistant_id())
        .is_some_and(|item| item.status == "running");
    if running { None } else { Some((502, None)) }
}

/// Installs a plan sequentially, keeping the items that succeeded and stopping only between items.
pub async fn execute(
    app: &App,
    team: &Team,
    plan: &Plan,
    stopped: &Arc<AtomicBool>,
    progress: &(dyn Fn(Vec<Value>) + Send + Sync),
) -> Outcome {
    let mut states = vec!["pending"; plan.assistants.len()];
    for (index, offer) in plan.assistants.iter().enumerate() {
        if stopped.load(Ordering::SeqCst) {
            return Outcome {
                state: "stopped",
                assistants: items(plan, &states),
                status: None,
                code: None,
            };
        }
        states[index] = "installing";
        progress(items(plan, &states));
        if let Some((status, code)) =
            install_and_prove_running(app, team, &plan.team_id, offer).await
        {
            states[index] = "failed";
            return Outcome {
                state: "failed",
                assistants: items(plan, &states),
                status: Some(status),
                code,
            };
        }
        states[index] = "installed";
        progress(items(plan, &states));
    }
    Outcome {
        state: "installed",
        assistants: items(plan, &states),
        status: None,
        code: None,
    }
}
