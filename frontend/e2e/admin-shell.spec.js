import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { assistantDetails, PAGE_COPY, publicAssistant } from './assistantPages.js';
import { accessibilityViolations } from './axe.js';
import { catalogSnapshots } from './catalogScenario.js';
import { switchLanguage } from './interaction.js';
import {
  activityReports,
  raiseTopic,
  readsOf,
  routeRead,
  routeScenario,
  sessionFrames,
  waitForRead,
} from './scenarioRoutes.js';
import { authenticatedLocalSession, localSession } from './scenarios.js';
import { recoveryCodeSet } from './securityScenarios.js';
import { messages } from '../src/lib/i18n/catalogs.js';

const ok = (json, status = 200) => ({ status, json });
// The Admin version the sidebar names: its commit date and short revision, or dev for a build that names no revision.
const ADMIN_VERSION = /^Admin (?:dev|v\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7})$/;

// A person taps on a touch screen and clicks with a pointer; each touch-project run proves the control works by touch.
// A Space with one Team and no Assistant: the shell's Team context reads it, so the screen under test settles.
async function answerQuietSpace(page) {
  await routeRead(page, 'teams.list', () => ({
    status: 200, json: { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] },
  }));
  await routeRead(page, 'assistants.registry', () => ({ status: 200, json: { assistants: [] } }));
  await routeRead(page, 'assistants.list', () => ({ status: 200, json: { assistants: [] } }));
}

async function press(control, testInfo) {
  if (testInfo.project.use.hasTouch) await control.tap();
  else await control.click();
}

test('completes mandatory authenticator enrollment before opening Admin', async ({ page }) => {
  let authenticationState = 'uninitialized';
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable in the MFA contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticationState === 'configured'
      ? authenticatedLocalSession({
        oauth_completion_mode: null,
        authentication_method: 'totp',
        passkey_enrollment_available: false,
        passkey_registered: false,
      })
      : localSession()),
  }));
  await page.route('**/api/admin/setup', async (route) => {
    expect(await route.request().postDataJSON()).toEqual({
      password: 'violet otter lantern quartz 92',
    });
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        enrollment: {
          secret: 'JBSWY3DPEHPK3PXP',
          uri: 'otpauth://totp/Shimpz%3ASupervisor?secret=JBSWY3DPEHPK3PXP&issuer=Shimpz',
        },
      }),
    });
  });
  await page.route('**/api/admin/setup/totp', async (route) => {
    expect(await route.request().postDataJSON()).toEqual({ code: '123456' });
    authenticationState = 'configured';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, method: 'totp', recovery_codes: recoveryCodeSet(0) }),
    });
  });

  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('violet otter lantern quartz 92');
  await page.getByLabel('Confirm password').fill('violet otter lantern quartz 92');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Add an authenticator' })).toBeVisible();
  await expect(page.getByAltText('QR code for the Shimpz Supervisor authenticator')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.getByText('JBSWY3DPEHPK3PXP', { exact: true })).toBeVisible();
  const codeInput = page.getByLabel('Six-digit code');
  await codeInput.fill('123456');
  await expect(codeInput).toHaveAttribute('pattern', '[0-9]{6}');
  await expect.poll(() => codeInput.evaluate((input) => input.checkValidity())).toBe(true);
  const enrollmentResponse = page.waitForResponse((response) => response.url().endsWith('/api/admin/setup/totp'));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await enrollmentResponse;

  // The recovery codes are shown once, before Admin opens.
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveText(recoveryCodeSet(0));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: /^(New Team|Open the Team list)$/ })).toBeVisible();
});

test('announces a rejected TOTP and returns focus to password entry', async ({ page }) => {
  let ticketIssued = false;
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable in the MFA contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(localSession({ initialized: true, authentication_state: 'configured' })),
  }));
  await page.route('**/api/login', (route) => {
    ticketIssued = true;
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ methods: ['totp', 'recovery-code'] }),
    });
  });
  await page.route('**/api/login/totp', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'invalid Supervisor code' }),
  }));

  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('violet otter lantern quartz 92');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // A click returns once it is dispatched; the sign-in request it causes reaches the route a moment later.
  await expect.poll(() => ticketIssued).toBe(true);
  await page.getByLabel('Six-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  await expect(page.getByRole('alert')).toContainText('That code was not accepted');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
});

test('a refused code that arrives after the person moved the focus leaves it where they put it', async ({ page }) => {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(localSession({ initialized: true, authentication_state: 'configured' })),
  }));
  await page.route('**/api/login', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({ methods: ['totp', 'recovery-code'] }),
  }));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let asked = false;
  await page.route('**/api/login/totp', async (route) => {
    asked = true;
    await held;
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'invalid' }) });
  });

  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('violet otter lantern quartz 92');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Six-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect.poll(() => asked).toBe(true);
  const language = page.getByRole('button', { name: 'Language: English' });
  await language.focus();
  release();
  await expect(page.getByRole('alert')).toContainText('That code was not accepted');
  await expect(language).toBeFocused();
});

