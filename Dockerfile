# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# shimpz-admin — the persistent local Team control panel. Runs as a compose service on 127.0.0.1 only, holds no Docker
# socket or host configuration mount, and persists only its private `/data`. One Rust binary serves the compiled
# SvelteKit UI, the Admin API, and its WebSockets (ADR-0123 R6).

# ── the SvelteKit static UI ──────────────────────────────────────────────────────────────────────
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
# Normalize the copied artifact tree explicitly: the release builder supplies the Git-derived epoch and the runtime
# consumes only this tree and the revision file beside it.
ARG SOURCE_DATE_EPOCH=0
# The commit the sidebar's Admin version names (frontend/src/lib/space/version.js); an image always names one. The
# build validates it, and the backend gets the same commit and its commit time from /w/revision, outside the served
# tree, so its session socket can tell a page built from another commit that it is stale and name the new version.
ARG SOURCE_REVISION
RUN test -n "$SOURCE_REVISION" && \
    pnpm build && \
    printf '%s %s\n' "$SOURCE_REVISION" "$SOURCE_DATE_EPOCH" > /w/revision && \
    find /w/build /w/revision -depth -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

# ── the Rust Admin ──────────────────────────────────────────────────────────────────────────────
# The packages as the dependency build sees them: every manifest and lockfile, and a stub in place of each library and
# binary root, so a source edit leaves the dependency layer unchanged.
FROM docker.io/library/rust:1.99.0-trixie@sha256:6ff07edce8775d0f64be7aba9197229407301bddf2054d62c27b541a6238a181 AS rust-skeleton
WORKDIR /workspace
COPY backend/Cargo.toml backend/Cargo.lock ./backend/
COPY backend/src ./backend/src
COPY vendor/strict-json ./vendor/strict-json
COPY vendor/webauthn ./vendor/webauthn
COPY protocol/team/http ./protocol/team/http
RUN find . -type f -regextype posix-extended \
        ! -regex '.*/(Cargo\.toml|Cargo\.lock)' ! -regex '.*/src/(lib|main)\.rs' -delete \
    && find . -depth -type d -empty -delete \
    && for root in $(find . -path '*/src/lib.rs' -o -path '*/src/main.rs'); do \
        printf '//! Dependency stub.\n' > "${root}"; \
        if test "${root##*/}" = main.rs; then printf 'fn main() {}\n' >> "${root}"; fi; \
    done

# The builder's Debian 13 (trixie) glibc matches the distroless cc-debian13 runtime the binary runs on. Every
# dependency is compiled here with the release profile, pinned by backend/Cargo.lock; the stub packages' artifacts are
# then removed, so the real sources always compile.
FROM docker.io/library/rust:1.99.0-trixie@sha256:6ff07edce8775d0f64be7aba9197229407301bddf2054d62c27b541a6238a181 AS rust-dependencies
WORKDIR /workspace
COPY --from=rust-skeleton /workspace ./
RUN cd backend \
    && cargo build --release --locked --bin shimpz-admin \
    && cargo clean --release --locked --package admin-backend --package strict-json --package team-protocol \
       --package account-webauthn

FROM rust-dependencies AS rust-build
COPY backend/Cargo.toml backend/Cargo.lock ./backend/
COPY backend/src ./backend/src
COPY backend/model_catalog.json ./backend/
COPY backend/blocklist.txt ./backend/
COPY vendor/strict-json ./vendor/strict-json
COPY vendor/webauthn ./vendor/webauthn
COPY protocol/team/http ./protocol/team/http
ARG SOURCE_DATE_EPOCH=0
RUN cd backend && cargo build --release --locked --bin shimpz-admin

# The volume mount points, each with the owner and mode a fresh named volume inherits: `/data` and the two CLI
# projections belong to Admin (1000:1000), and the Supervisor key directory to root and the key group (10021), setgid
# so every key file there stays in that group.
FROM docker.io/library/rust:1.99.0-trixie@sha256:6ff07edce8775d0f64be7aba9197229407301bddf2054d62c27b541a6238a181 AS mounts
RUN mkdir -p /mounts/data /mounts/run/shimpz-local-release /mounts/run/shimpz-local-reset \
        /mounts/run/shimpz-local-supervisor \
    && chown 1000:1000 /mounts/data /mounts/run/shimpz-local-release /mounts/run/shimpz-local-reset \
    && chown 0:10021 /mounts/run/shimpz-local-supervisor \
    && chmod 0755 /mounts/run /mounts/data /mounts/run/shimpz-local-release /mounts/run/shimpz-local-reset \
    && chmod 2770 /mounts/run/shimpz-local-supervisor

# One root-owned binary and the root-owned UI; the runtime identity (uid 1000, the host repo owner, for the existing
# data-volume ownership) can modify neither, and the root filesystem is read-only anyway. The healthcheck and the CLI's
# helpers are subcommands of the same binary, so the image needs no shell or interpreter.
FROM gcr.io/distroless/cc-debian13@sha256:ed7c407fd64eb0af9dddb9456b94cee188a40a7f53cf38c9836e1e9ae14fca02 AS runtime
# The tree is copied from its root so each mount point keeps its owner and mode, the setgid bit included.
COPY --link --from=mounts /mounts/ /
COPY --link --from=rust-build --chmod=0555 /workspace/backend/target/release/shimpz-admin /usr/local/bin/shimpz-admin
COPY --link --from=ui /w/build /app/frontend/build
COPY --link --from=ui /w/revision /app/revision
USER 1000:1000
EXPOSE 4600
ENTRYPOINT ["/usr/local/bin/shimpz-admin"]
CMD ["serve"]
