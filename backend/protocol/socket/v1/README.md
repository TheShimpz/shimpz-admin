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

- `call {id, method, params, background?}` asks for one Admin operation; Admin answers it with exactly one
  `result {id, status, body}`. A read of a topic's state also carries that topic, the process `epoch`, and the
  topic `revision` taken before the read. At most 16 calls are in flight per socket.
- `changed {topic, epoch, revision}` is an invalidation only: the client reads the topic again through `call`.
- The chat channel carries the `shimpz.chat.v7` frames of `.context/SHIMPZ_CHAT_V7.md`, each with the attached Team's
  `team_id`, after `chat.attach {team_id, locale}`.

Topics in this version: `teams`, `team/{id}/history`, `team/{id}/routines`, `space/resources`, `platform/release`,
`security/summary`, and `session`.