test('registers and then uses a UV passkey through the browser ceremony', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one real Chromium WebAuthn ceremony is sufficient');
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  let sessionState = 'totp';
  let credentialId = '';
  let assertionReceived = false;
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable in the passkey contract.' }),
  }));
  await page.route('**/api/session', (route) => {
    const body = sessionState === 'none'
      ? localSession({ initialized: true, authentication_state: 'configured' })
      : authenticatedLocalSession({
        oauth_completion_mode: null,
        authentication_method: sessionState === 'totp' ? 'totp' : 'webauthn',
        passkey_enrollment_available: true,
        passkey_registered: sessionState === 'passkey',
      });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/api/admin/passkeys/registration', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ options: {
      attestation: 'none',
      authenticatorSelection: {
        requireResidentKey: false,
        residentKey: 'preferred',
        userVerification: 'required',
      },
      challenge: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
      excludeCredentials: [],
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
      rp: { id: 'localhost', name: 'Shimpz' },
      timeout: 180000,
      user: {
        displayName: 'Supervisor',
        id: 'MDEyMzQ1Njc4OWFiY2RlZg',
        name: 'Supervisor',
      },
    } }),
  }));
  await page.route('**/api/admin/passkeys', async (route) => {
    const credential = (await route.request().postDataJSON()).credential;
    credentialId = credential.rawId;
    expect(credential.response.attestationObject).toMatch(/^[A-Za-z0-9_-]+$/);
    sessionState = 'passkey';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ registered: true }) });
  });
  await page.route('**/api/login', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({
      methods: ['totp', 'passkey', 'recovery-code'],
      passkey_options: {
        allowCredentials: [{ id: credentialId, type: 'public-key' }],
        challenge: 'YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODk',
        rpId: 'localhost',
        timeout: 180000,
        userVerification: 'required',
      },
    }),
  }));
  await page.route('**/api/login/passkey', async (route) => {
    const credential = (await route.request().postDataJSON()).credential;
    expect(credential.rawId).toBe(credentialId);
    expect(credential.response.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    assertionReceived = true;
    sessionState = 'passkey';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, method: 'passkey' }) });
  });

  await page.goto('http://localhost:4173/');
  await expect(page.getByRole('heading', { name: 'Make future sign-ins easier' })).toBeVisible();
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect.poll(() => credentialId).not.toBe('');
  await expect(page.getByRole('button', { name: /^(New Team|Open the Team list)$/ })).toBeVisible();

  sessionState = 'none';
  await page.goto('http://localhost:4173/');
  await page.getByLabel('Password', { exact: true }).fill('violet otter lantern quartz 92');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Use a passkey' }).click();

  await expect.poll(() => assertionReceived).toBe(true);
  await expect(page.getByRole('button', { name: /^(New Team|Open the Team list)$/ })).toBeVisible();
  await client.send('WebAuthn.disable');
});

test('a passkey that cannot be created keeps the offer, and Create passkey takes the focus back', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({
      oauth_completion_mode: null,
      authentication_method: 'totp',
      passkey_enrollment_available: true,
      passkey_registered: false,
    })),
  }));

  await page.goto('http://localhost:4173/');
  await expect(page.getByRole('heading', { name: 'Make future sign-ins easier' })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create passkey' });
  await create.click();
  await expect(page.getByRole('alert')).toContainText(messages.en.auth.passkeyFailed);
  await expect(create).toBeFocused();
});

test('a passkey sign-in the browser cancels returns the focus to the code field', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.credentials.get = () => Promise.reject(new DOMException('canceled', 'NotAllowedError'));
  });
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(localSession({ initialized: true, authentication_state: 'configured' })),
  }));
  await page.route('**/api/login', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({
      methods: ['totp', 'passkey', 'recovery-code'],
      passkey_options: {
        allowCredentials: [],
        challenge: 'YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODk',
        rpId: 'localhost',
        timeout: 180000,
        userVerification: 'required',
      },
    }),
  }));

  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('violet otter lantern quartz 92');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(page.getByRole('alert')).toContainText(messages.en.auth.passkeyCanceled);
  await expect(page.getByLabel('Six-digit code')).toBeFocused();
});

test('renders bounded Local login feedback instead of the raw API error', async ({ page }) => {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(localSession({ initialized: true, authentication_state: 'configured' })),
  }));
  await page.route('**/api/login', (route) => route.fulfill({
    status: 429,
    contentType: 'application/json',
    headers: { 'Retry-After': '60' },
    body: JSON.stringify({ detail: 'too many login attempts' }),
  }));

  await page.goto('/');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  // The sign-in screen's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByLabel('Password', { exact: true }).fill('wrong password value');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('Too many attempts. Wait one minute and try again.')).toBeVisible();
  await expect(page.getByText('too many login attempts')).toHaveCount(0);
  // The refusal gives the field the request disabled its focus back.
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
});

test('a sign-in step that cannot reach Admin keeps its own field focused for another try', async ({ page }) => {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(localSession({ initialized: true, authentication_state: 'configured' })),
  }));
  await page.route('**/api/login', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({ methods: ['totp', 'recovery-code'] }),
  }));
  await page.route('**/api/login/recovery', (route) => route.abort());

  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('violet otter lantern quartz 92');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  const recoveryCode = page.getByRole('textbox', { name: 'Recovery code' });
  await recoveryCode.fill('aaaa-bbbb-cccc');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText(messages.en.auth.unreachable);
  await expect(recoveryCode).toHaveValue('aaaa-bbbb-cccc');
  await expect(recoveryCode).toBeFocused();
});

test('renders the terminal recovery action for an unsupported password record', async ({ page }) => {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(localSession({ initialized: true, authentication_state: 'recovery-required' })),
  }));

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Supervisor password reset required' })).toBeVisible();
  await expect(page.getByLabel('Recovery commands')).toContainText('shimpz reset');
  await expect(page.getByLabel('Recovery commands')).toContainText('shimpz install');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test('shows the installed Admin version with the read-only Local release status', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'platform.release', () => ({ status: 200, json: {
      release: `ghcr.io/theshimpz/shimpz-local-release@sha256:${'a'.repeat(64)}`,
      ordinal: 42,
      checked_at: '2026-08-08T22:52:21Z',
      outcome: 'updated',
    } }));

  await page.goto('/assistants/');

  const status = page.getByText(ADMIN_VERSION);
  await expect(status).toBeVisible();
  await expect(status.locator('..')).toHaveAttribute('title', 'Local platform release 42');
  await page.getByRole('button', { name: 'Language: English' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitemradio', { name: /Português/ }).click();
  // Choosing a language closes the menu and returns focus to its trigger, named in the chosen language.
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(status).toBeVisible();
  await expect(page.getByRole('button', { name: 'Idioma: Português' })).toBeFocused();
});

test('Admin opens and changes its language where the browser refuses site storage', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  // A browser that blocks all site data throws on every use of localStorage.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
    });
  });
  await routeScenario(page, 'ready');
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
  await switchLanguage(page, 'en', 'pt');
  await expect(page.getByRole('button', { name: 'Idioma: Português' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('names a developer release built on this host in the Local release status', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'platform.release', () => ({ status: 200, json: {
      release: `localhost/shimpz-local-release@sha256:${'b'.repeat(64)}`,
      ordinal: 42,
      checked_at: '2026-08-08T22:52:21Z',
      outcome: 'current',
    } }));

  await page.goto('/assistants/');

  const status = page.getByText(ADMIN_VERSION);
  await expect(status.locator('..')).toHaveAttribute('title', 'Developer build on Local platform release 42');
});

test('still shows the installed Admin version when Local release status is unavailable', { tag: '@mobile' }, async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);

  await page.goto('/assistants/');

  await expect(page.getByText(ADMIN_VERSION)).toBeVisible();
});

