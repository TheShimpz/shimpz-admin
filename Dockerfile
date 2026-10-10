# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# check=skip=SecretsUsedInArgOrEnv ; shared GIDs are numeric access boundaries, never credentials
#
# shimpz-admin — the persistent local Team control panel. Runs as a compose service on 127.0.0.1
# only, holds no Docker socket or host configuration mount, and persists only its private `/data`.

# ── stage 1: obtain the exact uv binary without retaining an installer toolchain ──────────────
FROM ghcr.io/astral-sh/uv:0.12.1@sha256:cf4eedcaa81655197f625739489effcbe71b61ceb1506f332c3facae5deceded AS uv

# ── stage 2: build the SvelteKit static UI ────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:26.11.1-bookworm@sha256:f1233c415b41ffcf237c717b3dea92e9d4ea006e0e4c71edcb790605d74f5404 AS ui
# IPv6 egress is broken on the build host (see main Dockerfile) → prefer IPv4 so package downloads don't hang.
RUN echo 'precedence ::ffff:0:0/96 100' >> /etc/gai.conf
# The package install precedes every commit-bound input, so an unchanged lock reuses it at every commit: BuildKit
# gives a WORKDIR the release epoch as its creation time, and every RUN after an ARG reads the ARG's value.
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml frontend/bootstrap-pnpm.sh /w/
# The exact pnpm the manifest names, its registry tarball verified by bootstrap-pnpm.sh (Node.js 26 bundles no
# Corepack), installs from the lock alone. No dependency runs an install script (pnpm-workspace.yaml, repeated here):
# the build's native packages (Rolldown) ship as prebuilt optional dependencies.
ENV PATH="/opt/pnpm/bin:$PATH"
RUN cd /w && sh bootstrap-pnpm.sh /tmp/pnpm-cache /opt/pnpm && rm -rf /tmp/pnpm-cache && \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store && \
    rm -rf /tmp/pnpm-store
WORKDIR /w
COPY frontend/ ./
# The frontend tests run in the deploy's test entry point, not here. adapter-static writes the SPA to /w/build.
# Normalize the copied artifact tree explicitly: the release builder supplies the Git-derived epoch and the final
# Python stage consumes only this tree.
ARG SOURCE_DATE_EPOCH=0
RUN pnpm build && \
    find /w/build -depth -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

# ── stage 3: resolve target-platform Python dependencies ───────────────────────────────────────
# This stage deliberately follows TARGETPLATFORM so native wheels match the final image. Its layer is the runtime's
# base and a pure function of the pinned base, uv, and the lock (Shimpz ADR-0098): no ARG SOURCE_DATE_EPOCH, WORKDIR,
# COPY, or ADD here, uv and the lock arrive as read-only mounts on a discarded tmpfs, the uv cache is removed, and
# every /opt timestamp is fixed. An unchanged lock therefore yields the same layer bytes at every commit, with or
# without a build cache. The base ships no bytecode and the read-only runtime cannot write any, so the standard library
# and the environment are compiled here, hash-checked, with fixed timestamps: without it every Admin start, health
# probe, and helper recompiles each imported module (start to healthy about 3 s instead of 1 s).
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS dependencies
RUN --mount=type=tmpfs,target=/tmp \
    --mount=type=bind,from=uv,source=/uv,target=/tmp/uv \
    --mount=type=bind,source=pyproject.toml,target=/tmp/project/pyproject.toml \
    --mount=type=bind,source=uv.lock,target=/tmp/project/uv.lock \
    cd /tmp/project && \
    UV_PROJECT_ENVIRONMENT=/opt/venv UV_CACHE_DIR=/opt/uv-cache UV_LINK_MODE=copy \
        /tmp/uv sync --frozen --no-install-project --no-dev --python 3.14 && \
    rm -rf /opt/uv-cache && \
    PYTHONDONTWRITEBYTECODE=1 /opt/venv/bin/python -m compileall -q -f --invalidation-mode checked-hash /usr/local/lib/python3.14 /opt/venv && \
    find /usr/local/lib/python3.14 \( -type d -o -name '*.pyc' \) -exec touch -h -d @0 {} + && \
    find /opt -depth -exec touch -h -d @0 {} +

# ── stage 4: minimal Python runtime ─────────────────────────────────────────────────────────────
# The digest-pinned Python base already retains CA roots; build-only uv never enters an image layer.
FROM dependencies AS runtime
ARG SOURCE_DATE_EPOCH=0

