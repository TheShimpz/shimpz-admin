//! The bounded outbound queue of one session socket (ADR-0114 decision 8).
//!
//! Results and chat frames are never dropped. A change notice is an invalidation only, so a newer one for the same
//! topic replaces the one still queued. More than the bound waiting to be written closes the socket, and the client
//! re-reads after reconnecting.

use std::{collections::VecDeque, sync::Mutex};

use tokio::sync::Notify;

use crate::sync::lock;

/// Why a frame could not be queued.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// The socket closed.
    Closed,
    /// The queued bytes exceeded their bound.
    Overflow,
}

struct Item {
    text: String,
    topic: Option<String>,
}

#[derive(Default)]
struct Inner {
    items: VecDeque<Item>,
    queued: usize,
    closed: bool,
}

/// One socket's queue.
pub struct Outbound {
    limit: usize,
    inner: Mutex<Inner>,
    ready: Notify,
}

impl Outbound {
    /// A queue of at most `limit` bytes.
    #[must_use]
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            inner: Mutex::new(Inner::default()),
            ready: Notify::new(),
        }
    }

    /// Queues one serialized frame; a change notice replaces the one still queued for its topic.
    ///
    /// # Errors
    ///
    /// Returns [`Refused`] when the socket closed or the queue overflowed (the frame stays queued then).
    pub fn put(&self, text: String, topic: Option<&str>) -> Result<(), Refused> {
        let mut inner = lock(&self.inner);
        if inner.closed {
            return Err(Refused::Closed);
        }
        let size = text.len();
        let queued = topic.and_then(|topic| {
            inner
                .items
                .iter()
                .position(|item| item.topic.as_deref() == Some(topic))
        });
        if let Some(position) = queued {
            let previous = std::mem::replace(&mut inner.items[position].text, text).len();
            inner.queued = inner.queued + size - previous;
        } else {
            inner.items.push_back(Item {
                text,
                topic: topic.map(str::to_owned),
            });
            inner.queued += size;
        }
        let overflowed = inner.queued > self.limit;
        drop(inner);
        self.ready.notify_one();
        if overflowed {
            Err(Refused::Overflow)
        } else {
            Ok(())
        }
    }

    /// Refuses every later frame.
    pub fn close(&self) {
        lock(&self.inner).closed = true;
        self.ready.notify_one();
    }

    /// The bytes waiting.
    #[must_use]
    pub fn queued(&self) -> usize {
        lock(&self.inner).queued
    }

    /// The next frame to write.
    pub async fn take(&self) -> String {
        loop {
            let notified = self.ready.notified();
            {
                let mut inner = lock(&self.inner);
                if let Some(item) = inner.items.pop_front() {
                    inner.queued -= item.text.len();
                    return item.text;
                }
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests;
