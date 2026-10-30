//! Pure matching and textual decision rules for Local chat Assistant lifecycle proposals.

/// The identity of the Assistant a recent lifecycle turn named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssistantReference {
    /// Its id.
    pub assistant_id: String,
    /// Its name.
    pub name: String,
}
