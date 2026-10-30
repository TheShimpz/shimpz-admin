use std::sync::Arc;

use super::*;

fn binding(socket: &str) -> Binding {
    Binding {
        session: "s".to_owned(),
        socket: socket.to_owned(),
    }
}

fn operation<'a>(subject: &'a str, socket: &str) -> Issue<'a> {
    Issue {
        purpose: Purpose::Operation,
        origin: Some("http://127.0.0.1:7777"),
        generation: 1,
        subject,
        binding: Some(binding(socket)),
    }
}

#[test]
fn a_ticket_is_spent_by_any_presentation_and_lives_three_minutes() {
    let clock = Arc::new(Clock::new());
    let tickets = Tickets::new(Arc::clone(&clock));
    let token = tickets.issue(operation("recovery-codes", "a")).unwrap();
    assert!(
        tickets
            .consume(
                &token,
                Purpose::Operation,
                "supervisor-key",
                Some(&binding("a"))
            )
            .is_err()
    );
    assert!(
        tickets
            .consume(
                &token,
                Purpose::Operation,
                "recovery-codes",
                Some(&binding("a"))
            )
            .is_err()
    );
    let token = tickets.issue(operation("recovery-codes", "a")).unwrap();
    assert!(
        tickets
            .consume(
                &token,
                Purpose::Operation,
                "recovery-codes",
                Some(&binding("b"))
            )
            .is_err()
    );
    let token = tickets.issue(operation("recovery-codes", "a")).unwrap();
    clock.advance(180);
    assert!(
        tickets
            .consume(
                &token,
                Purpose::Operation,
                "recovery-codes",
                Some(&binding("a"))
            )
            .is_err()
    );
    let token = tickets.issue(operation("recovery-codes", "a")).unwrap();
    let ticket = tickets
        .consume(
            &token,
            Purpose::Operation,
            "recovery-codes",
            Some(&binding("a")),
        )
        .unwrap();
    assert_eq!(ticket.generation, 1);
}

#[test]
fn a_socket_s_tickets_end_with_it_and_subjects_are_exact() {
    let tickets = Tickets::new(Arc::new(Clock::new()));
    let token = tickets.issue(operation("routine-delete:t:r", "a")).unwrap();
    tickets.revoke(&binding("a"));
    assert!(
        tickets
            .consume(
                &token,
                Purpose::Operation,
                "routine-delete:t:r",
                Some(&binding("a"))
            )
            .is_err()
    );
    assert!(tickets.issue(operation(" padded", "a")).is_err());
    assert!(tickets.issue(operation("", "a")).is_err());
    assert!(
        tickets
            .issue(
                Issue {
                    subject: "x",
                    ..operation("x", "a")
                }
                .with_purpose(Purpose::Login)
            )
            .is_err()
    );
}

impl Issue<'_> {
    fn with_purpose(mut self, purpose: Purpose) -> Self {
        self.purpose = purpose;
        self
    }
}
