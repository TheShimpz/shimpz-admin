# Admin session socket protocol v1

Admin owns `shimpz.admin.v1`, the one WebSocket each authenticated Admin tab opens at `GET /api/session/ws`
(ADR-0114). It is Admin's own protocol: Admin is its only server and its browser the only client, so it lives beside,
never inside, the generated Team mirror in `../../http/v1`.

`frames.py` is both the reference validator and the module Admin runs: the subprotocol, the frame and queue bounds, the
closed method table with each method's exact parameters, the topic grammar, and the closed frame shapes. `vectors.json`
holds the golden frames the backend tests validate and the browser's unit tests replay; the browser's copies of the
bounds are pinned to `frames.py` by `tests/test_frontend_protocol_parity.py`.

Every frame is one UTF-8 JSON object with unique keys in a text frame: a client frame at most 128 KiB, a server frame,
envelope included, at most 1 MiB.

- `call {id, method, params}` asks for one Admin operation; Admin answers it with exactly one
  `result {id, status, body}`. A read of a topic's state also carries that topic, the process `epoch`, and the
  topic `revision` taken before the read. At most 16 calls are in flight per socket. Every parameter is a string of
  at most 128 characters, except `topics` and a request `body`: one JSON object whose compact UTF-8 size keeps the
  operation's own bound (`BODY_BYTES`: a Team name 1 KiB, a Team order or deletion 8 KiB, every other body 16 KiB),
  or the call is answered 413. A status and body are exactly what the operation always answered; an empty answer is
  `{}`.
- `progress {id, state: "running"}` says once that a long call (`LONG_METHODS`, an Assistant install) started; its
  result follows when it ends, or is lost with the socket and never replayed.
- `activity {}` (exactly `{"type": "activity"}`) is the page's report of the person's own input, at most once a minute
  per tab. It is the only frame, and nothing over HTTP, that restarts the session's idle time; Admin ignores one that
  arrives within 30 seconds of the session's last renewal, from any tab, and it never revives an expired session or
  moves its absolute expiry.
- `session {idle_seconds, absolute_seconds}` tells the page, on Admin's clock, how long the session has until it idles
  out and until its absolute expiry: once the socket opens and whenever the session's idle time restarts.
- `changed {topic, epoch, revision}` is an invalidation only: the client reads the topic again through `call`.
- The chat channel carries the `shimpz.chat.v7` frames of `.context/SHIMPZ_CHAT_V7.md`, each with the attached Team's
  `team_id`, after `chat.attach {team_id, locale}`.

Topics in this version: `teams`, `team/{id}/history`, `team/{id}/routines`, `team/{id}/inventory`,
`team/{id}/inference`, `assistants/registry`, `local-assistants`, `space/resources`, `space/models` (model provider
keys), `space/decision` (the decision provider key), `platform/release`,
`security/summary`, and `session`.

`store.catalog {locale, cursor?}` reads the public Store catalog in pages: each page's Assistants fit one result
frame whole, `next` names the following page (or is null on the last), and a catalog that changed between pages is
answered 409 `catalog-changed`, so the client reads it again from the first page.
