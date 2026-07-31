# Admin repository rules

## Authority

- This repository owns the Supervisor console and private Admin API used by Local and Hosted Space profiles.
- It does not own Team lifecycle, Account identity, Assistant publication, Brain execution, or provider tokens held
  by their custodians. Admin is a client of those authorities.
- Read the canonical [Shimpz architecture](https://github.com/TheShimpz/shimpz/blob/main/.context/ARCHITECTURE.md)
  before changing product vocabulary, cross-domain authority, protocols, runtime topology, or source placement.

## Delivery and engineering

- Deliver the smallest useful microtask, validate it, commit it with a clear English conventional message, and
  push it immediately.
- When working through the umbrella checkout, commit and push this repository before committing its umbrella
  gitlink.
- Shimpz is pre-production. Change the current contract directly; do not add aliases, dual schemas, fallback
  parsers, or migrations for retired repository state.
- Preserve attributable Supervisor authority, Team isolation, least privilege, fail-closed validation, and secret
  redaction. Admin never receives a Docker socket or persists Team-owned Integration tokens.
- Use Python 3.14 and Node.js 24. User-visible Svelte behavior requires Playwright against the built application.
- Tests that support workers use half of local processors and all GitHub Actions runner processors. Do not add
  Cypress or an experimental component-test runner.

## Validation

- This standalone repository has no Ruff authority. Before committing Python, run
  `ruff check --config ruff.toml admin` from the umbrella root.
- Run focused backend tests with
  `uv run --frozen --python 3.14 python -m unittest discover -s tests`.
- Run frontend checks from `frontend/` with `npm test`, `npm run check`, and `npm run build` as applicable.
