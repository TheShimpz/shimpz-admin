# shimpz-admin

The operator control panel: a setup wizard that walks every credential with live validation, plus the keyset and catalog.

## Local model boundary

- Model API keys are stored only in `/data/admin.json` (`0600`) and browser routes expose masked state only.
- Team `/inference` requests contain only `provider` and `model`.
- Browser chat uses the local `shimpz.chat.v3` contract. Its base chat frame contains exactly `message`, `files`, and `assistant_ids`; v3 also carries bounded secret, approval, and account challenge flows. The Assistant scope contains at most 16 unique canonical installed IDs; an empty list means Brain-only and is never expanded to all Assistants. After reading the Team's provider, the Admin resolves its key internally and sends it to the authenticated local controller through the fixed `X-Shimpz-Model-Provider` and `X-Shimpz-Model-Api-Key` headers. The key is never placed in chat JSON, iframe messages, logs, or browser responses.
- A controller without the inference/chat contract returns a clear `503`; the Admin never simulates a successful turn.

---
Part of the **[Shimpz](https://github.com/TheShimpz/shimpz)** stack — a self-hosted, voice-driven autonomous agent.
