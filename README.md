# shimpz-admin

The operator control panel: a setup wizard that walks every credential with live validation, plus the keyset and catalog.

## Local model boundary

- Model API keys are stored only in `/data/admin.json` (`0600`) and browser routes expose masked state only.
- Team `/inference` requests contain only `provider` and `model`.
- Browser chat JSON contains only `assistant`, `message`, and optional `files`. After reading the Team's provider, the Admin resolves its key internally and sends it to the authenticated local controller through the fixed `X-Shimpz-Model-Provider` and `X-Shimpz-Model-Api-Key` headers. The key is never placed in chat JSON, iframe messages, logs, or browser responses.
- A controller without the inference/chat contract returns a clear `503`; the Admin never simulates a successful turn.

---
Part of the **[Shimpz](https://github.com/roxygens/shimpz)** stack — a self-hosted, voice-driven autonomous agent.
