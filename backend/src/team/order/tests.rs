use std::os::unix::fs::PermissionsExt;

use super::*;

fn entry(id: &str) -> TeamEntry {
    TeamEntry {
        team_id: id.to_owned(),
        team_name: id.to_uppercase(),
    }
}

fn ids(teams: &[TeamEntry]) -> Vec<&str> {
    teams.iter().map(|team| team.team_id.as_str()).collect()
}

#[test]
fn unsaved_teams_lead_newest_first_then_the_saved_order_that_still_names_a_team() {
    let teams = [entry("c"), entry("b"), entry("a")];
    let saved = ["a".to_owned(), "gone".to_owned(), "c".to_owned()];
    assert_eq!(ids(&arrange(&teams, Some(&saved))), ["b", "a", "c"]);
    assert_eq!(ids(&arrange(&teams, None)), ["c", "b", "a"]);
}

#[test]
fn only_unique_canonical_ids_within_the_bound_are_an_order() {
    let list = |items: &[&str]| json::strings(items.iter().copied());
    assert_eq!(
        canonical_ids(&list(&["a", "b_2"])),
        Some(vec!["a".to_owned(), "b_2".to_owned()])
    );
    assert_eq!(canonical_ids(&list(&["a", "a"])), None);
    assert_eq!(canonical_ids(&list(&["A"])), None);
    assert_eq!(canonical_ids(&json::text("a")), None);
    let many: Vec<String> = (0..=bridge::MAX_TEAMS)
        .map(|index| format!("t{index}"))
        .collect();
    assert_eq!(canonical_ids(&json::strings(many)), None);
}

#[test]
fn a_saved_order_is_read_only_from_a_private_exact_file() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("team-order.json");
    assert_eq!(load(&path), Ok(None));
    fsio::replace_atomically(&path, b"{\"team_ids\":[\"a\"]}").unwrap();
    assert_eq!(load(&path), Ok(Some(vec!["a".to_owned()])));
    for invalid in [
        "{\"team_ids\":[\"a\"],\"x\":1}",
        "{\"team_ids\":[\"a\",\"a\"]}",
        "[]",
        "{\"team_ids\":1,\"team_ids\":2}",
    ] {
        fsio::replace_atomically(&path, invalid.as_bytes()).unwrap();
        assert_eq!(load(&path), Err(OrderError::Invalid), "{invalid}");
    }
    fsio::replace_atomically(&path, b"{\"team_ids\":[]}").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(load(&path), Err(OrderError::Invalid));
}

#[test]
fn forgetting_rewrites_only_a_named_position_and_an_invalid_order_is_removed() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("team-order.json");
    fsio::replace_atomically(&path, b"{\"team_ids\":[\"a\",\"b\"]}").unwrap();
    forget(&path, "a").unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\"team_ids\":[\"b\"]}"
    );
    fsio::replace_atomically(&path, b"not json").unwrap();
    forget(&path, "b").unwrap();
    assert!(!path.exists());
}

#[test]
fn clearing_removes_admin_s_own_files_and_refuses_after_leaving_a_foreign_entry() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("team-order.json");
    fsio::replace_atomically(&path, b"{\"team_ids\":[]}").unwrap();
    std::fs::write(root.path().join(".team-order.json.abc.tmp"), b"x").unwrap();
    clear(&path).unwrap();
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    std::os::unix::fs::symlink("/etc/hostname", &path).unwrap();
    assert_eq!(clear(&path), Err(OrderError::Unavailable));
    assert!(std::fs::symlink_metadata(&path).is_ok());
}

#[test]
fn a_reorder_body_names_only_canonical_ids() {
    let body = json::object(vec![("team_ids", json::strings(["a"]))]);
    assert_eq!(requested_ids(&body).unwrap(), ["a"]);
    let refused =
        requested_ids(&json::object(vec![("team_ids", json::strings(["A"]))])).unwrap_err();
    assert_eq!(refused.reply().status, 400);
    assert_eq!(
        requested_ids(&json::empty()).unwrap_err().reply().body,
        json::detail("request body must contain only team_ids")
    );
}
