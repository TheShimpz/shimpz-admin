//! The Supervisor's order of the Local Team list.

use crate::{fault::Outcome, team::transport::Team};

/// The Local Team list in the Supervisor's order.
///
/// # Errors
///
/// Returns the Team request's fault.
pub async fn listing(team: &Team) -> Outcome {
    Ok(super::bridge::list_teams(team).await)
}
