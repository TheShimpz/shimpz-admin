//! The one process-wide watcher of state Admin cannot observe itself (ADR-0114 decision 4).
//!
//! Teams made by the CLI, Assistant snapshots the CLI stages, and the platform release file change without passing
//! through Admin. While at least one open socket subscribes to such a topic, and only then, the watcher reads it no
//! more often than the page used to poll it, under the authority of a subscriber whose session is still current (never
//! renewing it), and raises the topic when its first sample is taken and afterwards only when the value changed.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use crate::{
    fault::{Fault, Reply},
    json::{self, Value},
    process::app::App,
    supervisor::authority::{SessionStatus, session_status},
    sync::lock,
};

/// The watched topics.
pub const WATCHED: [&str; 3] = ["platform/release", "teams", "local-assistants"];
/// How often each watched topic is read.
const INTERVAL_MS: i64 = 60_000;
/// How often the watcher wakes to see whether a watched topic is due.
const TICK: Duration = Duration::from_secs(1);

/// The watcher.
#[derive(Default)]
pub struct Watcher {
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

fn subscribed(app: &App, topic: &str) -> Vec<Arc<super::socket::Socket>> {
    app.domains
        .session
        .registry
        .sockets()
        .into_iter()
        .filter(|socket| socket.subscribed(topic))
        .collect()
}

/// A watched answer as the page sees it: Team's per-request trace identifier is never part of a change.
fn seen(reply: &Reply) -> Value {
    Value::Array(vec![
        json::int(i64::from(reply.status)),
        json::without(&reply.body, "trace_id"),
    ])
}

async fn sample(app: &App, topic: &str, cookie: &str) -> Result<Value, Fault> {
    if topic == "platform/release" {
        return Ok(
            crate::space::release::read_status(&app.config.release_status_path)
                .unwrap_or(Value::Null),
        );
    }
    let team = app.session_team(cookie)?;
    if topic == "teams" {
        Ok(seen(&crate::team::order::listing(app, &team).await?))
    } else {
        Ok(seen(
            &crate::team::bridge::list_local_assistants(&team).await,
        ))
    }
}

/// Reads `topic` under a current subscriber's authority; `false` when no subscriber's session is current.
async fn check(app: &App, topic: &'static str, values: &mut HashMap<&'static str, Value>) -> bool {
    let Some(subscriber) = subscribed(app, topic)
        .into_iter()
        .find(|socket| session_status(app, socket.cookie(), false) == SessionStatus::Active)
    else {
        return false;
    };
    let Ok(value) = sample(app, topic, subscriber.cookie()).await else {
        crate::process::command::log("warning", "session_watcher_read_failed");
        return true;
    };
    if values
        .get(topic)
        .is_none_or(|known| !json::equal(known, &value))
    {
        app.topics.changed(topic);
    }
    values.insert(topic, value);
    true
}

async fn run(app: Weak<App>) {
    let mut values = HashMap::new();
    let mut due: HashMap<&'static str, i64> = HashMap::new();
    loop {
        let Some(app) = app.upgrade() else {
            return;
        };
        for topic in WATCHED {
            let now = app.clock.monotonic_ms();
            if now >= due.get(topic).copied().unwrap_or(i64::MIN)
                && check(&app, topic, &mut values).await
            {
                due.insert(topic, now + INTERVAL_MS);
            }
        }
        drop(app);
        tokio::time::sleep(TICK).await;
    }
}

impl Watcher {
    /// Runs while a socket subscribes to a watched topic; stops, forgetting every value, once none does.
    pub fn refresh(&self, app: &Arc<App>) {
        let needed = WATCHED
            .iter()
            .any(|topic| !subscribed(app, topic).is_empty());
        let mut task = lock(&self.task);
        let running = task.as_ref().is_some_and(|task| !task.is_finished());
        if needed && !running {
            *task = Some(tokio::spawn(run(Arc::downgrade(app))));
        } else if !needed
            && running
            && let Some(task) = task.take()
        {
            task.abort();
        }
    }
}
