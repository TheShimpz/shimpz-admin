# Local Assistants page measurement

From the Admin repository, install `frontend/` dependencies with Node.js 24 (`(cd frontend && npm ci)`), then build the
current image and run the isolated entrypoint:

```sh
docker buildx build --load --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  -t shimpz-admin:perf .
SHIMPZ_PERF_SAMPLES=15 SHIMPZ_PERF_COUNTS=1,24 \
  python3 frontend/perf/isolated_admin.py > /tmp/assistants-fast.jsonl
SHIMPZ_PERF_SAMPLES=15 SHIMPZ_PERF_COUNTS=24 SHIMPZ_PERF_SNAPSHOT_DELAY_MS=2400 \
  python3 frontend/perf/isolated_admin.py > /tmp/assistants-slow.jsonl
```

Use a CPU/memory-limited builder when the host requires one; this host used `--builder shimpz-limited`. If the current
shell lacks its account's Docker group, run each Docker command through `sg docker -c '...'`.
Set `SHIMPZ_PERF_ADMIN_CPUSET` to match the Local Admin CPU set when it has one. The entrypoint fixes Admin at
2 CPUs/512 MiB and Chromium at 2 CPUs/2 GiB. It uses Node.js 24 from Playwright 1.62.0 and a fresh, labeled Admin
volume. Admin has no external network or published port; Chromium shares only its loopback namespace. The entrypoint
checks ownership before cleanup, stops the disposable container, removes its volume, and reports any residue.

The benchmark completes real Local Supervisor password and TOTP setup in memory. The per-sample `/api/session` call
reaches that Admin, while Team, catalog, snapshots, and icons have deterministic mocked responses. `cold` means a
new browser context; `warm` means reload in the same context. The JSON lines report presentation marks, API phase
timings, request counts, browser task time, errors, and p50/p95. The environment line records exact image IDs, the
source revision label, checkout revision and dirty state, Node/Docker versions, and resource limits. With 15 samples,
nearest-rank p95 is the maximum observation. The 2400 ms arm probes the browser's response to a
slow snapshot API; it does not measure a real Team, Docker inventory, provider, or install. Neither arm writes
credentials or session state to the result file. On failure, the entrypoint drops browser stderr to avoid retaining
credential-bearing diagnostics; it reports the failed run and owned cleanup state.

For a static UI-only run, build `frontend/` with Node.js 24 and run `node perf/assistant-catalog.mjs` there without
`SHIMPZ_PERF_ISOLATED_AUTH`. That mode uses a mocked session and the Vite preview server.
