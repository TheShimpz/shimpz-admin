use std::sync::Arc;

use super::*;
use crate::{session::topics::Topics, signin::sessions::Sessions, time::clock::Clock};

fn store(config: &Config) -> Store {
    let clock = Arc::new(Clock::new());
    let sessions = Arc::new(Sessions::new(Arc::clone(&clock)));
    Store::new(
        config.store_path.clone(),
        clock,
        sessions,
        Arc::new(Topics::new()),
    )
}

#[test]
fn a_fresh_state_verifies_with_zero_counts_and_a_damaged_one_fails() {
    let root = tempfile::tempdir().unwrap();
    let config = Config::under(root.path());
    std::fs::create_dir_all(config.store_path.parent().unwrap()).unwrap();
    assert_eq!(
        verify(&config, &store(&config)).unwrap(),
        concat!(
            "authentication_state=uninitialized\npasskeys=0\nmodel_keys=0\ndecision_key=0\n",
            "ordered_teams=0\nhistory_entries=0\n",
        )
    );
    std::fs::write(config.history_path(), b"not a database").unwrap();
    assert_eq!(verify(&config, &store(&config)), Err(StateError::Corrupt));
}