# Runs as the host repo owner (uid 1000) for the existing Admin data-volume ownership contract.
RUN groupadd -g 1000 admin && \
    groupadd -g 10021 shimpzsupervisor-key && \
    useradd -u 1000 -g 1000 -G 10021 -M -s /usr/sbin/nologin admin

# /data → named volume (admin.json 0600); the public verifier volume contains no private key.
RUN mkdir -p /data /run/shimpz-local-release /run/shimpz-local-reset /run/shimpz-local-supervisor && \
    chown 1000:1000 /data && \
    chown 1000:1000 /run/shimpz-local-release && \
    chown 1000:1000 /run/shimpz-local-reset && \
    chown root:shimpzsupervisor-key /run/shimpz-local-supervisor && \
    chmod 2770 /run/shimpz-local-supervisor
# Every source copy below is a linked layer that no other copy depends on, so changing one file rebuilds only its
# own layer and the final import check.
WORKDIR /app/backend
COPY --link backend/app.py backend/authentication_state.py backend/browser.py backend/decision.py backend/models.py \
    backend/model_catalog.json \
    backend/state.py backend/supervisor.py ./
COPY --link backend/signin/audit.py backend/signin/auth.py backend/signin/local_auth.py backend/signin/security.py \
    ./signin/
COPY --link backend/signin/blocklist/passwords.txt ./signin/blocklist/
COPY --link backend/mfa/passkeys.py backend/mfa/recovery.py backend/mfa/tickets.py backend/mfa/totp.py ./mfa/
COPY --link backend/action/stored_input.py ./action/
COPY --link backend/chat/assets.py backend/chat/assistant_install.py backend/chat/assistant_inventory.py \
    backend/chat/assistant_plan.py backend/chat/assistant_proposal.py backend/chat/assistant_route.py \
    backend/chat/assistant_uninstall.py \
    backend/chat/connection.py backend/chat/executor.py \
    backend/chat/human.py backend/chat/lanes.py backend/chat/lifecycle.py backend/chat/local.py \
    backend/chat/payloads.py \
    backend/chat/projection.py backend/chat/socket.py \
    backend/chat/socket_boundary.py backend/chat/task_resume.py \
    backend/chat/local_catalog.py backend/chat/store_catalog.py ./chat/
COPY --link backend/chat/delivery/challenge.py backend/chat/delivery/plan.py \
    backend/chat/delivery/progress.py backend/chat/delivery/route.py \
    backend/chat/delivery/sync.py backend/chat/delivery/terminal.py \
    backend/chat/delivery/uninstall.py ./chat/delivery/
COPY --link backend/history/context.py backend/history/delivery.py backend/history/http.py backend/history/store.py \
    ./history/
COPY --link backend/integrations/assistants.py backend/integrations/cloudflare.py backend/integrations/handoff.py \
    ./integrations/
COPY --link backend/space/host_reset.py backend/space/release.py backend/space/reset.py backend/space/supervisor_key.py ./space/
COPY --link backend/routine/answer.py backend/routine/delivery.py backend/routine/http.py backend/routine/manage.py backend/routine/scheduler.py \
    backend/routine/team.py ./routine/
COPY --link backend/team/assets.py backend/team/bridge.py backend/team/files.py backend/team/http.py backend/team/inference.py backend/team/names.py \
    backend/team/order.py backend/team/snapshots.py backend/team/summary.py backend/team/transport.py ./team/
COPY --link backend/protocol/http/v1/challenge.py backend/protocol/http/v1/identifiers.py \
    backend/protocol/http/v1/payload.py backend/protocol/http/v1/phrase.py backend/protocol/http/v1/progress.py \
    backend/protocol/http/v1/purpose.py backend/protocol/http/v1/routine.py backend/protocol/http/v1/routine_context.py \
    backend/protocol/http/v1/routine_notice.py backend/protocol/http/v1/routine_proposal.py \
    backend/protocol/http/v1/routine_run.py backend/protocol/http/v1/strict_json.py \
    backend/protocol/http/v1/supervisor.py backend/protocol/http/v1/turn.py backend/protocol/http/v1/websocket.py ./protocol/http/v1/
# UI_DIR in app.py resolves to backend/../frontend/build
COPY --link --from=ui /w/build /app/frontend/build

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SHIMPZ_ADMIN_STORE=/data/admin.json
# Fail during the image build, rather than after publication smoke startup, if the explicit runtime
# copy surface omits a module imported by the Admin application, then compile the application like its environment.
RUN python -c "import app" && \
    python -m compileall -q -f --invalidation-mode checked-hash /app/backend
USER admin
EXPOSE 4600
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "4600", "--workers", "1", "--log-level", "warning", \
     "--no-access-log", "--no-server-header"]
