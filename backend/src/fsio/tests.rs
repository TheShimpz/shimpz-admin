use std::os::unix::fs::PermissionsExt;

use super::*;

#[test]
fn a_private_read_refuses_anything_but_an_owner_only_regular_file_in_its_bound() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("status.json");
    assert!(matches!(
        read_private(&path, 1024, Requirements::default()),
        Err(PrivateReadError::NotFound)
    ));
    replace_atomically(&path, b"{}").unwrap();
    assert_eq!(
        read_private(&path, 1024, Requirements::default()).unwrap(),
        b"{}"
    );
    assert!(matches!(
        read_private(&path, 1, Requirements::default()),
        Err(PrivateReadError::Unsafe)
    ));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
    assert!(matches!(
        read_private(&path, 1024, Requirements::default()),
        Err(PrivateReadError::Unsafe)
    ));
    let link = root.path().join("link.json");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(read_private(&link, 1024, Requirements::default()).is_err());
}

#[test]
fn a_single_link_read_refuses_a_hard_linked_file() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("status.json");
    replace_atomically(&path, b"{}").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::hard_link(&path, root.path().join("second.json")).unwrap();
    let single = Requirements {
        group: None,
        single_link: true,
    };
    assert!(matches!(
        read_private(&path, 1024, single),
        Err(PrivateReadError::Unsafe)
    ));
}

#[test]
fn a_replacement_is_created_owner_only_and_leaves_no_temporary_file() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("admin.json");
    replace_atomically(&path, b"one").unwrap();
    replace_atomically(&path, b"two").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"two");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
}
