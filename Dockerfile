# syntax=docker/dockerfile:1
#
# shimpz-admin — the persistent admin panel (config keyset editor + login). Runs as a compose service
# on 127.0.0.1 only. Holds NO docker.sock and NO master secrets beyond the `.env` it edits: it
# cannot boot or recreate anything (that is shimpz-driver's job). Strictly less powerful than the
# old host-side wizard (no host shell, no docker group, no home dir) — only the repo `.env` (bind-
# mounted as a single file) and its own `/data` volume (admin.json, 0600).

# ── stage 1: build the SvelteKit static UI ────────────────────────────────────────────────────
FROM node:22-bookworm AS ui
# IPv6 egress is broken on the build host (see main Dockerfile) → prefer IPv4 so npm doesn't hang.
RUN echo 'precedence ::ffff:0:0/96 100' >> /etc/gai.conf
WORKDIR /w
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build   # → /w/build (adapter-static SPA)

# ── stage 2: python runtime ───────────────────────────────────────────────────────────────────
# Same pinned digest as drivers/apps/Dockerfile (python:3.14-slim, pull-verified there); bump
# both together. Repo standard is CPython 3.14 everywhere our code runs.
FROM python:3.14-slim@sha256:b877e50bd90de10af8d82c57a022fc2e0dc731c5320d762a27986facfc3355c1

ARG UV_VERSION=0.11.25
# Same version AND sha256 as the main + driver Dockerfiles (astral serves an immutable
# versioned artifact). Bump all together.
ARG UV_INSTALL_SHA256=ca2de1bca2913ba30ce88658b6d90a663c627ecac378803aa58084a9adb35a46

# Downloaded to a file and hash-checked BEFORE execution — never `curl | sh` (supply-chain).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    echo 'precedence ::ffff:0:0/96 100' >> /etc/gai.conf && \
    curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" -o /tmp/uv-install.sh && \
    echo "${UV_INSTALL_SHA256}  /tmp/uv-install.sh" | sha256sum -c - && \
    env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh /tmp/uv-install.sh && \
    rm -f /tmp/uv-install.sh && apt-get clean && rm -rf /var/lib/apt/lists/*

# Runs as the host repo owner (uid 1000) so it can write the bind-mounted `.env` and its /data volume.
RUN groupadd -g 1000 admin && useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin admin

# So uid 1000 can READ shimpz-driver's bearer token (mounted :ro in compose), which is 0440 owned
# by group `shimpzdriver-token`. The GID MUST equal drivers/apps/Dockerfile's SHIMPZ_DRIVER_TOKEN_GID
# (10002) — a wrong GID makes every Phase-C2 recreate call fail at "read the token". (Phase C2.)
ARG SHIMPZ_DRIVER_TOKEN_GID=10002
RUN groupadd -g "${SHIMPZ_DRIVER_TOKEN_GID}" shimpzdriver-token && usermod -aG shimpzdriver-token admin

# Pinned EXACT (uv resolves the [standard] extras + transitive deps deterministically). Bump
# deliberately. These are the versions uv resolved for `fastapi>=0.115` / `uvicorn[standard]>=0.30`.
RUN uv venv /opt/venv && \
    uv pip install --python /opt/venv/bin/python --no-cache-dir 'fastapi==0.139.0' 'uvicorn[standard]==0.51.0'

WORKDIR /app/backend
COPY backend/app.py backend/adminstore.py backend/auth.py backend/brainlogin.py backend/capsules.py backend/catalog.py backend/envfile.py \
     backend/integrations.py backend/keyset.py backend/validate_live.py ./
# UI_DIR in app.py resolves to backend/../frontend/build
COPY --from=ui /w/build /app/frontend/build

# /data → named volume (admin.json 0600); /repo → mountpoint for the single-file `.env` bind.
RUN mkdir -p /data /repo && chown 1000:1000 /data /repo
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SHIMPZ_REPO=/repo \
    SHIMPZ_ADMIN_STORE=/data/admin.json
USER 1000:1000
EXPOSE 4600
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "4600", "--log-level", "warning"]
