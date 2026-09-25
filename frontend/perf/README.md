# Local chat progress measurement

Build `frontend/` with Node.js 24, then run the built Local chat benchmark from
that directory. It alternates fresh Chromium contexts with and without the
selected synthetic WebSocket progress frames at the configured interval, and
checks the live ledger's final row, final announcement, terminal reply, and
completed receipt. The commands below use 128 events separated by 25 ms.
The measured runs used Playwright 1.62.0 at the digest below, 2 CPUs, 2 GiB,
512 MiB shared memory, and no container network. Install dependencies first
with network access, then build and measure offline. From `admin/frontend/`,
reproduce that environment with:

```sh
export CHAT_PERF_USER="$(id -u):$(id -g)" CHAT_PERF_DIR="$PWD"
export CHAT_PERF_IMAGE='mcr.microsoft.com/playwright@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07'
sg docker -c 'docker run --rm --cpus 2 --memory 2g --user "$CHAT_PERF_USER" -v "$CHAT_PERF_DIR":/work -w /work -e npm_config_cache=/tmp/npm-cache "$CHAT_PERF_IMAGE" npm ci'
sg docker -c 'docker run --rm --network none --cpus 2 --memory 2g --shm-size 512m --user "$CHAT_PERF_USER" -v "$CHAT_PERF_DIR":/work -w /work -e npm_config_cache=/tmp/npm-cache "$CHAT_PERF_IMAGE" npm run build'
sg docker -c 'docker run --rm --network none --cpus 2 --memory 2g --shm-size 512m --user "$CHAT_PERF_USER" -v "$CHAT_PERF_DIR":/work -w /work -e SHIMPZ_PROGRESS_CASES=128 -e SHIMPZ_PROGRESS_GAP_MS=25 -e SHIMPZ_PERF_SAMPLES=15 -e SHIMPZ_PERF_MOTION=reduce "$CHAT_PERF_IMAGE" node perf/chat-progress.mjs'
sg docker -c 'docker run --rm --network none --cpus 2 --memory 2g --shm-size 512m --user "$CHAT_PERF_USER" -v "$CHAT_PERF_DIR":/work -w /work -e SHIMPZ_PROGRESS_CASES=128 -e SHIMPZ_PROGRESS_GAP_MS=25 -e SHIMPZ_PERF_SAMPLES=15 -e SHIMPZ_PERF_MOTION=no-preference "$CHAT_PERF_IMAGE" node perf/chat-progress.mjs'
```

The JSON output reports p50 and nearest-rank p95 for Chromium main-thread
task, script, style, layout, other-task, compile, and DevTools-command time,
plus raw per-trial values and layout/style counts. Each arm's raw trials are
in trial order; matching array indices form one alternating control and
progress pair. With fewer than 20 samples, p95 is the maximum observation.
Chromium's `third_party/blink/renderer/core/inspector/inspector_performance_agent.cc`
defines `TaskOtherDuration` as the residual:
`TaskDuration = ScriptDuration + V8CompileDuration + RecalcStyleDuration +
LayoutDuration + DevToolsCommandDuration + TaskOtherDuration`. The benchmark
checks this identity within 0.05 ms per trial and fails on missing or
inconsistent metrics.
`DevToolsCommandDuration` is harness overhead, not application work.
`ProcessTime` is CPU use by the whole renderer process, including other
threads, and is coarser than main-thread task time. It is useful for
direction, not per-event attribution. `TaskOtherDuration` does not identify
paint work specifically. The fixture excludes real Team, provider, and
network timing, so its result does not measure complete chat latency.

Set `SHIMPZ_PROGRESS_CASES=10` for the ordinary turn with no Actions: Admin
preparation, initial Team context, model, final Team context, and Admin reply
validation each emit one started/finished pair. The 36, 128, and 948-event
cases exercise Action rounds. Each case retains the same final ledger,
announcement, and receipt checks.

`acknowledgeFrameP50Ms` and `acknowledgeFrameP95Ms` time a Send click to the
first animation-frame callback that sees the processing group in the DOM.
The benchmark fails if one trial exceeds 250 ms. This is the browser's local
optimistic state, not a server acknowledgment or a completed paint. The
interval includes composer checks, frame construction, Svelte updates, and
the fixture WebSocket's synchronous JSON parse; it excludes a real socket
write and all remote response time. `firstEventFrameP50Ms` and
`firstEventFrameP95Ms` time the first synthetic progress dispatch to the
first animation-frame callback after the processing step text changes.
The observer watches only that processing step. Both frame marks precede
paint and are lower bounds on when the updates could become visible.
The first-event metric is attempted only with a gap of at least 16 ms and
is accepted only if its frame occurs before the second event dispatch.
`firstEventSamples` and `firstEventSkipped` expose that selection; a skipped
sample can indicate a delayed frame and must not be interpreted as a fast
sample. A retained frame time above the configured gap means the second
dispatch also occurred later than requested; this probe cannot identify why.
At smaller gaps and in the no-progress control arm, the first-event
metric is `null`. These browser-only intervals overlap backend work and
must not be added to Admin or Team timing figures.

## Local Assistants page measurement

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
