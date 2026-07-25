# Shimpz Admin

Shimpz Admin is the loopback-only operator console installed with a local Shimpz Team. Its SvelteKit
frontend and FastAPI backend provide password/session authentication, Team lifecycle, Assistant
install/uninstall and help, provider/model selection, Team files, local chat, and OAuth Account
connection management.

Admin has no Docker socket. It calls the local Team controller over a private authenticated network
using a file-backed bearer mounted read-only. The controller remains authoritative for Team ownership,
workload identity, Power execution, storage, Account encryption, and Brain turns.

## Credential and chat boundary

- Admin password/session state and model-provider API keys live only in `/data/admin.json`, mode `0600`.
  Browser responses expose masked credential state, never stored values.
- Team inference configuration contains only the canonical `provider` and `model` selection.
- Browser chat uses `shimpz.chat.v3`: strict `chat`, `stop`, and `sync` client frames plus the bounded
  `accounts-required` OAuth gate. An empty Assistant selection is Brain-only and never expands.
- For a turn or challenge resume, Admin resolves the selected model key internally and sends it only
  through the controller's fixed `X-Shimpz-Model-Provider` and `X-Shimpz-Model-Api-Key` headers. The key
  is absent from browser JSON, iframe messages, logs, audit records, and responses.
- OAuth authorization uses a loopback callback, PKCE, session binding, and the audited broker. Access
  and refresh tokens are stored encrypted by the controller and never cross chat frames.

The production image runs as a non-root user with a read-only root filesystem and publishes only the
configured loopback port. Backend, frontend, container, and browser contracts live under `tests/` and
the umbrella repository's `tests/ui/` suite.
