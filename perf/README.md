# Admin changes measured and not adopted

Admin ships a performance change only when a measurement shows its gain. These candidates were measured on
2026-10-09 and left out; the commit that added this note records the numbers. Re-measure before proposing one again.

- **Chat exchanges with `content-visibility: auto`** (`contain-intrinsic-size: auto 12rem`). The history-prepend
  benchmark (`frontend/perf/chat-history-prepend.mjs`) improved, but the transcript no longer kept the reader's
  place: when earlier history arrived, the message at the top moved 5.0 px in Firefox and 5.8 px in WebKit (the
  Playwright bound is 2 px), and 1.2 px instead of 0.1 px in Chromium.
- **The provider-key reset as a writable `$derived`** instead of its `$effect`. It runs once per Team or provider
  change, outside every benchmarked path, and one effect run is far below what the harness can resolve.
- **One thread pool for blocking work.** `run_in_threadpool` costs 70-80 µs per call against 52 µs for
  `asyncio.to_thread`, so moving the 30 `to_thread` calls onto it is slower, and FastAPI runs sync routes on
  AnyIO's pool either way.
- **One long-lived chat history connection.** Opening `chat-history.sqlite3` with its private-file check and four
  pragmas costs about 160 µs per operation (a page read takes about 860 µs). That is a fraction of a millisecond
  per chat turn against turns that last seconds, and a shared connection would drop the per-operation file check
  and outlive a store replaced underneath it.