test('reports a Local rollback as a localized warning', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'platform.release', () => ({ status: 200, json: {
      release: `ghcr.io/theshimpz/shimpz-local-release@sha256:${'a'.repeat(64)}`,
      ordinal: 42,
      checked_at: '2026-08-08T22:52:21Z',
      outcome: 'rollback-needed',
    } }));

  await page.goto('/assistants/');

  const release = page.getByText(ADMIN_VERSION).locator('..');
  await expect(release.getByText('Update rolled back', { exact: true })).toBeVisible();
  await switchLanguage(page, 'en', 'pt');
  await expect(release.getByText('Atualização revertida', { exact: true })).toBeVisible();
});

test('reads a Team list change heard while the shell loads, and nothing it reads on its own reports activity', async ({ page }) => {
  const scenario = await routeScenario(page);
  const listed = (await scenario.call('teams.list', {})).json.teams;
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let lists = 0;
  await routeRead(page, 'teams.list', async () => {
    lists += 1;
    if (lists === 1) {
      await first;
      return undefined;
    }
    return ok({ teams: [...listed, { team_id: 'research', team_name: 'Research', status: 'running' }] });
  });

  await page.goto('/chat/?team=marketing');
  await expect.poll(() => lists).toBe(1);
  await expect.poll(() => scenario.sessions.some((session) => session.subscribed('teams'))).toBe(true);
  // Another tab made a Team while this one's first list read was still on its way.
  await raiseTopic(page, 'teams');
  releaseFirst();
  await expect(page.getByRole('link', { name: 'Research', exact: true })).toBeVisible();
  expect(lists).toBe(2);

  // The new Team's Routines are read once their subscription is in place.
  const routineLists = async () => (await sessionFrames(page)).filter((frame) => frame.method === 'routines.list');
  await expect.poll(async () => (await routineLists()).some((frame) => frame.params.team_id === 'research')).toBe(true);
  // Nobody touched the page: nothing it read on its own kept the session alive.
  expect(await activityReports(page)).toBe(0);
});

test('a selected Team removed and made again elsewhere reloads the Team context without reporting activity', async ({ page }) => {
  const scenario = await routeScenario(page);
  const listed = (await scenario.call('teams.list', {})).json.teams;
  let removed = false;
  await routeRead(page, 'teams.list', () => (
    removed ? ok({ teams: listed.filter((team) => team.team_id !== 'marketing') }) : undefined
  ));
  // The fast routing state cannot be read, so the composer's menu reads it again whenever it is shown.
  await routeRead(page, 'decision.read', () => ({ status: 503, json: { detail: 'unavailable' } }));
  await page.goto('/chat/?team=marketing');
  const navigation = page.locator('.shell-sidebar');
  await expect(navigation.getByRole('link', { name: 'Marketing', exact: true })).toBeVisible();
  await expect.poll(() => scenario.sessions.some((session) => session.subscribed('teams'))).toBe(true);

  // Another tab deleted Marketing: the whole context loads again.
  const inferenceReads = async () => (await readsOf(page, 'inference.read')).map((params) => params.team_id);
  const marketingReads = (await inferenceReads()).filter((teamId) => teamId === 'marketing').length;
  removed = true;
  await raiseTopic(page, 'teams');
  await expect(navigation.getByRole('link', { name: 'Marketing', exact: true })).toHaveCount(0);
  // The Team selected in its place opens: its model settings and its chat history are read.
  await expect.poll(async () => (await inferenceReads()).some((teamId) => teamId !== 'marketing')).toBe(true);
  const histories = async () => (await sessionFrames(page)).filter((frame) => (
    frame.type === 'call' && frame.method === 'history.page' && frame.params.team_id !== 'marketing'
  ));
  await expect.poll(async () => (await histories()).length).toBeGreaterThan(0);

  // Marketing is made again elsewhere: the address still names it, so the page selects it again, on its own.
  removed = false;
  await raiseTopic(page, 'teams');
  await expect.poll(async () => (await inferenceReads()).filter((teamId) => teamId === 'marketing').length)
    .toBeGreaterThan(marketingReads);
  await expect(navigation.getByRole('link', { name: 'Marketing', exact: true })).toBeVisible();
  // Nobody touched the page: none of this kept the session alive.
  expect(await activityReports(page)).toBe(0);
});

test('an Assistant page whose Team was removed elsewhere reads the page for the Team chosen in its place without reporting activity', async ({ page }) => {
  const scenario = await routeScenario(page);
  const listed = (await scenario.call('teams.list', {})).json.teams;
  let removed = false;
  await routeRead(page, 'teams.list', () => (
    removed ? ok({ teams: listed.filter((team) => team.team_id !== 'marketing') }) : undefined
  ));
  // The Team chosen in Marketing's place runs the same Assistant, so the page reads its page copy for that Team.
  const inventory = scenario.call('assistants.list', { team_id: 'marketing' });
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (teamId === 'trinity' ? { status: 200, json: inventory.json } : undefined));
  await page.goto('/assistants/shimpz-cloudflare');
  await expect(page.getByRole('article')).toBeVisible();
  await expect.poll(() => scenario.sessions.some((session) => session.subscribed('teams'))).toBe(true);
  removed = true;
  await raiseTopic(page, 'teams');
  // The page reads the Assistant's page copy again for the Team the page selected in Marketing's place.
  await waitForRead(page, 'assistants.details', (params) => (
    params.team_id === 'trinity' && params.assistant_id === 'shimpz-cloudflare'
  ));
  expect(await activityReports(page)).toBe(0);
});

