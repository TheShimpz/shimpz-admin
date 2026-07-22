"""Integration wiring metadata for each keyset group.

One entry per `keyset` group (asserted complete by test-admin-catalog.py, so no field is ever
orphaned from the configuration API). `recreate_target` names the STATELESS sidecar that must be
recreated for a saved secret to take effect live (Phase C2) — `None` means "applies on next restart"
(the brain, stateful datastores, and no-consumer groups). `container_env_for` maps the `.env` key
names a human types to the ACTUAL env var names the target container reads (mirrors docker-compose.yml).
"""

import keyset

INFRA = "INFRA"
CATEGORIES = (INFRA,)

# group → configuration and runtime metadata.
CATALOG = {
    "internal": {
        "public_name": "Datastores",
        "category": INFRA,
        "blurb": "PostgreSQL — generated and managed for you.",
        "recreate_target": None,  # stateful: rotation is not a clean recreate
        "reconfigurable": False,
    },
    "advanced": {
        "public_name": "Advanced",
        "category": INFRA,
        "blurb": "Host, desktop and multi-instance knobs. Most installs never touch these.",
        "recreate_target": None,
        "reconfigurable": True,
    },
}


def entry(group):
    """Exact lookup; unknown group raises (the fail-fast contract, mirrors keyset.field)."""
    try:
        return CATALOG[group]
    except KeyError:
        raise ValueError(f"unknown integration group {group!r} — not in the catalog") from None


def keys_for(group):
    """The keyset field keys belonging to `group`, in schema order (single source of truth)."""
    entry(group)  # validate the group exists
    return [f["key"] for f in keyset.SCHEMA if f["group"] == group]


def container_env_for(group, values):
    """Map the group's `.env` values → the env var names the recreate target actually reads.

    Only the stateless recreate target needs this; everything else returns {} (nothing to
    recreate). Mirrors docker-compose.yml's `environment:` for each driver. Empty strings are
    intentional — disabling an integration recreates the sidecar INERT.
    """
    return {}
