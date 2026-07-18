"""Integration wiring metadata for each keyset group.

One entry per `keyset` group (asserted complete by test-admin-catalog.py, so no field is ever
orphaned from the configuration API). `recreate_target` names the STATELESS sidecar that must be
recreated for a saved secret to take effect live (Phase C2) — `None` means "applies on next restart"
(the brain, stateful datastores, and no-consumer groups). `container_env_for` maps the `.env` key
names a human types to the ACTUAL env var names the target container reads (mirrors docker-compose.yml).
"""

import keyset

CAPABILITY, INFRA = "CAPABILITY", "INFRA"
CATEGORIES = (CAPABILITY, INFRA)

# group → configuration and runtime metadata.
CATALOG = {
    "openai": {
        "public_name": "OpenAI",
        "category": CAPABILITY,
        "blurb": "Transcription, speech generation, and image generation.",
        "recreate_target": "openai-driver",
        "reconfigurable": True,
    },
    "storage-r2": {
        "public_name": "Cloudflare R2",
        "category": CAPABILITY,
        "blurb": "Object storage for uploads, share links and backups.",
        "recreate_target": "r2-driver",
        "reconfigurable": True,
    },
    "cloudflare": {
        "public_name": "Cloudflare",
        "category": CAPABILITY,
        "blurb": "Publish Shimpz's apps on your own domains (DNS, Tunnel, Access).",
        # only the SHIMPZ_CF_TOKEN/SHIMPZ_CF_ACCOUNT subset auto-applies; CF_TUNNEL_TOKEN → cloudflared (restart)
        "recreate_target": "cf-driver",
        "reconfigurable": True,
    },
    "internal": {
        "public_name": "Datastores",
        "category": INFRA,
        "blurb": "PostgreSQL + Redpanda — generated and managed for you.",
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

    Only the three stateless recreate targets need this; everything else returns {} (nothing to
    recreate). Mirrors docker-compose.yml's `environment:` for each driver. Empty strings are
    intentional — disabling an integration recreates the sidecar INERT.
    """
    if group == "storage-r2":
        acct = values.get("R2_ACCOUNT_ID", "").strip()
        return {
            "R2_BUCKET": values.get("R2_BUCKET", ""),
            "RCLONE_CONFIG_R2_ACCESS_KEY_ID": values.get("R2_ACCESS_KEY_ID", ""),
            "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY": values.get("R2_SECRET_ACCESS_KEY", ""),
            "RCLONE_CONFIG_R2_ENDPOINT": f"https://{acct}.r2.cloudflarestorage.com" if acct else "",
        }
    if group == "openai":
        return {
            "OPENAI_API_KEY": values.get("SHIMPZ_OPENAI_MEDIA_API_KEY", ""),
            "VOICE_TOOLS_OPENAI_KEY": values.get("VOICE_TOOLS_OPENAI_KEY")
            or values.get("SHIMPZ_OPENAI_MEDIA_API_KEY", ""),
        }
    if group == "cloudflare":
        return {
            "SHIMPZ_CF_TOKEN": values.get("SHIMPZ_CF_TOKEN", ""),
            "SHIMPZ_CF_ACCOUNT": values.get("SHIMPZ_CF_ACCOUNT", ""),
        }
    return {}