test('reads the Local release status at open and when Admin says it changed, never on a timer', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  let reads = 0;
  let outcome = 'current';
  await routeRead(page, 'platform.release', () => {
    reads += 1;
    return {
      status: 200,
      json: {
        release: `ghcr.io/theshimpz/shimpz-local-release@sha256:${'a'.repeat(64)}`,
        ordinal: 42,
        checked_at: '2026-08-08T22:52:21Z',
        outcome,
      },
    };
  });

  await page.goto('/assistants/');
  const release = page.getByText(ADMIN_VERSION).locator('..');
  await expect(release).toHaveAttribute('title', 'Local platform release 42');
  await expect.poll(() => reads).toBe(1);
  // An idle page sends nothing however long it stays open.
  await page.clock.runFor(10 * 60_000);
  expect(reads).toBe(1);
  outcome = 'rollback-needed';
  await raiseTopic(page, 'platform/release');
  await expect(release.getByText('Update rolled back', { exact: true })).toBeVisible();
  expect(reads).toBe(2);
});

test('opens the Store for the Team its link names and refuses a missing Team', { tag: '@mobile' }, async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'teams.list', () => ({ status: 200, json: { teams: [
    { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
    { team_id: 'gestao', team_name: 'Gestão', status: 'running' },
  ] } }));
  await routeRead(page, 'store.catalog', ({ locale }) => (locale === 'en' ? { status: 200, json: {
      version: 1, next: null, locale: 'en',
      assistants: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_version: '0.4.5',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Shimpz Cloudflare',
        source_digest: `sha256:${'f'.repeat(64)}`,
        summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
        ...structuredClone(PAGE_COPY),
      }],
    } } : undefined));
  await routeRead(page, 'snapshots.list', () => ({ status: 200, json: { assistants: [], trace_id: 'c'.repeat(32) } }));

  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  await expect(catalog).toBeVisible();
  // Each row opens its Assistant's page for the Team this catalog acts for.
  await expect(catalog.getByRole('link', { name: /^Shimpz Cloudflare/ }))
    .toHaveAttribute('href', '/assistants/shimpz-cloudflare?team=marketing');
  // The Assistants screen's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);
  if (page.viewportSize().width <= 820) await page.getByRole('button', { name: 'Open the Team list' }).click();
  await expect(page.getByRole('link', { name: 'Open the Store for Marketing' })).toHaveAttribute('aria-current', 'page');
  if (page.viewportSize().width <= 820) await page.keyboard.press('Escape');

  await page.goto('/assistants/?team=missing');
  await expect(catalog).toBeVisible();
  await expect(page.getByText(
    'The Team in this link is not available. Choose a Team from the Team list.',
    { exact: true },
  )).toBeVisible();
  // The catalog itself installs nothing.
  await expect(catalog.getByRole('button', { name: /install/i })).toHaveCount(0);
});
test('never renders a matching publication while Local snapshots are settling', async ({ page }) => {
  const imageId = `sha256:${'b'.repeat(64)}`;
  const localIcon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAusB9WlN7eIAAAAASUVORK5CYII=',
    'base64',
  );
  let releaseLocalInventory;
  const localInventoryGate = new Promise((resolve) => { releaseLocalInventory = resolve; });
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (teamId === 'marketing' ? { status: 200, json: { assistants: [{
      assistant: 'shimpz-cloudflare',
      assistant_version: '0.4.5',
      status: 'running',
      provenance: 'local',
    }] } } : undefined));
  await routeRead(page, 'store.catalog', ({ locale }) => (locale === 'en' ? { status: 200, json: {
      version: 1, next: null, locale: 'en',
      assistants: [
        {
          assistant_id: 'another-assistant',
          assistant_version: '1.0.0',
          creators: ['@creator'],
          icon_digest: `sha256:${'d'.repeat(64)}`,
          name: 'Published Helper',
          source_digest: `sha256:${'c'.repeat(64)}`,
          summary: 'A publication without a staged Local counterpart.',
          ...structuredClone(PAGE_COPY),
        },
        {
          assistant_id: 'shimpz-cloudflare',
          assistant_version: '0.4.4',
          creators: ['@shimpz'],
          icon_digest: `sha256:${'e'.repeat(64)}`,
          name: 'Published Cloudflare',
          source_digest: `sha256:${'f'.repeat(64)}`,
          summary: 'This publication must never render while Local inventory is pending.',
          ...structuredClone(PAGE_COPY),
        },
      ],
    } } : undefined));
  await routeRead(page, 'snapshots.list', async () => {
    await localInventoryGate;
    return ok({
        assistants: [{
          assistant_id: 'shimpz-cloudflare',
          assistant_version: '0.4.5',
          name: 'Shimpz Cloudflare',
          summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
          actions: ['list-zones'],
          integrations: ['cloudflare'],
          declared_creators: ['@shimpz'],
          created_at: '2026-09-17T07:00:00Z',
          image_id: imageId,
          platform: 'linux/amd64',
          provenance: 'local',
          unpublished: true,
          admission: 'admissible',
          reason: null,
        }],
        trace_id: 'c'.repeat(32),
    });
  });
  await page.route('**/api/local-assistants/*/icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: localIcon,
  }));

  const publicInventory = waitForRead(page, 'store.catalog');
  // The page's clock stands still while Local snapshots settle, so the boot screen's own one-second deadline cannot
  // end the settling view before this test has looked at it.
  const start = new Date('2026-10-01T12:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 60_000));
  await page.goto('/assistants/');
  await publicInventory;

  const boot = page.locator('[data-slot="boot-screen"]');
  const catalog = page.locator('section.assistant-catalog');
  await expect(boot).toBeVisible();
  await expect(catalog).toBeHidden();
  await expect(page.getByText('Published Cloudflare', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Published Helper', { exact: true })).toHaveCount(0);

  releaseLocalInventory();

  const localCard = catalog.getByRole('link', { name: /^Shimpz Cloudflare/ });
  // The catalog presents once a frame is painted: the page is stepped one frame at a time until the boot screen leaves.
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return boot.count();
  }).toBe(0);
  await expect(localCard).toBeVisible();
  await expect(catalog.getByText('Published Cloudflare', { exact: true })).toHaveCount(0);
  await expect(catalog.getByText('Published Helper', { exact: true })).toBeVisible();
  await expect(catalog.locator('.assistant-catalog-loading')).toHaveCount(0);
});

