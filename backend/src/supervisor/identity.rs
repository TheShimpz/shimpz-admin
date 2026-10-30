//! The Local Supervisor's identity (an id and an Ed25519 signing key in `admin.json`) and the Routine identity of the
//! same shape, with the published verification keys Team reads.

use std::{
    fs::OpenOptions,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

use data_encoding::{BASE64, HEXLOWER};
use ring::signature::{Ed25519KeyPair, KeyPair};
use rustix::fs::OFlags;
use zeroize::Zeroizing;

use crate::{
    fsio,
    json::{self, Value},
};

/// The Supervisor signing boundary is unavailable or invalid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SupervisorAuthorityError;

/// One identity: its 32-hex id and its raw Ed25519 seed.
#[derive(Clone)]
pub struct LocalIdentity {
    /// The id (`sub` of its assertions).
    pub supervisor_id: String,
    seed: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for LocalIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LocalIdentity")
            .field("supervisor_id", &self.supervisor_id)
            .finish_non_exhaustive()
    }
}

impl PartialEq for LocalIdentity {
    fn eq(&self, other: &Self) -> bool {
        self.supervisor_id == other.supervisor_id && self.seed.as_slice() == other.seed.as_slice()
    }
}

fn hex_exact(value: Option<&Value>, length: usize) -> Option<&str> {
    value.and_then(json::as_str).filter(|text| {
        text.len() == length
            && text
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

impl LocalIdentity {
    /// A fresh identity with a new id and key.
    #[must_use]
    pub fn generate() -> Self {
        Self {
            supervisor_id: crate::random::hex(16),
            seed: Zeroizing::new(crate::random::bytes::<32>()),
        }
    }

    /// A fresh key under an existing id (a key rotation).
    #[must_use]
    pub fn with_new_key(supervisor_id: &str) -> Self {
        Self {
            supervisor_id: supervisor_id.to_owned(),
            seed: Zeroizing::new(crate::random::bytes::<32>()),
        }
    }

    /// The identity stored under `id_field` and `key_field` of a record.
    ///
    /// # Errors
    ///
    /// Returns [`SupervisorAuthorityError`] when either is not its exact lowercase hex form.
    pub fn from_record(
        record: &Value,
        id_field: &str,
        key_field: &str,
    ) -> Result<Self, SupervisorAuthorityError> {
        let id = hex_exact(record.get(id_field), 32).ok_or(SupervisorAuthorityError)?;
        let key = hex_exact(record.get(key_field), 64).ok_or(SupervisorAuthorityError)?;
        let mut seed = Zeroizing::new([0_u8; 32]);
        HEXLOWER
            .decode_mut(key.as_bytes(), seed.as_mut_slice())
            .map_err(|_| SupervisorAuthorityError)?;
        Ok(Self {
            supervisor_id: id.to_owned(),
            seed,
        })
    }

    /// The Supervisor's own identity in a record.
    ///
    /// # Errors
    ///
    /// Returns [`SupervisorAuthorityError`] when it is unavailable.
    pub fn supervisor(record: &Value) -> Result<Self, SupervisorAuthorityError> {
        Self::from_record(record, "supervisor_id", "supervisor_signing_key")
    }

    /// The key as the store keeps it: 64 lowercase hex digits.
    #[must_use]
    pub fn key_hex(&self) -> String {
        HEXLOWER.encode(self.seed.as_slice())
    }

    fn pair(&self) -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(self.seed.as_slice())
            .unwrap_or_else(|_| unreachable!("every 32-byte seed is an Ed25519 key"))
    }

    /// The 32 raw bytes of the verification key.
    #[must_use]
    pub fn public_key_raw(&self) -> [u8; 32] {
        let mut raw = [0_u8; 32];
        raw.copy_from_slice(self.pair().public_key().as_ref());
        raw
    }

    /// The verification key as a `SubjectPublicKeyInfo` PEM document.
    #[must_use]
    pub fn public_pem(&self) -> Vec<u8> {
        const SPKI_PREFIX: [u8; 12] = [
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        let mut der = SPKI_PREFIX.to_vec();
        der.extend_from_slice(&self.public_key_raw());
        format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            BASE64.encode(&der)
        )
        .into_bytes()
    }

    /// The Ed25519 signature of `message`.
    #[must_use]
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.pair().sign(message).as_ref().to_vec()
    }
}

fn safe_public_file(path: &Path, group: u32) -> Result<Option<Vec<u8>>, SupervisorAuthorityError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(SupervisorAuthorityError),
    };
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.gid() != group
        || metadata.mode() & 0o7777 != 0o440
        || !(1..=512).contains(&metadata.len())
    {
        return Err(SupervisorAuthorityError);
    }
    let raw = std::fs::read(path).map_err(|_| SupervisorAuthorityError)?;
    if u64::try_from(raw.len()).ok() != Some(metadata.len()) {
        return Err(SupervisorAuthorityError);
    }
    Ok(Some(raw))
}

/// Atomically publishes only the identity's verification key at `path`, group-readable by `group` (0440 in a 2770
/// directory of that group); an identical published key is left as it is.
///
/// # Errors
///
/// Returns [`SupervisorAuthorityError`] when the key volume is unavailable or unsafe, or the key cannot be verified.
pub fn materialize(
    path: &Path,
    group: u32,
    identity: &LocalIdentity,
) -> Result<(), SupervisorAuthorityError> {
    let parent = path.parent().ok_or(SupervisorAuthorityError)?;
    let directory = std::fs::symlink_metadata(parent).map_err(|_| SupervisorAuthorityError)?;
    if !directory.file_type().is_dir()
        || directory.gid() != group
        || directory.mode() & 0o7777 != 0o2770
    {
        return Err(SupervisorAuthorityError);
    }
    let expected = identity.public_pem();
    if safe_public_file(path, group)?.as_deref() == Some(expected.as_slice()) {
        return Ok(());
    }
    let temporary = parent.join(format!(
        ".public.{}.{}.tmp",
        std::process::id(),
        crate::random::hex(8)
    ));
    let published = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o440)
            .custom_flags(OFlags::NOFOLLOW.bits().cast_signed())
            .open(&temporary)
            .map_err(|_| SupervisorAuthorityError)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o440))
            .map_err(|_| SupervisorAuthorityError)?;
        let metadata = file.metadata().map_err(|_| SupervisorAuthorityError)?;
        if metadata.gid() != group || !metadata.file_type().is_file() {
            return Err(SupervisorAuthorityError);
        }
        file.write_all(&expected)
            .map_err(|_| SupervisorAuthorityError)?;
        file.sync_all().map_err(|_| SupervisorAuthorityError)?;
        drop(file);
        std::fs::rename(&temporary, path).map_err(|_| SupervisorAuthorityError)?;
        if safe_public_file(path, group)?.as_deref() != Some(expected.as_slice()) {
            return Err(SupervisorAuthorityError);
        }
        fsio::sync_directory(parent).map_err(|_| SupervisorAuthorityError)
    })();
    let _ = std::fs::remove_file(&temporary);
    published
}

#[cfg(test)]
mod tests;
