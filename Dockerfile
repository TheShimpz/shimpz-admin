# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# check=skip=SecretsUsedInArgOrEnv ; shared GIDs are numeric access boundaries, never credentials
#
# shimpz-admin — the persistent local Team control panel. Runs as a compose service on 127.0.0.1
# only, holds no Docker socket or host configuration mount, and persists only its private `/data`.

# ── stage 1: obtain the exact uv binary without retaining an installer toolchain ──────────────
FROM ghcr.io/astral-sh/uv:0.12.1@sha256:cf4eedcaa81655197f625739489effcbe71b61ceb1506f332c3facae5deceded AS uv
ARG SOURCE_DATE_EPOCH=0

# ── stage 2: build the SvelteKit static UI ────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24-bookworm@sha256:19cd848a0e073d34bd8cd5545a1b6b4d28489b3e3b607366621ced442bd5f6b4 AS ui
ARG SOURCE_DATE_EPOCH=0
# IPv6 egress is broken on the build host (see main Dockerfile) → prefer IPv4 so npm doesn't hang.
RUN echo 'precedence ::ffff:0:0/96 100' >> /etc/gai.conf
WORKDIR /w
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund && rm -rf /root/.npm
COPY frontend/ ./
# adapter-static writes the SPA to /w/build. Normalize the copied artifact tree explicitly: the
# release builder supplies the Git-derived epoch and the final Python stage consumes only this tree.
RUN npm test && npm run build && \
    find /w/build -depth -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + && \
    rm -rf /root/.npm

# ── stage 3: resolve target-platform Python dependencies ───────────────────────────────────────
# This stage deliberately follows TARGETPLATFORM so native wheels match the final image.
FROM python:3.14-slim@sha256:cea0e6040540fb2b965b6e7fb5ffa00871e632eef63719f0ea54bca189ce14a6 AS dependencies
ARG SOURCE_DATE_EPOCH=0
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN UV_PROJECT_ENVIRONMENT=/opt/venv uv sync --frozen --no-install-project --no-dev --python 3.14 && \
    rm -rf /root/.cache/uv

# ── stage 4: minimal Python runtime ─────────────────────────────────────────────────────────────
# The digest-pinned Python base already retains CA roots; build-only uv never enters this stage.
FROM python:3.14-slim@sha256:cea0e6040540fb2b965b6e7fb5ffa00871e632eef63719f0ea54bca189ce14a6 AS runtime
ARG SOURCE_DATE_EPOCH=0
COPY --from=dependencies /opt/venv /opt/venv

# Runs as the host repo owner (uid 1000) for the existing Admin data-volume ownership contract.
RUN groupadd -g 1000 admin && \
    groupadd -g 10021 shimpzsupervisor-key && \
    useradd -u 1000 -g 1000 -G 10021 -M -s /usr/sbin/nologin admin

WORKDIR /app/backend
COPY backend/app.py backend/auth.py backend/models.py backend/model_catalog.json backend/notifications.py \
    backend/state.py backend/supervisor.py ./
COPY backend/chat/local.py backend/chat/payloads.py backend/chat/socket.py ./chat/
COPY backend/integrations/account.py backend/integrations/assistants.py backend/integrations/handoff.py ./integrations/
COPY backend/team/bridge.py backend/team/transport.py ./team/
COPY backend/protocol/http/v1/payload.py backend/protocol/http/v1/progress.py backend/protocol/http/v1/supervisor.py \
    backend/protocol/http/v1/websocket.py ./protocol/http/v1/
# UI_DIR in app.py resolves to backend/../frontend/build
COPY --from=ui /w/build /app/frontend/build

# /data → named volume (admin.json 0600); the public verifier volume contains no private key.
RUN mkdir -p /data /run/shimpz-local-supervisor && \
    chown 1000:1000 /data && \
    chown root:shimpzsupervisor-key /run/shimpz-local-supervisor && \
    chmod 2770 /run/shimpz-local-supervisor
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SHIMPZ_ADMIN_STORE=/data/admin.json \
    SHIMPZ_NOTIFICATION_STORE=/data/notifications.json
# Fail during the image build, rather than after publication smoke startup, if the explicit runtime
# copy surface omits a module imported by the Admin application.
RUN SHIMPZ_ADMIN_PROFILE=local python -c "import app"
USER admin
EXPOSE 4600
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "4600", "--log-level", "warning"]