test('renders Assistant identities immediately during in-app icon hydration', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
  const imageId = `sha256:${'b'.repeat(64)}`;
  const localIcon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlN7eIAAAAASUVORK5CYII=',
    'base64',
  );
  let releaseIcon;
  let markIconRequested;
  const iconGate = new Promise((resolve) => { releaseIcon = resolve; });
  const iconRequested = new Promise((resolve) => { markIconRequested = resolve; });
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'store.catalog', ({ locale }) => (locale === 'en' ? { status: 200, json: { version: 1, next: null, locale: 'en', assistants: [] } } : undefined));
  await routeRead(page, 'snapshots.list', () => ({ status: 200, json: {
      assistants: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_version: '0.4.5',
        name: 'Shimpz Cloudflare',
        summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
        actions: ['list-zones'],
        integrations: ['cloudflare'],
        declared_creators: ['@shimpz'],
        created_at: '2026-09-17T07:00:00Z',
        image_id: imageId,
        platform: 'linux/amd64',
        provenance: 'local',
        unpublished: true,
        admission: 'admissible',
        reason: null,
      }],
      trace_id: 'c'.repeat(32),
    } }));
  await page.route('**/api/local-assistants/*/icon', async (route) => {
    markIconRequested();
    await iconGate;
    await route.fulfill({ contentType: 'image/png', body: localIcon });
  });

  await page.goto('/chat/');
  await expect(page.locator('[data-slot="boot-screen"]')).toHaveCount(0);
  if (page.viewportSize().width <= 820) await page.getByRole('button', { name: 'Open the Team list' }).click();
  await page.getByRole('link', { name: /^Open the Store for / }).first().click();
  await iconRequested;

  const card = page.getByRole('link', { name: /^Shimpz Cloudflare/ });
  try {
    await expect(card).toBeVisible();
    await expect(card.locator('.shimpz-assistant-icon img')).toHaveCount(0);
  } finally {
    releaseIcon();
  }
  await expect(card.locator('.shimpz-assistant-icon img')).toHaveAttribute('src', /^blob:/);
});

test('shows the first Assistants view before a public icon finishes loading', async ({ page }) => {
  const icon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  let releaseIcon;
  let markIconRequested;
  const iconGate = new Promise((resolve) => { releaseIcon = resolve; });
  const iconRequested = new Promise((resolve) => { markIconRequested = resolve; });
  await answerQuietSpace(page);
  await routeRead(page, 'store.catalog', () => ({ status: 200, json: { version: 1, next: null, locale: 'en', assistants: [{
        assistant_id: 'hello-pulse', assistant_version: '1.0.0', creators: ['@creator'],
        icon_digest: `sha256:${createHash('sha256').update(icon).digest('hex')}`, name: 'Hello Pulse',
        source_digest: `sha256:${'a'.repeat(64)}`, summary: 'A measured public Assistant.',
        ...structuredClone(PAGE_COPY),
      }] } }));
  await routeRead(page, 'snapshots.list', () => ({ status: 200, json: { assistants: [], trace_id: 'c'.repeat(32) } }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/assistants/hello-pulse/catalog-icon') {
      markIconRequested();
      await iconGate;
      await route.fulfill({ contentType: 'image/png', body: icon });
      return;
    }
    const body = {
      '/api/session': authenticatedLocalSession(),
    }[path];
    await route.fulfill({
      status: body ? 200 : 503,
      contentType: 'application/json',
      body: JSON.stringify(body ?? {}),
    });
  });

  // The page itself notes the icon's state at the moment the boot screen leaves, so the proof does not depend on how
  // quickly this runner observes the page.
  await page.addInitScript(() => {
    let booting = false;
    new MutationObserver(() => {
      const boot = document.querySelector('[data-slot="boot-screen"]');
      if (boot) booting = true;
      else if (booting && !('iconStateAtBootExit' in window)) {
        window.iconStateAtBootExit = document.querySelector('.shimpz-assistant-icon')?.dataset.state ?? 'absent';
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/assistants/');
  await iconRequested;
  const card = page.getByRole('link', { name: /^Hello Pulse/ });
  const iconBox = card.locator('.shimpz-assistant-icon');
  try {
    await expect(page.locator('[data-slot="boot-screen"]')).toHaveCount(0);
    // The first view never waited for the icon: when the boot screen left, the icon was still loading, or the card was
    // not shown yet because the boot screen's own deadline came first. A boot screen that waited out the icon would
    // leave only once the icon had failed or loaded.
    expect(['loading', 'absent']).toContain(await page.evaluate(() => window.iconStateAtBootExit));
    await expect(card).toBeVisible();
    await expect(iconBox.locator('img')).toHaveCount(0);
    releaseIcon();
    await expect(iconBox.locator('img')).toHaveAttribute('src', /^blob:/);
    await expect(iconBox).toHaveAttribute('data-state', 'loaded');
  } finally {
    releaseIcon();
  }
});

test('shows an over-budget public icon as unavailable instead of loading forever', async ({ page }) => {
  await answerQuietSpace(page);
  await routeRead(page, 'store.catalog', () => ({ status: 200, json: { version: 1, next: null, locale: 'en', assistants: [{
        assistant_id: 'hello-pulse', assistant_version: '1.0.0', creators: ['@creator'],
        icon_digest: `sha256:${'b'.repeat(64)}`, name: 'Hello Pulse',
        source_digest: `sha256:${'a'.repeat(64)}`, summary: 'A measured public Assistant.',
        ...structuredClone(PAGE_COPY),
      }] } }));
  await routeRead(page, 'snapshots.list', () => ({ status: 200, json: { assistants: [], trace_id: 'c'.repeat(32) } }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    // The icon never answers within ICON_PRESENTATION_BUDGET_MS, so the catalog gives up on it.
    if (path === '/api/assistants/hello-pulse/catalog-icon') return;
    const body = {
      '/api/session': authenticatedLocalSession(),
    }[path];
    await route.fulfill({
      status: body ? 200 : 503,
      contentType: 'application/json',
      body: JSON.stringify(body ?? {}),
    });
  });

  // The page's clock moves only when the test moves it, so the 1.5 s budget is measured on that clock: the page is
  // stepped one frame at a time until it requests the icon, which it does as the budget starts, and notes on its own
  // clock when that was.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (resource, options) => {
      if (String(resource?.url ?? resource).includes('/catalog-icon')) window.iconRequestedAt ??= performance.now();
      return original(resource, options);
    };
  });
  const start = new Date('2026-10-01T12:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 60_000));
  await page.goto('/assistants/');
  const iconBox = page.getByRole('link', { name: /^Hello Pulse/ }).locator('.shimpz-assistant-icon');
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.evaluate(() => window.iconRequestedAt !== undefined);
  }).toBe(true);
  const sinceRequest = await page.evaluate(() => performance.now() - window.iconRequestedAt);
  await page.clock.runFor(1_400 - sinceRequest);
  await expect(iconBox).toHaveAttribute('data-state', 'loading');
  await page.clock.runFor(200);
  await expect(iconBox).toHaveAttribute('data-state', 'failed');
  await expect(iconBox.locator('img')).toHaveCount(0);
});

