import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe.js';

const modelCatalog = JSON.parse(
  readFileSync(new URL('../src/lib/modelCatalog.json', import.meta.url), 'utf8'),
);

function localSession(overrides = {}) {
  return {
    profile: 'local',
    authenticated: false,
    initialized: false,
    authentication_state: 'uninitialized',
    ...overrides,
  };
}

function authenticatedLocalSession(overrides = {}) {
  return localSession({
    authenticated: true,
    initialized: true,
    authentication_state: 'configured',
    authentication_method: 'webauthn',
    origin_admitted: true,
    oauth_completion_mode: null,
    passkey_enrollment_available: true,
    passkey_registered: true,
    ...overrides,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function routeSession(page, response, gate = null) {
  const requested = deferred();
  await page.route('**/api/session', async (route) => {
    requested.resolve();
    if (gate) await gate.promise;
    await json(route, response.body, response.status);
  });
  return requested;
}

async function routeReadyChat(page, { teamGate, inferenceGate }) {
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', async (route) => {
    await teamGate.promise;
    await json(route, {
      teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }],
    });
  });
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));
  await page.route('**/api/teams/marketing/assistants', (route) => json(route, { assistants: [] }));
  await page.route('**/api/teams/marketing/files', (route) => json(route, { files: [] }));
  await page.route('**/api/model-providers', (route) => json(route, {
    providers: modelCatalog.providers.map(({ credential_validation: _credential, ...provider }) => ({
      ...provider,
      configured: true,
      masked: '••••1234',
    })),
  }));
  await page.route('**/api/teams/marketing/inference', async (route) => {
    await inferenceGate.promise;
    await json(route, { team_id: 'marketing', provider: 'openai', model: 'gpt-6.1-sol', effort: 'low' });
  });
  await page.routeWebSocket('**/api/teams/marketing/chat/ws', (socket) => {
    socket.onMessage((message) => {
      if (JSON.parse(message).type === 'sync') {
        socket.send(JSON.stringify({ type: 'sync-empty' }));
      }
    });
  });
}

test('holds the app inert behind the boot screen until the session resolves, then releases to setup', async ({ page }) => {
  const sessionGate = deferred();
  const sessionRequested = await routeSession(page, {
    body: localSession(),
  }, sessionGate);

  await page.goto('/');
  await sessionRequested.promise;

  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  await expect(page.locator('.initial-content')).toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  // The boot screen's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);
  sessionGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
});

test('keeps one boot surface through Team and model hydration, then focuses usable Chat', async ({ page }) => {
  const teamGate = deferred();
  const inferenceGate = deferred();
  await routeReadyChat(page, { teamGate, inferenceGate });

  await page.goto('/chat/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  await expect(page.locator('.chat-route')).toBeHidden();

  const inferenceRequest = page.waitForRequest('**/api/teams/marketing/inference');
  teamGate.resolve();
  await inferenceRequest;
  await expect(boot).toBeVisible();
  await expect(page.locator('.chat-route')).toBeHidden();

  inferenceGate.resolve();
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(boot).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
});

test('releases to the empty-Team final state without waiting for a model request', async ({ page }) => {
  const teamGate = deferred();
  let inferenceRequests = 0;
  page.on('request', (request) => {
    if (/\/api\/teams\/[^/]+\/inference$/.test(new URL(request.url()).pathname)) {
      inferenceRequests += 1;
    }
  });
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', async (route) => {
    await teamGate.promise;
    await json(route, { teams: [] });
  });
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));

  await page.goto('/chat/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  teamGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByText('Create a Team with the + button to start chatting.')).toBeVisible();
  expect(inferenceRequests).toBe(0);
});

test('keeps boot visible across the authenticated root redirect', async ({ page }) => {
  const teamGate = deferred();
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', async (route) => {
    await teamGate.promise;
    await json(route, { teams: [] });
  });
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));

  await page.goto('/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/?$/);
  await expect(page.locator('.chat-route')).toBeHidden();
  teamGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByText('Create a Team with the + button to start chatting.')).toBeVisible();
});

test('releases to the final Chat error when Team hydration fails', async ({ page }) => {
  const teamGate = deferred();
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', async (route) => {
    await teamGate.promise;
    await json(route, { detail: 'Team catalog unavailable.' }, 503);
  });
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));

  await page.goto('/chat/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  teamGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByText('Local chat data is unavailable.')).toBeVisible();
  await expect(page.getByText('Technical detail: Team catalog unavailable.')).toBeVisible();
});

test('releases the Assistants route when initial catalog hydration does not settle', async ({ page }) => {
  const catalogGate = deferred();
  const catalogRequested = deferred();
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', (route) => json(route, {
    teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }],
  }));
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));
  await page.route('**/api/teams/marketing/assistants', (route) => json(route, { assistants: [] }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, async (route) => {
    catalogRequested.resolve();
    await catalogGate.promise;
    await json(route, { version: 1, locale: 'en', assistants: [] });
  });
  await page.route('**/api/local-assistants', (route) => json(route, {
    assistants: [],
    trace_id: 'c'.repeat(32),
  }));

  await page.goto('/assistants/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await catalogRequested.promise;
  await expect(boot).toBeVisible();
  await expect(boot).toHaveCount(0, { timeout: 3500 });
  await expect(page.locator('.assistant-catalog-loading')).toBeVisible();

  catalogGate.resolve();
  await expect(page.locator('.assistant-catalog-loading')).toHaveCount(0);
});

test('releases to retry when the session check reaches an error', async ({ page }) => {
  const sessionGate = deferred();
  const sessionRequested = await routeSession(page, {
    status: 503,
    body: { detail: 'Unavailable' },
  }, sessionGate);

  await page.goto('/');
  await sessionRequested.promise;
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  sessionGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});

