# Shimpz Admin

Shimpz Admin is the loopback-only Supervisor console for Local and Hosted Shimpz Space profiles. Its SvelteKit
frontend and FastAPI backend provide password/session authentication, Team lifecycle, Assistant
install/uninstall, provider/model selection, local chat, and OAuth Integration connection management.
The backend also exposes the private Team files API.

Admin has no Docker socket. It calls the Team controller over a private authenticated network
using a file-backed bearer mounted read-only. The controller remains authoritative for Team ownership,
workload identity, Action execution, storage, Integration encryption, and Brain turns.

## Credential and chat boundary

- Admin password/session state and model-provider API keys live only in `/data/admin.json`, mode `0600`.
  Browser responses expose masked credential state, never stored values.
- Team inference configuration contains only the canonical `provider` and `model` selection.
- Browser chat uses `shimpz.chat.v7`: strict `chat`, `stop`, `sync`, and `human-response` client frames plus
  bounded automatic Assistant install plans and Integration and Action human gates. An admitted plan can widen
  only its original task's Assistant scope after Team proves every planned Assistant running.
- For a turn or challenge resume, Admin resolves the selected model key internally and sends it only
  through the controller's fixed `X-Shimpz-Model-Provider` and `X-Shimpz-Model-Api-Key` headers. The key
  is absent from browser JSON, iframe messages, logs, audit records, and responses.
- OAuth authorization uses request-scoped callback selection (loopback, hosted, or out-of-band completion code),
  PKCE, session binding, and the audited broker. Access and refresh tokens are stored encrypted by the controller
  and never cross chat frames.

The production image runs as a non-root user with a read-only root filesystem and publishes only the
configured loopback port. Backend, frontend, container, and browser contracts live under `tests/` and
the umbrella repository's `.tests/ui/` suite.