test('keeps public discovery available when Local snapshot enumeration fails', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'store.catalog', ({ locale }) => (locale === 'en' ? { status: 200, json: { version: 1, next: null, locale: 'en', assistants: [{
      assistant_id: 'published-helper',
      assistant_version: '1.0.0',
      creators: ['@creator'],
      icon_digest: `sha256:${'e'.repeat(64)}`,
      name: 'Published Helper',
      source_digest: `sha256:${'f'.repeat(64)}`,
      summary: 'Public discovery remains available after an explicit Local inventory failure.',
      ...structuredClone(PAGE_COPY),
    }] } } : undefined));
  await routeRead(page, 'snapshots.list', () => ({ status: 503, json: {
      error: 'Local Assistant snapshots are unavailable',
      code: 'local-assistant-snapshots-unavailable',
      trace_id: 'c'.repeat(32),
    } }));

  const localInventory = waitForRead(page, 'snapshots.list');
  await page.goto('/assistants/');
  await localInventory;

  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  await expect(catalog).toBeVisible();
  await expect(catalog.getByText('Local Assistant snapshots are unavailable', { exact: true })).toBeVisible();
  await expect(catalog.getByRole('button', { name: 'Reload snapshots' })).toBeEnabled();
  // Only the publication is listed: no staged snapshot row appears without its inventory.
  await expect(catalog.getByRole('link')).toHaveCount(1);
  await expect(catalog.getByText('Published Helper', { exact: true })).toBeVisible();
});

