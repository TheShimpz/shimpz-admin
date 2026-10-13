# Local chat progress measurement

Build `frontend/` with Node.js 26, then run the built Local chat benchmark from
that directory. It alternates fresh Chromium contexts with and without the
selected synthetic progress frames at the configured interval, and
checks the live ledger's final row, final announcement, terminal reply, and
completed receipt. The page's session socket (`perf/sessionSocket.js`) runs in
the page: chat frames are dispatched there synchronously, and the driver answers
each read the page makes. The commands below use 128 events separated by 25 ms.
Run it in the image `playwright.Dockerfile` builds (Playwright 1.62.0 on Node.js 26), 2 CPUs, 2 GiB,
512 MiB shared memory, and no container network. Install dependencies first
with network access, then build and measure offline. From `admin/frontend/`,
reproduce that environment with:

```sh
export CHAT_PERF_USER="$(id -u):$(id -g)" CHAT_PERF_DIR="$PWD"
export CHAT_PERF_IMAGE="$(sg docker -c 'docker build --quiet - < playwright.Dockerfile')"
sg docker -c 'docker run --rm --cpus 2 --memory 2g --user "$CHAT_PERF_USER" -v "$CHAT_PERF_DIR":/work -w /work -e HOME=/tmp "$CHAT_PERF_IMAGE" sh -ceu "sh bootstrap-pnpm.sh /tmp/pnpm-cache /tmp/pnpm; /tmp/pnpm/bin/pnpm install --frozen-lockfile"'
sg docker -c 'docker run --rm --network none --cpus 2 --memory 2g --shm-size 512m --user "$CHAT_PERF_USER" -v "$CHAT_PERF_DIR":/work -w /work -e HOME=/tmp "$CHAT_PERF_IMAGE" node_modules/.bin/vite build'
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
the in-page session socket's synchronous JSON parse; it excludes a real socket
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

From the Admin repository, install `frontend/` dependencies with Node.js 26 (`(cd frontend && sh bootstrap-pnpm.sh /tmp/pnpm-cache /tmp/pnpm && /tmp/pnpm/bin/pnpm install --frozen-lockfile)`), then build the
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
2 CPUs/512 MiB and Chromium at 2 CPUs/2 GiB. It builds `frontend/playwright.Dockerfile` (Playwright 1.62.0 on Node.js 26), runs that image by ID, and uses a fresh, labeled Admin
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

For a static UI-only run, build `frontend/` with Node.js 26 and run `node perf/assistant-catalog.mjs` there without
`SHIMPZ_PERF_ISOLATED_AUTH`. That mode uses a mocked session and the Vite preview server.

`SHIMPZ_PERF_SCENARIO=navigation` (static mode only) measures a same-tab visit instead of a load: each sample opens the
chat in a fresh context, waits until the page has sent nothing for a second (so what it reads at idle after boot is
in), clicks the sidebar's Store link, and times on the page's clock the click to the first animation frame in which
every row shows its decoded icon (`firstVisit`); it then returns to the chat and times a second visit (`repeatVisit`).
A frame callback precedes paint, so both are lower bounds on the visible time. Each return to the chat (`chatReturn`
after the first visit, `chatRepeatReturn` after the second) is timed from the click on the Team's link to the first
frame in which the conversation shows every exchange of its 24-row history outside any loading state (`shown`), and to
the first in which its composer also takes text (`ready`, after the chat channel attached and synchronized).
`SHIMPZ_PERF_CONTROL_DELAY_MS` delays the socket's own subscriptions and chat attach, which answer at once by default.
`iconsBeforeVisit` counts the icon requests made before the first click. `SHIMPZ_PERF_ICON_PX=1024` serves icons at the published 1024-pixel size (the
default is one pixel), so decoding costs what it does for real icons:

```sh
sg docker -c 'docker run --rm --network none --cpus 2 --memory 2g --shm-size 512m --user "$CHAT_PERF_USER" -v "$CHAT_PERF_DIR":/work -w /work -e HOME=/tmp -e SHIMPZ_PERF_SCENARIO=navigation -e SHIMPZ_PERF_SAMPLES=15 -e SHIMPZ_PERF_COUNTS=8,24 -e SHIMPZ_PERF_ICON_PX=1024 "$CHAT_PERF_IMAGE" node perf/assistant-catalog.mjs'
```

## Admin screens measurement

`screens.mjs` measures the main screens of the built UI the way `first-load.mjs` serves it: `e2e/serveBuild.mjs` on
port 4173 with Admin's enforced policy and no compression, and the shared e2e scenarios answering every API call and
the session socket. Team, Brain, and provider timing are excluded. Every sample is a fresh browser context (1440×1000, en-US), and
each measurement prints one JSON line with p50 and nearest-rank p95 over `SHIMPZ_PERF_SAMPLES` samples (default 5).
`SHIMPZ_PERF_PARTS` selects a comma-separated subset of its six parts:

- `loads`: a cold load of sign-in, an empty chat, a chat with 64 history entries, the Assistants catalog, an
  Assistant page, and the Routines scenario's chat. It reports the time to the screen's key element (`readyMs`),
  FCP, LCP, long tasks (count, total, longest), blocking time over 50 ms per long task after FCP (`tbtMs`), Chromium
  main-thread task time, DOM elements, and the script files and their bytes the load fetched (`scriptFiles`,
  `scriptBytes`; served uncompressed, so transferred and parsed bytes are equal), all read after a 1.2 s settle
  window. `apiCounts` is the median count of
  each `METHOD /path` the load made and each session socket frame (`SOCKET method` for a call, `SOCKET type` for a chat
  frame), and `unanswered` lists the calls the scenario does not answer (it fails them closed with 503).
- `team-switch`: five sidebar switches between the `ready` scenario's Teams, from the click to the next Team's
  composer, with the task time, layouts, and API calls until the switch settles. `apiCountsAway` and `apiCountsBack`
  are the calls of the first switch away from Marketing and the switch back.
- `idle`: an open chat with Routines (the `routine-lifecycle` scenario) left alone for one minute of the page's own
  clock, after its load settled: every HTTP request and session socket frame it sends (`apiCalls`, `apiCounts`).
- `freshness`: Admin writes a Routine notice into the Team's history and raises `team/{id}/history` on the session
  socket; the time from that change to the row on screen, as the page records it (`freshnessMs`). Admin's own
  latency to learn of the change (the RoutineScheduler's write) is excluded.
- `typing`: 73 keys typed into the composer 30 ms apart on an empty chat and on transcripts of 64 and 256 entries.
  It reports each key's input-to-next-animation-frame latency, pooled over the samples, and the task, script, style,
  and layout time per key.
- `scroll`: 60 wheel steps of 240 px down a 64- and a 256-entry transcript, from its oldest entry. Frame time is the
  interval between animation-frame callbacks, pooled over the samples, with the count above 50 ms, the wall time, and
  main-thread task and layout time.

Chromium runs headless with software compositing in this container, so frame times are worst-case absolutes; compare
them only with runs in the same environment. An animation-frame callback precedes paint, so its timings are lower
bounds on when an update could become visible.

## All offline benchmarks in one run

With the image and dependencies from the first section (`CHAT_PERF_USER`, `CHAT_PERF_DIR`, `CHAT_PERF_IMAGE`), this
builds `frontend/` and runs every benchmark that needs no Admin, Team, or provider: `first-load.mjs`,
`chat-progress.mjs`, `chat-history-prepend.mjs`, `assistant-catalog.mjs` in its static UI-only mode, and
`screens.mjs`, five samples each. Each script's JSON lines go to `<script>.jsonl` in `CHAT_PERF_OUT`, and the run
stops at the first failing script. `local-provider-turn.mjs` and the isolated `isolated_admin.py` run are separate.

```sh
export CHAT_PERF_OUT="$(mktemp -d)"
sg docker -c 'docker run --rm --network none --cpus 2 --memory 2g --shm-size 512m --user "$CHAT_PERF_USER" -v "$CHAT_PERF_DIR":/work -v "$CHAT_PERF_OUT":/out -w /work -e HOME=/tmp -e SHIMPZ_PERF_SAMPLES=5 -e SHIMPZ_PROGRESS_CASES=10,36,128 -e SHIMPZ_PROGRESS_GAP_MS=25 "$CHAT_PERF_IMAGE" sh -ceu "node_modules/.bin/vite build > /dev/null; for script in first-load chat-progress chat-history-prepend assistant-catalog screens; do node perf/\$script.mjs > /out/\$script.jsonl; done"'
```
