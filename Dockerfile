# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# check=skip=SecretsUsedInArgOrEnv ; SHIMPZ_DRIVER_TOKEN_GID is a numeric group id, never a credential
#
# shimpz-admin — the persistent local Team control panel. Runs as a compose service on 127.0.0.1
# only, holds no Docker socket or host configuration mount, and persists only its private `/data`.

# ── stage 1: obtain the exact uv binary without retaining an installer toolchain ──────────────
FROM ghcr.io/astral-sh/uv:0.11.25@sha256:1e3808aa9023d0980e7c15b1fa7c1ac16ff35925780cf5c459858b2d693f01a9 AS uv
ARG SOURCE_DATE_EPOCH=0

# ── stage 2: build the SvelteKit static UI ────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 AS ui
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
FROM python:3.14-slim@sha256:b877e50bd90de10af8d82c57a022fc2e0dc731c5320d762a27986facfc3355c1 AS dependencies
ARG SOURCE_DATE_EPOCH=0
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN UV_PROJECT_ENVIRONMENT=/opt/venv uv sync --frozen --no-install-project --no-dev --python 3.14 && \
    rm -rf /root/.cache/uv

# ── stage 4: minimal Python runtime ─────────────────────────────────────────────────────────────
# The digest-pinned Python base already retains CA roots; build-only uv never enters this stage.
FROM python:3.14-slim@sha256:b877e50bd90de10af8d82c57a022fc2e0dc731c5320d762a27986facfc3355c1 AS runtime
ARG SOURCE_DATE_EPOCH=0
COPY --from=dependencies /opt/venv /opt/venv

# Runs as the host repo owner (uid 1000) for the existing Admin data-volume ownership contract.
RUN groupadd -g 1000 admin && useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin admin

WORKDIR /app/backend
COPY backend/accounts_oauth.py backend/app.py backend/adminstore.py backend/auth.py backend/teams.py backend/team_driver_contract.py \
     backend/chat_payloads.py backend/chat_ws.py backend/chat_ws_common.py backend/driver_client.py \
     backend/localchat.py backend/modelproviders.py backend/model_catalog.json backend/notifications.py backend/oauth_handoff.py \
     ./
# UI_DIR in app.py resolves to backend/../frontend/build
COPY --from=ui /w/build /app/frontend/build

# /data → named volume (admin.json 0600).
RUN mkdir -p /data && chown 1000:1000 /data
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SHIMPZ_ADMIN_STORE=/data/admin.json \
    SHIMPZ_NOTIFICATION_STORE=/data/notifications.json
# Fail during the image build, rather than after publication smoke startup, if the explicit runtime
# copy surface omits a module imported by the Admin application.
RUN python -c "import app"
USER 1000:1000
EXPOSE 4600
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "4600", "--log-level", "warning"]