test('installs an exact unpublished Local Assistant snapshot into the selected Team', { tag: '@mobile' }, async ({ page }, testInfo) => {
  const imageId = `sha256:${'b'.repeat(64)}`;
  const olderImageId = `sha256:${'a'.repeat(64)}`;
  const localIcon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlN7eIAAAAASUVORK5CYII=',
    'base64',
  );
  let installed = false;
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'teams.list', () => ok({ teams: [
      { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
    ] }));
  await routeRead(page, 'store.catalog', ({ locale }) => (locale === 'en' ? { status: 200, json: {
      version: 1, next: null, locale: 'en',
      assistants: [{
        assistant_id: 'whatsapp',
        assistant_version: '0.2.0',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Published WhatsApp',
        source_digest: `sha256:${'f'.repeat(64)}`,
        summary: 'This publication must be shadowed by the staged Local build.',
        ...structuredClone(PAGE_COPY),
      }],
    } } : undefined));
  await routeRead(page, 'snapshots.list', () => ({ status: 200, json: {
      assistants: [
        {
          assistant_id: 'whatsapp',
          assistant_version: '0.1.0',
          name: 'WhatsApp Automation',
          summary: 'Send and manage WhatsApp messages from your Team.',
          actions: ['send-message'],
          integrations: [],
          declared_creators: ['@shimpz'],
          created_at: '2026-08-28T16:00:00Z',
          image_id: olderImageId,
          platform: 'linux/amd64',
          provenance: 'local',
          unpublished: true,
          admission: 'admissible',
          reason: null,
        },
        {
          assistant_id: 'whatsapp',
          assistant_version: '0.2.1',
          name: 'WhatsApp Automation',
          summary: 'Send and manage WhatsApp messages from your Team.',
          actions: ['send-message'],
          integrations: [],
          declared_creators: ['@shimpz'],
          created_at: '2026-08-28T17:00:00Z',
          image_id: imageId,
          platform: 'linux/amd64',
          provenance: 'local',
          unpublished: true,
          admission: 'admissible',
          reason: null,
        },
      ],
      trace_id: 'c'.repeat(32),
    } }));
  await page.route('**/api/local-assistants/*/icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: localIcon,
  }));
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (teamId === 'marketing' ? { status: 200, json: {
      assistants: installed
        ? [{ assistant: 'whatsapp', assistant_version: '0.2.1', status: 'running', provenance: 'local' }]
        : [],
    } } : undefined));
  await routeRead(page, 'assistants.install_local', async ({ team_id: teamId, body }) => {
    if (teamId !== 'marketing') return undefined;
    expect(body).toEqual({ image_id: imageId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    installed = true;
    return ok({
      assistant: 'whatsapp',
      image_id: imageId,
      installed: true,
      provenance: 'local',
      unpublished: true,
      trace_id: 'd'.repeat(32),
    });
  });
  await routeRead(page, 'assistants.uninstall', ({ team_id: teamId, assistant_id: assistantId }) => {
    if (teamId !== 'marketing' || assistantId !== 'whatsapp') return undefined;
    installed = false;
    return ok({ assistant: 'whatsapp', uninstalled: true });
  });

  const whatsappPage = (locale, provenanceVersion) => assistantDetails({
    locale,
    assistant_id: 'whatsapp',
    assistant_version: provenanceVersion,
    name: 'WhatsApp Automation',
    summary: 'Send and manage WhatsApp messages from your Team.',
    description: 'Sends one reviewed WhatsApp message from your official business account after your approval.',
    links: {},
    actions: [{ id: 'send-message', effect: 'mutating', description: 'Send one WhatsApp message.' }],
    integrations: [],
    stored_inputs: [{
      id: 'whatsapp-token',
      label: 'WhatsApp token',
      description: 'Create a WhatsApp access token for your business and copy it.',
      help_url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens',
    }],
  });
  const stagedPages = [];
  await routeRead(page, 'snapshots.details', ({ image_id: stagedImage, locale }) => {
    if (locale !== 'en') return undefined;
    stagedPages.push(stagedImage);
    return ok(whatsappPage('en', '0.2.1'));
  });
  await routeRead(page, 'assistants.details', (params) => (
    params.team_id === 'marketing' && params.assistant_id === 'whatsapp' && params.locale === 'en'
      ? ok(whatsappPage('en', '0.2.1'))
      : undefined
  ));

  await page.goto('/assistants/?team=marketing');

  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  const row = catalog.getByRole('link', { name: /^WhatsApp Automation/ });
  await expect(row).toHaveCount(1);
  await expect(catalog.getByText('Published WhatsApp', { exact: true })).toHaveCount(0);
  await expect(row.locator('.shimpz-assistant-icon img')).toHaveAttribute('src', /^blob:/);
  await press(row, testInfo);

  // The page shows the newest staged build, which shadows the publication of the same Assistant.
  await expect(page).toHaveURL(/\/assistants\/whatsapp\?team=marketing$/);
  const sheet = page.getByRole('article');
  await expect(sheet.getByRole('heading', { level: 1 })).toHaveText('WhatsApp Automation');
  await expect.poll(() => stagedPages).toEqual([imageId]);
  const install = sheet.getByRole('button', { name: 'Install', exact: true });
  await press(install, testInfo);

  let installDialog = page.getByRole('dialog', { name: 'Install WhatsApp Automation?' });
  await installDialog.getByRole('button', { name: /v0\.1\.0/ }).click();
  await expect(installDialog).toContainText(olderImageId);
  await installDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(installDialog).toBeHidden();

  await press(install, testInfo);
  installDialog = page.getByRole('dialog', { name: 'Install WhatsApp Automation?' });
  await expect(installDialog).toBeVisible();
  await expect(installDialog).toContainText(imageId);
  await expect(installDialog).toContainText('Marketing');
  await installDialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(installDialog.getByRole('button', { name: 'Installing…' })).toBeVisible();
  await expect(installDialog).toBeHidden();
  await expect(page.getByText('Local Assistant installed', { exact: true })).toBeVisible();
  await expect(page.getByText('whatsapp is ready in Marketing', { exact: false })).toBeVisible();

  // Installed, the page shows the exact binding and offers its removal.
  const uninstall = sheet.getByRole('button', { name: 'Uninstall', exact: true });
  await press(uninstall, testInfo);
  const uninstallDialog = page.getByRole('dialog', { name: 'Uninstall WhatsApp Automation?' });
  await expect(uninstallDialog).toBeVisible();
  await uninstallDialog.getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByText('Assistant uninstalled', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
});

test('removes an installed publication before its staged build is installed', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
  const imageId = `sha256:${'b'.repeat(64)}`;
  const localIcon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlN7eIAAAAASUVORK5CYII=',
    'base64',
  );
  let provenance = 'published';
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'teams.list', () => ok({ teams: [
      { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
    ] }));
  await routeRead(page, 'store.catalog', ({ locale }) => (locale === 'en' ? { status: 200, json: {
      version: 1, next: null, locale: 'en',
      assistants: [{
        assistant_id: 'whatsapp',
        assistant_version: '0.2.0',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Published WhatsApp',
        source_digest: `sha256:${'f'.repeat(64)}`,
        summary: 'This publication must be shadowed by the staged Local build.',
        ...structuredClone(PAGE_COPY),
      }],
    } } : undefined));
  await routeRead(page, 'snapshots.list', () => ({ status: 200, json: {
      assistants: [{
        assistant_id: 'whatsapp',
        assistant_version: '0.2.1',
        name: 'WhatsApp Automation',
        summary: 'Send and manage WhatsApp messages from your Team.',
        actions: ['send-message'],
        integrations: [],
        declared_creators: ['@shimpz'],
        created_at: '2026-08-28T17:00:00Z',
        image_id: imageId,
        platform: 'linux/amd64',
        provenance: 'local',
        unpublished: true,
        admission: 'admissible',
        reason: null,
      }],
      trace_id: 'c'.repeat(32),
    } }));
  await page.route('**/api/local-assistants/*/icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: localIcon,
  }));
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (teamId === 'marketing' ? { status: 200, json: {
      assistants: provenance ? [{
        assistant: 'whatsapp',
        assistant_version: '0.2.1',
        status: 'running',
        provenance,
      }] : [],
    } } : undefined));
  await routeRead(page, 'assistants.install_local', ({ body }) => {
    expect(body).toEqual({ image_id: imageId });
    provenance = 'local';
    return ok({
      assistant: 'whatsapp',
      image_id: imageId,
      installed: true,
      provenance: 'local',
      unpublished: true,
    });
  });

  const whatsappPage = assistantDetails({
    assistant_id: 'whatsapp', assistant_version: '0.2.1', name: 'WhatsApp Automation',
    summary: 'Send and manage WhatsApp messages from your Team.',
  });
  await routeRead(page, 'snapshots.details', ({ locale }) => (locale === 'en' ? ok(whatsappPage) : undefined));
  await routeRead(page, 'assistants.details', ({ assistant_id: assistantId, locale }) => (
    assistantId === 'whatsapp' && locale === 'en' ? ok(whatsappPage) : undefined
  ));

  await routeRead(page, 'assistants.uninstall', ({ assistant_id: assistantId }) => {
    if (assistantId !== 'whatsapp') return undefined;
    provenance = null;
    return ok({ assistant: 'whatsapp', uninstalled: true });
  });

  // The publication of this Assistant is installed while this machine stages its own build: the installed binding is
  // what the page shows, and the staged build is offered only once that binding is removed.
  await page.goto('/assistants/whatsapp?team=marketing');
  const sheet = page.getByRole('article');
  await expect(page.getByText('Published WhatsApp', { exact: true })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('dialog', { name: 'Uninstall WhatsApp Automation?' })
    .getByRole('button', { name: 'Uninstall Assistant' }).click();
  await sheet.getByRole('button', { name: 'Install', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Install WhatsApp Automation?' });
  await expect(dialog).toContainText(imageId);
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Uninstall', exact: true })).toBeVisible();
});

test('asks for the first Team from the Store when no Team exists', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await answerQuietSpace(page);
  await routeRead(page, 'teams.list', () => ok({ teams: [] }));
  await routeRead(page, 'store.catalog', ({ locale }) => (locale === 'en' ? { status: 200, json: { version: 1, next: null, locale: 'en', assistants: [] } } : undefined));

  await page.goto('/assistants/');

  const dialog = page.getByRole('dialog', { name: 'Create a Team' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
});

test('the Store shows its rows and icons at once when opened, and again when the person returns to it', { tag: '@mobile' }, async ({ page }) => {
  await routeScenario(page, 'catalog');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  let iconRequests = 0;
  await page.route('**/api/local-assistants/*/icon', (route) => {
    iconRequests += 1;
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.goto('/chat/');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
  // While the chat sits idle, the Store's rows and icons are read before anyone opens it.
  await expect.poll(() => iconRequests).toBeGreaterThan(0);
  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  const icons = catalog.locator('a.assistant-row img');
  const rows = catalog.locator('a.assistant-row');
  const open = async () => {
    if (page.viewportSize().width <= 820) await page.getByRole('button', { name: 'Open the Team list' }).click();
    await page.getByRole('link', { name: 'Open the Store for Marketing' }).click();
    await expect(rows.first()).toBeVisible();
    await expect(icons).toHaveCount(await rows.count());
    for (const icon of await icons.all()) await expect(icon).toHaveAttribute('src', /^blob:/);
  };
  await open();
  const read = iconRequests;
  // Leaving and returning in the same tab shows the same icons without asking Admin for them again.
  if (page.viewportSize().width <= 820) await page.getByRole('button', { name: 'Open the Team list' }).click();
  await page.getByRole('link', { name: 'Marketing', exact: true }).first().click();
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
  await open();
  expect(iconRequests).toBe(read);
});

test('a catalog longer than the icon budget pins only the icons on or near the screen', { tag: '@mobile' }, async ({ page }) => {
  await routeScenario(page, 'catalog');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const digest = `sha256:${createHash('sha256').update(png).digest('hex')}`;
  const count = 120;
  await routeRead(page, 'store.catalog', ({ locale }) => ({ status: 200, json: {
    version: 1, locale, next: null,
    assistants: Array.from({ length: count }, (_, index) => publicAssistant({
      assistant_id: `bulk-${String(index).padStart(3, '0')}`,
      name: `Bulk ${String(index).padStart(3, '0')}`,
      icon_digest: digest,
    })),
  } }));
  await page.route('**/api/{assistants/*/catalog-icon,local-assistants/*/icon}', (route) => (
    route.fulfill({ contentType: 'image/png', body: png })
  ));
  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  const shownIcons = catalog.locator('a.assistant-row img[src^="blob:"]');
  // The rows on screen show their icons, while the session never holds more than its 48-icon budget.
  await expect(catalog.getByRole('link', { name: /^Bulk 000/ }).locator('img')).toHaveAttribute('src', /^blob:/);
  expect(await shownIcons.count()).toBeLessThanOrEqual(48);
  // Rows scrolled into view show theirs in turn, still within the budget.
  const last = catalog.getByRole('link', { name: /^Bulk 119/ });
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator('img')).toHaveAttribute('src', /^blob:/);
  expect(await shownIcons.count()).toBeLessThanOrEqual(48);
  await expect(catalog.getByRole('link', { name: /^Bulk 000/ }).locator('img')).toHaveCount(0);
});

test('a staged Assistant built again shows its new icon in place, without scrolling', async ({ page }) => {
  await routeScenario(page, 'catalog');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const rebuilt = `sha256:${'9'.repeat(64)}`;
  let restaged = false;
  await routeRead(page, 'snapshots.list', () => {
    const [first, ...rest] = catalogSnapshots();
    const current = restaged ? { ...first, image_id: rebuilt, created_at: '2026-10-09T07:00:00Z' } : first;
    return { status: 200, json: { assistants: [current, ...rest], trace_id: 'c'.repeat(32) } };
  });
  const iconPaths = [];
  await page.route('**/api/local-assistants/*/icon', (route) => {
    iconPaths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  const row = catalog.locator(`#assistant-${catalogSnapshots()[0].assistant_id}`);
  await expect(row.locator('img')).toHaveAttribute('src', /^blob:/);
  const before = await row.locator('img').getAttribute('src');
  // The CLI stages the same Assistant again: its row stays, with the new build's icon.
  restaged = true;
  await raiseTopic(page, 'local-assistants');
  await expect.poll(() => iconPaths).toContain(`/api/local-assistants/${'9'.repeat(64)}/icon`);
  await expect(row.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(row.locator('img')).not.toHaveAttribute('src', before);
});

test('a Store row just below the fold of its scrolling region shows its icon before it is scrolled to', async ({ page }) => {
  await routeScenario(page, 'catalog');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const digest = `sha256:${createHash('sha256').update(png).digest('hex')}`;
  await routeRead(page, 'store.catalog', ({ locale }) => ({ status: 200, json: {
    version: 1, locale, next: null,
    assistants: Array.from({ length: 24 }, (_, index) => publicAssistant({
      assistant_id: `bulk-${String(index).padStart(3, '0')}`,
      name: `Bulk ${String(index).padStart(3, '0')}`,
      icon_digest: digest,
    })),
  } }));
  await page.route('**/api/{assistants/*/catalog-icon,local-assistants/*/icon}', (route) => (
    route.fulfill({ contentType: 'image/png', body: png })
  ));
  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  await expect(catalog.getByRole('link', { name: /^Bulk 000/ }).locator('img')).toHaveAttribute('src', /^blob:/);
  // The first row below the fold of the region the catalog scrolls in, within the near-screen margin.
  const below = await catalog.locator('a.assistant-row').evaluateAll((rows) => {
    let region = rows[0]?.parentElement;
    while (region && !['auto', 'scroll'].includes(getComputedStyle(region).overflowY)) region = region.parentElement;
    const fold = (region ?? document.documentElement).getBoundingClientRect().bottom;
    const row = rows.find((candidate) => {
      const { top } = candidate.getBoundingClientRect();
      return top > fold && top < fold + 300;
    });
    return row?.textContent.match(/Bulk \d{3}/)?.[0] ?? null;
  });
  expect(below).not.toBeNull();
  await expect(catalog.getByRole('link', { name: new RegExp(`^${below}`) }).locator('img')).toHaveAttribute('src', /^blob:/);
});
