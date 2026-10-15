"""Admin's custody of its private files: complete writes, durable atomic replacement, and bounded owner-only reads."""

import os
import stat
import tempfile
from pathlib import Path


def sync_directory(path: Path) -> None:
    """Make an earlier create, rename, or unlink inside `path` durable."""
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_all(descriptor: int, payload: bytes) -> None:
    """Write every byte: os.write may write fewer bytes than asked, and only a complete payload counts."""
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written < 1:
            raise OSError("incomplete write")
        view = view[written:]


def replace_atomically(path: Path, payload: bytes) -> None:
    """Durably replace `path` with `payload` in a file created 0600 from birth.

    The temporary name is random and exclusively created, so a leftover from a killed process never blocks a later
    write. The file is fsynced before the rename and the directory after it; a failed write leaves no temporary file.
    """
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        try:
            write_all(descriptor, payload)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    sync_directory(path.parent)


def read_private(path: Path, max_bytes: int, *, require_group: int | None = None, single_link: bool = False) -> bytes:
    """Read a non-empty regular 0600 file this process owns, of at most `max_bytes`, never through a final symlink.

    The open never blocks, so a special file planted at `path` is refused rather than waited on.

    `require_group` also requires that group, and `single_link` a file with no other hard link. It raises OSError
    when the file cannot be read and ValueError when it fails these checks or changes size while being read.
    """
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        record = os.fstat(descriptor)
        if (
            not stat.S_ISREG(record.st_mode)
            or stat.S_IMODE(record.st_mode) != 0o600
            or record.st_uid != os.geteuid()
            or (require_group is not None and record.st_gid != require_group)
            or (single_link and record.st_nlink != 1)
            or not 0 < record.st_size <= max_bytes
        ):
            raise ValueError("private file has unsafe metadata")
        payload = os.read(descriptor, max_bytes + 1)
        if len(payload) != record.st_size:
            raise ValueError("private file changed while reading")
        return payload
    finally:
        os.close(descriptor)
