// The closed Admin answers both built-chat measurements (chat-progress.mjs, chat-history-prepend.mjs) give the page,
// shaped like e2e/scenarios.js: the session socket's reads by method, and the session bootstrap over HTTP. A
// measurement answers its own history pages; anything else is recorded as unexpected and fails the trial.
import catalog from '../src/lib/brain/catalog.json' with { type: 'json' };
import { authenticatedLocalSession } from '../e2e/scenarios.js';

export const team = { team_id: 'perf_team', team_name: 'Performance Team', status: 'running' };
const provider = catalog.providers.find((item) => item.id === catalog.default_provider);
const models = catalog.providers.map((item) => ({
  id: item.id, title: item.title, default_model: item.default_model,
  models: item.models, configured: item.id === provider.id, masked: null,
}));

export const reads = Object.freeze({
  'teams.list': () => ({ teams: [team] }),
  'routines.list': () => ({ team_id: team.team_id, routines: [], runs: [], incidents: [] }),
  'security.summary': () => ({
    failed_second_factor_attempts: 0, recovery_codes_remaining: 10,
    sign_in_history: { previous: { at: '2026-09-23T00:00:00Z', origin: 'http://127.0.0.1:7777' }, failures_since: 0 },
  }),
  'platform.release': () => ({
    release: 'ghcr.io/theshimpz/shimpz-local-release@sha256:' + 'd'.repeat(64),
    ordinal: 1, checked_at: '2026-09-23T00:00:00Z', outcome: 'current',
  }),
  'assistants.registry': () => ({ assistants: [] }),
  'models.list': () => ({ providers: models }),
  'decision.read': () => ({ provider: 'typesafe', configured: false, masked: null }),
  'store.catalog': () => ({ version: 1, locale: 'en', assistants: [], next: null }),
  'snapshots.list': () => ({ assistants: [], trace_id: 'c'.repeat(32) }),
  'assistants.list': () => ({ assistants: [] }),
  'integrations.list': () => ({ integrations: [] }),
  'stored_inputs.list': () => ({ stored_inputs: [] }),
  'inference.read': () => ({ team_id: team.team_id, provider: provider.id, model: provider.default_model }),
});

/** Answers the session bootstrap for a signed-in Supervisor and records any other request in `unexpected`. */
export async function routeApi(page, unexpected) {
  await page.route('**/api/**', async (route) => {
    const request = `${route.request().method()} ${new URL(route.request().url()).pathname}`;
    const body = request === 'POST /api/session'
      ? authenticatedLocalSession({ passkey_enrollment_available: false, passkey_registered: false })
      : null;
    if (!body) unexpected.push(request);
    await route.fulfill({
      status: body ? 200 : 404, contentType: 'application/json',
      body: JSON.stringify(body ?? { detail: 'unknown' }),
    });
  });
}
