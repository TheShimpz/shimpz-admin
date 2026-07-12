"""Read/merge/write the repo's `.env` — the single source of truth compose's `:?` guards check.

Write side is schema-ordered with group headers, 0600, and PRESERVES any unmanaged keys it finds
(appended under a marked section) — the wizard must never eat a hand-added line. Read side returns
{} for a missing file: that is the normal state of a fresh install, not an error; an unreadable
existing file still raises (fail-loud).
"""

import errno
from contextlib import suppress
from pathlib import Path

import keyset


def read(path):
    """Parse KEY=VALUE lines → dict. Missing file → {} (fresh install); comments/blanks ignored."""
    p = Path(path)
    if not p.exists():
        return {}
    values = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        values[k.strip()] = v.strip()
    return values


def merge(existing, updates):
    """Overlay `updates` on `existing` with exact keyset lookups; unknown update key raises.

    Empty-string updates are skipped (an untouched form field must not erase a stored value).
    """
    for k in updates:
        keyset.field(k)  # raises on unknown — never silently write a stray key
    merged = dict(existing)
    merged.update({k: v.strip() for k, v in updates.items() if v.strip()})
    return merged


def render(values):
    """Serialize schema-ordered with group headers; unmanaged keys preserved at the end."""
    lines = ["# Managed by apps/admin (shimpz-setup wizard). Git-ignored — never commit."]
    group = None
    for f in keyset.SCHEMA:
        if f["group"] != group:
            group = f["group"]
            lines += ["", f"# ── {group} ──"]
        lines.append(f"{f['key']}={values.get(f['key'], '')}")
    unmanaged = {k: v for k, v in values.items() if k not in keyset.BY_KEY}
    if unmanaged:
        lines += ["", "# ── unmanaged (preserved by the wizard, not part of the keyset) ──"]
        lines += [f"{k}={v}" for k, v in sorted(unmanaged.items())]
    return "\n".join(lines) + "\n"


def write(path, values):
    """Write `.env` 0600 — atomically (tmp + rename) where possible, in-place where it must be.

    The atomic path (tmp file + rename on the same filesystem) is used host-side and whenever the
    repo dir is mounted writable. The in-place fallback covers the shimpz-admin container's shipped
    config, where BOTH atomic-path steps are impossible:
      • `.env` is bind-mounted as a SINGLE FILE (its own mountpoint) → renaming a sibling tmp onto it
        fails with EBUSY (or EXDEV across the mount); and
      • the enclosing `/repo` dir is on the `read_only: true` rootfs → creating the sibling tmp there
        fails first, with EROFS.
    Any of those → rewrite the existing inode in place (the single-file `.env` bind is writable),
    which also keeps the host file's owner/permissions. In-place isn't crash-atomic, but `.env` is
    written only on an explicit, rare "apply" by the single operator.
    """
    p = Path(path)
    data = render(values)
    tmp = p.with_suffix(".tmp")
    try:
        tmp.write_text(data, encoding="utf-8")
        tmp.chmod(0o600)
        tmp.replace(p)
    except OSError as e:
        if e.errno not in (errno.EBUSY, errno.EXDEV, errno.EROFS):
            raise
        with suppress(OSError):  # a partial tmp may not exist (EROFS aborts before create); ignore
            tmp.unlink(missing_ok=True)
        with p.open("w", encoding="utf-8") as fh:
            fh.write(data)
        p.chmod(0o600)


def mask(value):
    """`••••last4` for display — the API must never echo a stored secret back whole."""
    v = value.strip()
    if not v:
        return ""
    return "••••" + v[-4:] if len(v) > 8 else "••••"
