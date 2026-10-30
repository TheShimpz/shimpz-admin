//! Bounded one-use password tickets: the private evidence binding a verified password to one second-factor attempt.

use std::{collections::HashMap, sync::Arc, sync::Mutex};

use crate::{clock::Clock, sync::lock};

/// A ticket lives this long.
pub const TICKET_TTL_MS: i64 = 180 * 1000;
/// At most this many tickets are outstanding.
pub const TICKET_CAPACITY: usize = 64;
/// The longest operation subject.
pub const MAX_SUBJECT_CHARS: usize = 128;

/// What a ticket completes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// A sign-in's second factor.
    Login,
    /// The first TOTP enrollment.
    TotpEnrollment,
    /// The TOTP re-enrollment a recovery code began.
    RecoveryEnrollment,
    /// One exact Supervisor operation, its subject.
    Operation,
}

/// The one session socket, and its session, a step-up ticket issued over that socket belongs to (ADR-0114).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Binding {
    /// The session's digest.
    pub session: String,
    /// The socket's own id.
    pub socket: String,
}

/// One outstanding ticket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    /// What it completes.
    pub purpose: Purpose,
    /// The browser origin it was issued to.
    pub origin: Option<String>,
    /// The factor generation it was issued under.
    pub generation: i64,
    /// When it expires on the monotonic clock.
    pub expires_at_ms: i64,
    /// The exact operation it confirms.
    pub subject: String,
    /// The socket it belongs to.
    pub binding: Option<Binding>,
}

/// A ticket is invalid, expired, reused, or unavailable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TicketError;

/// The one-process, bounded, one-use ticket authority.
pub struct Tickets {
    clock: Arc<Clock>,
    records: Mutex<HashMap<String, Ticket>>,
}

fn subject_admitted(purpose: Purpose, subject: &str) -> bool {
    if purpose != Purpose::Operation {
        return subject.is_empty();
    }
    !subject.is_empty()
        && subject.len() <= MAX_SUBJECT_CHARS
        && subject.bytes().all(|byte| (0x20..0x7f).contains(&byte))
        && subject.trim_matches(|character: char| team_protocol::python::text::isspace(character))
            == subject
}

/// What a new ticket is issued for.
#[derive(Clone, Debug)]
pub struct Issue<'a> {
    /// What it completes.
    pub purpose: Purpose,
    /// The browser origin it is issued to.
    pub origin: Option<&'a str>,
    /// The factor generation.
    pub generation: i64,
    /// The exact operation (only for [`Purpose::Operation`]).
    pub subject: &'a str,
    /// The socket it belongs to.
    pub binding: Option<Binding>,
}

impl Tickets {
    /// No ticket yet.
    #[must_use]
    pub fn new(clock: Arc<Clock>) -> Self {
        Self {
            clock,
            records: Mutex::new(HashMap::new()),
        }
    }

    fn expire(records: &mut HashMap<String, Ticket>, now: i64) {
        records.retain(|_, ticket| ticket.expires_at_ms > now);
    }

    /// Issues one ticket.
    ///
    /// # Errors
    ///
    /// Returns [`TicketError`] at capacity or for a binding outside the contract.
    pub fn issue(&self, issue: Issue<'_>) -> Result<String, TicketError> {
        if issue.generation < 1 || !subject_admitted(issue.purpose, issue.subject) {
            return Err(TicketError);
        }
        let now = self.clock.monotonic_ms();
        let mut records = lock(&self.records);
        Self::expire(&mut records, now);
        if records.len() >= TICKET_CAPACITY {
            return Err(TicketError);
        }
        let mut token = crate::random::urlsafe(32);
        while records.contains_key(&token) {
            token = crate::random::urlsafe(32);
        }
        records.insert(
            token.clone(),
            Ticket {
                purpose: issue.purpose,
                origin: issue.origin.map(str::to_owned),
                generation: issue.generation,
                expires_at_ms: now + TICKET_TTL_MS,
                subject: issue.subject.to_owned(),
                binding: issue.binding,
            },
        );
        Ok(token)
    }

    /// Takes one ticket once; one presented for another purpose, subject, or socket is spent all the same.
    ///
    /// # Errors
    ///
    /// Returns [`TicketError`] for an unknown, expired, or mismatched ticket.
    pub fn consume(
        &self,
        token: &str,
        purpose: Purpose,
        subject: &str,
        binding: Option<&Binding>,
    ) -> Result<Ticket, TicketError> {
        if !(32..=64).contains(&token.len()) || !token.is_ascii() {
            return Err(TicketError);
        }
        let now = self.clock.monotonic_ms();
        let ticket = {
            let mut records = lock(&self.records);
            Self::expire(&mut records, now);
            records.remove(token)
        };
        match ticket {
            Some(ticket)
                if ticket.purpose == purpose
                    && ticket.subject == subject
                    && ticket.binding.as_ref() == binding =>
            {
                Ok(ticket)
            }
            _ => Err(TicketError),
        }
    }

    /// Invalidates every outstanding ticket of one socket, which closed or whose session ended.
    pub fn revoke(&self, binding: &Binding) {
        lock(&self.records).retain(|_, ticket| ticket.binding.as_ref() != Some(binding));
    }

    /// Invalidates every outstanding ticket after an authentication-state change.
    pub fn clear(&self) {
        lock(&self.records).clear();
    }
}

#[cfg(test)]
mod tests;
