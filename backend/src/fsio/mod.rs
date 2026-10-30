//! Admin's custody of its private files: complete writes, durable atomic replacement, and bounded owner-only reads.

use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

use rustix::fs::{Mode, OFlags};

/// Why a private file could not be read.
#[derive(Debug)]
pub enum PrivateReadError {
    /// No file is at the path.
    NotFound,
    /// The file could not be opened or read.
    Io,
    /// The file is not a private regular file of this process within its bound, or changed while it was read.
    Unsafe,
}

/// What a private read requires beyond a non-empty regular 0600 file this process owns.
#[derive(Clone, Copy, Debug, Default)]
pub struct Requirements {
    /// The file's group.
    pub group: Option<u32>,
    /// No other hard link.
    pub single_link: bool,
}

/// Makes an earlier create, rename, or unlink inside `directory` durable.
///
/// # Errors
///
/// Returns the I/O failure.
pub fn sync_directory(directory: &Path) -> io::Result<()> {
    File::open(directory)?.sync_all()
}

/// Durably replaces `path` with `payload` through a randomly named file created 0600, fsynced before the rename; the
/// directory is fsynced after it. A failed write leaves no temporary file.
///
/// # Errors
///
/// Returns the I/O failure; `path` then still holds its earlier content.
pub fn replace_atomically(path: &Path, payload: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let temporary = parent.join(format!(".{name}.{}.tmp", crate::random::hex(8)));
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(OFlags::NOFOLLOW.bits().cast_signed())
            .open(&temporary)?;
        file.write_all(payload)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    sync_directory(parent)
}

/// Reads a non-empty regular 0600 file this process owns, of at most `max_bytes`, never through a final symlink; the
/// open never blocks, so a special file planted at `path` is refused rather than waited on.
///
/// # Errors
///
/// Returns [`PrivateReadError`].
pub fn read_private(
    path: &Path,
    max_bytes: u64,
    requirements: Requirements,
) -> Result<Vec<u8>, PrivateReadError> {
    let descriptor = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|error| {
        if error == rustix::io::Errno::NOENT {
            PrivateReadError::NotFound
        } else {
            PrivateReadError::Io
        }
    })?;
    let metadata = rustix::fs::fstat(&descriptor).map_err(|_| PrivateReadError::Io)?;
    let size = u64::try_from(metadata.st_size).unwrap_or(0);
    let regular =
        rustix::fs::FileType::from_raw_mode(metadata.st_mode) == rustix::fs::FileType::RegularFile;
    if !regular
        || metadata.st_mode & 0o7777 != 0o600
        || metadata.st_uid != rustix::process::geteuid().as_raw()
        || requirements
            .group
            .is_some_and(|group| metadata.st_gid != group)
        || (requirements.single_link && metadata.st_nlink != 1)
        || size == 0
        || size > max_bytes
    {
        return Err(PrivateReadError::Unsafe);
    }
    let mut payload = Vec::new();
    File::from(descriptor)
        .take(max_bytes + 1)
        .read_to_end(&mut payload)
        .map_err(|_| PrivateReadError::Io)?;
    if u64::try_from(payload.len()).ok() != Some(size) {
        return Err(PrivateReadError::Unsafe);
    }
    Ok(payload)
}

/// The effective user id of this process.
#[must_use]
pub fn euid() -> u32 {
    rustix::process::geteuid().as_raw()
}

/// The effective group id of this process.
#[must_use]
pub fn egid() -> u32 {
    rustix::process::getegid().as_raw()
}

#[cfg(test)]
mod tests;
