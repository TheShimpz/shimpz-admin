//! The Local Admin backend (ADR-0123 phase R6): the Supervisor's sign-in and session, the session socket every Admin
//! screen reads and changes through, chat, and the bounded bridge to the Local Team. It holds no Docker socket and no
//! host configuration write surface.

pub mod app;
pub mod authority;
pub mod background;
pub mod chat;
pub mod clock;
pub mod command;
pub mod config;
pub mod domains;
pub mod fault;
pub mod fsio;
pub mod history;
pub mod http;
pub mod integrations;
pub mod json;
pub mod keys;
pub mod lanes;
pub mod outbound;
pub mod random;
pub mod record;
pub mod routine;
pub mod session;
pub mod signin;
pub mod space;
pub mod supervisor;
pub mod sync;
pub mod team;
pub mod timefmt;
pub mod verify;
