import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe.js';

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
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, method: 'totp' }) });
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
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ methods: ['totp'] }) });
  });
  await page.route('**/api/login/totp', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'invalid Supervisor code' }),
  }));

  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('violet otter lantern quartz 92');
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect(ticketIssued).toBe(true);
  await page.getByLabel('Six-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  await expect(page.getByRole('alert')).toContainText('That code was not accepted');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
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
      methods: ['totp', 'passkey'],
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

test('renders bounded Local login feedback instead of the raw API error', async ({ page }) => {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      profile: 'local',
      authenticated: false,
      initialized: true,
      authentication_state: 'configured',
    }),
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
});

test('renders the terminal recovery action for an unsupported password record', async ({ page }) => {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      profile: 'local',
      authenticated: false,
      initialized: true,
      authentication_state: 'recovery-required',
    }),
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
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/platform-release', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      release: `ghcr.io/theshimpz/shimpz-local-release@sha256:${'a'.repeat(64)}`,
      ordinal: 42,
      checked_at: '2026-08-08T22:52:21Z',
      outcome: 'updated',
    }),
  }));

  await page.goto('/assistants/');

  const status = page.getByText('Admin v0.1.0', { exact: true });
  await expect(status).toBeVisible();
  await expect(status.locator('..')).toHaveAttribute('title', 'Local platform release 42');
  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: /Português/ }).click();
  await expect(status).toBeVisible();
  await expect(page.getByRole('button', { name: 'Idioma: Português' })).toBeVisible();
});

test('names a developer release built on this host in the Local release status', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/platform-release', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      release: `localhost/shimpz-local-release@sha256:${'b'.repeat(64)}`,
      ordinal: 42,
      checked_at: '2026-08-08T22:52:21Z',
      outcome: 'current',
    }),
  }));

  await page.goto('/assistants/');

  const status = page.getByText('Admin v0.1.0', { exact: true });
  await expect(status.locator('..')).toHaveAttribute('title', 'Developer build on Local platform release 42');
});

test('still shows the installed Admin version when Local release status is unavailable', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));

  await page.goto('/assistants/');

  await expect(page.getByText('Admin v0.1.0', { exact: true })).toBeVisible();
});

test('reports a Local rollback as a localized warning', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/platform-release', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      release: `ghcr.io/theshimpz/shimpz-local-release@sha256:${'a'.repeat(64)}`,
      ordinal: 42,
      checked_at: '2026-08-08T22:52:21Z',
      outcome: 'rollback-needed',
    }),
  }));

  await page.goto('/assistants/');

  const release = page.getByText('Admin v0.1.0', { exact: true }).locator('..');
  await expect(release.getByText('Update rolled back', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: /Português/ }).click();
  await expect(release.getByText('Atualização revertida', { exact: true })).toBeVisible();
});

test('opens the Store for the Team its link names and refuses a missing Team', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [
      { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
      { team_id: 'gestao', team_name: 'Gestão', status: 'running' },
    ] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, locale: 'en',
      assistants: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_version: '0.4.5',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Shimpz Cloudflare',
        source_digest: `sha256:${'f'.repeat(64)}`,
        summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
      }],
    }),
  }));
  await page.route('**/api/local-assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [], trace_id: 'c'.repeat(32) }),
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route('**/api/teams/marketing/files', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ files: [] }),
  }));

  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  await expect(catalog).toBeVisible();
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
  const install = catalog.getByRole('button', { name: /install/i }).first();
  if (await install.count()) await expect(install).toBeDisabled();
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
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [{
      assistant: 'shimpz-cloudflare',
      assistant_version: '0.4.5',
      status: 'running',
      provenance: 'local',
    }] }),
  }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, locale: 'en',
      assistants: [
        {
          assistant_id: 'another-assistant',
          assistant_version: '1.0.0',
          creators: ['@creator'],
          icon_digest: `sha256:${'d'.repeat(64)}`,
          name: 'Published Helper',
          source_digest: `sha256:${'c'.repeat(64)}`,
          summary: 'A publication without a staged Local counterpart.',
        },
        {
          assistant_id: 'shimpz-cloudflare',
          assistant_version: '0.4.4',
          creators: ['@shimpz'],
          icon_digest: `sha256:${'e'.repeat(64)}`,
          name: 'Published Cloudflare',
          source_digest: `sha256:${'f'.repeat(64)}`,
          summary: 'This publication must never render while Local inventory is pending.',
        },
      ],
    }),
  }));
  await page.route('**/api/local-assistants', async (route) => {
    await localInventoryGate;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
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
        }],
        trace_id: 'c'.repeat(32),
      }),
    });
  });
  await page.route('**/api/local-assistants/*/icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: localIcon,
  }));

  const publicInventory = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/assistant-catalog'
  ));
  await page.goto('/assistants/');
  await publicInventory;

  const boot = page.locator('[data-slot="boot-screen"]');
  const catalog = page.locator('section.assistant-catalog');
  await expect(boot).toBeVisible();
  await expect(catalog).toBeHidden();
  await expect(page.getByText('Published Cloudflare', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Published Helper', { exact: true })).toHaveCount(0);

  releaseLocalInventory();

  const localCard = page.getByRole('article', { name: 'shimpz-cloudflare — Local' });
  await expect(boot).toHaveCount(0);
  await expect(localCard).toBeVisible();
  await expect(catalog.getByText('Published Cloudflare', { exact: true })).toHaveCount(0);
  await expect(catalog.getByText('Published Helper', { exact: true })).toBeVisible();
  await expect(catalog.locator('.assistant-catalog-loading')).toHaveCount(0);
});

test('renders Assistant identities immediately during in-app icon hydration', async ({ page }) => {
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
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: 1, locale: 'en', assistants: [] }),
  }));
  await page.route('**/api/local-assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
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
      }],
      trace_id: 'c'.repeat(32),
    }),
  }));
  await page.route('**/api/local-assistants/*/icon', async (route) => {
    markIconRequested();
    await iconGate;
    await route.fulfill({ contentType: 'image/png', body: localIcon });
  });

  await page.goto('/teams/');
  await expect(page.locator('[data-slot="boot-screen"]')).toHaveCount(0);
  if (page.viewportSize().width <= 820) await page.getByRole('button', { name: 'Open the Team list' }).click();
  await page.getByRole('link', { name: /^Open the Store for / }).first().click();
  await iconRequested;

  const card = page.getByRole('article', { name: 'shimpz-cloudflare — Local' });
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
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/assistants/hello-pulse/catalog-icon') {
      markIconRequested();
      await iconGate;
      await route.fulfill({ contentType: 'image/png', body: icon });
      return;
    }
    const body = {
      '/api/session': authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
      '/api/teams': { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] },
      '/api/assistants': { assistants: [] },
      '/api/teams/marketing/assistants': { assistants: [] },
      '/api/assistant-catalog': { version: 1, locale: 'en', assistants: [{
        assistant_id: 'hello-pulse', assistant_version: '1.0.0', creators: ['@creator'],
        icon_digest: `sha256:${'b'.repeat(64)}`, name: 'Hello Pulse',
        source_digest: `sha256:${'a'.repeat(64)}`, summary: 'A measured public Assistant.',
      }] },
      '/api/local-assistants': { assistants: [], trace_id: 'c'.repeat(32) },
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
  const card = page.getByRole('article', { name: 'hello-pulse' });
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
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    // The icon never answers within ICON_PRESENTATION_BUDGET_MS, so the catalog gives up on it.
    if (path === '/api/assistants/hello-pulse/catalog-icon') return;
    const body = {
      '/api/session': authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
      '/api/teams': { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] },
      '/api/assistants': { assistants: [] },
      '/api/teams/marketing/assistants': { assistants: [] },
      '/api/assistant-catalog': { version: 1, locale: 'en', assistants: [{
        assistant_id: 'hello-pulse', assistant_version: '1.0.0', creators: ['@creator'],
        icon_digest: `sha256:${'b'.repeat(64)}`, name: 'Hello Pulse',
        source_digest: `sha256:${'a'.repeat(64)}`, summary: 'A measured public Assistant.',
      }] },
      '/api/local-assistants': { assistants: [], trace_id: 'c'.repeat(32) },
    }[path];
    await route.fulfill({
      status: body ? 200 : 503,
      contentType: 'application/json',
      body: JSON.stringify(body ?? {}),
    });
  });

  await page.goto('/assistants/');
  const iconBox = page.getByRole('article', { name: 'hello-pulse' }).locator('.shimpz-assistant-icon');
  await expect(iconBox).toHaveAttribute('data-state', 'loading');
  await expect(iconBox).toHaveAttribute('data-state', 'failed', { timeout: 5000 });
  await expect(iconBox.locator('img')).toHaveCount(0);
});

test('renders public Assistants directly in Hosted without Local enumeration', async ({ page }) => {
  let localInventoryRequests = 0;
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ profile: 'hosted', authenticated: true, account_id: 'account-1' }),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: 1, locale: 'en', assistants: [{
      assistant_id: 'published-helper',
      assistant_version: '1.0.0',
      creators: ['@creator'],
      icon_digest: `sha256:${'e'.repeat(64)}`,
      name: 'Published Helper',
      source_digest: `sha256:${'f'.repeat(64)}`,
      summary: 'A published Assistant available to Hosted.',
    }] }),
  }));
  await page.route('**/api/local-assistants', (route) => {
    localInventoryRequests += 1;
    return route.fulfill({ status: 500, body: '{}' });
  });

  await page.goto('/assistants/');

  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  await expect(catalog.getByText('Published Helper', { exact: true })).toBeVisible();
  await expect(catalog.locator('.assistant-catalog-loading')).toHaveCount(0);
  expect(localInventoryRequests).toBe(0);
});

test('keeps public discovery available when Local snapshot enumeration fails', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: 1, locale: 'en', assistants: [{
      assistant_id: 'published-helper',
      assistant_version: '1.0.0',
      creators: ['@creator'],
      icon_digest: `sha256:${'e'.repeat(64)}`,
      name: 'Published Helper',
      source_digest: `sha256:${'f'.repeat(64)}`,
      summary: 'Public discovery remains available after an explicit Local inventory failure.',
    }] }),
  }));
  await page.route('**/api/local-assistants', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({
      error: 'Local Assistant snapshots are unavailable',
      code: 'local-assistant-snapshots-unavailable',
      trace_id: 'c'.repeat(32),
    }),
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route('**/api/teams/marketing/files', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ files: [] }),
  }));

  const localInventory = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/local-assistants'
  ));
  await page.goto('/assistants/');
  await localInventory;

  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  await expect(catalog).toBeVisible();
  await expect(catalog.getByText('Local Assistant snapshots are unavailable', { exact: true })).toBeVisible();
  await expect(catalog.getByRole('button', { name: 'Reload snapshots' })).toBeEnabled();
  await expect(catalog.locator('.local-assistant-card')).toHaveCount(0);
  await expect(catalog.getByText('Published Helper', { exact: true })).toBeVisible();
});

test('installs an exact unpublished Local Assistant snapshot into the selected Team', async ({ page }) => {
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
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [
      { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
    ] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, locale: 'en',
      assistants: [{
        assistant_id: 'whatsapp',
        assistant_version: '0.2.0',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Published WhatsApp',
        source_digest: `sha256:${'f'.repeat(64)}`,
        summary: 'This publication must be shadowed by the staged Local build.',
      }],
    }),
  }));
  await page.route('**/api/local-assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
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
        },
      ],
      trace_id: 'c'.repeat(32),
    }),
  }));
  await page.route('**/api/local-assistants/*/icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: localIcon,
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      assistants: installed
        ? [{ assistant: 'whatsapp', assistant_version: '0.2.1', status: 'running', provenance: 'local' }]
        : [],
    }),
  }));
  await page.route('**/api/teams/marketing/assistants/local', async (route) => {
    expect(await route.request().postDataJSON()).toEqual({ image_id: imageId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    installed = true;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        assistant: 'whatsapp',
        image_id: imageId,
        installed: true,
        provenance: 'local',
        unpublished: true,
        trace_id: 'd'.repeat(32),
      }),
    });
  });
  await page.route('**/api/teams/marketing/assistants/whatsapp', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    installed = false;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        assistant: 'whatsapp',
        uninstalled: true,
      }),
    });
  });

  await page.goto('/assistants/');

  const catalog = page.getByRole('region', { name: 'Shimpz Assistant Store' });
  const card = page.getByRole('article', { name: 'whatsapp — Local' });
  await expect(catalog.locator('.local-assistant-card')).toHaveCount(1);
  await expect(catalog.getByText('Published WhatsApp', { exact: true })).toHaveCount(0);
  await expect(card).toContainText('WhatsApp Automation');
  await expect(card.locator('.shimpz-assistant-icon img')).toHaveAttribute('src', /^blob:/);
  await expect(card).not.toHaveClass(/is-installed/);

  await card.hover();
  await card.getByRole('button', { name: 'Install or replace' }).click();

  let installDialog = page.getByRole('dialog', { name: 'Install WhatsApp Automation?' });
  await installDialog.getByRole('button', { name: /v0\.1\.0/ }).click();
  await expect(installDialog).toContainText(olderImageId);
  await installDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(installDialog).toBeHidden();

  await card.hover();
  await card.getByRole('button', { name: 'Install or replace' }).click();

  installDialog = page.getByRole('dialog', { name: 'Install WhatsApp Automation?' });
  await expect(installDialog).toBeVisible();
  await expect(installDialog).toContainText('Local snapshots are not published, reviewed, signed, or scanned by Shimpz.');
  await expect(installDialog).toContainText(imageId);
  await expect(installDialog).toContainText('Marketing');
  await installDialog.getByRole('button', { name: 'Install or replace' }).click();
  await expect(installDialog.getByRole('button', { name: 'Installing…' })).toBeVisible();
  await expect(installDialog).toBeHidden();
  await expect(page.getByText('Local Assistant installed', { exact: true })).toBeVisible();
  await expect(page.getByText('whatsapp is ready in Marketing', { exact: false })).toBeVisible();
  await expect(card).toHaveClass(/is-installed/);

  await card.hover();
  const uninstallAction = card.locator('button.assistant-action-button');
  await expect(uninstallAction).toHaveText('Uninstall Assistant');
  await uninstallAction.click();
  const uninstallDialog = page.getByRole('dialog', { name: 'Uninstall WhatsApp Automation?' });
  await expect(uninstallDialog).toBeVisible();
  await expect(uninstallDialog.getByText(/Local build, its snapshot remains staged on this machine/)).toBeVisible();
  await expect(uninstallDialog.getByText(/shimpz assistant unstage/)).toBeVisible();
  await uninstallDialog.getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByText('Assistant uninstalled', { exact: true })).toBeVisible();
  await expect(page.getByText(/docker image rm/)).toHaveCount(0);
});

test('lets an explicit Local install replace the matching publication', async ({ page }) => {
  const imageId = `sha256:${'b'.repeat(64)}`;
  const localIcon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlN7eIAAAAASUVORK5CYII=',
    'base64',
  );
  let provenance = 'published';
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [
      { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
    ] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, locale: 'en',
      assistants: [{
        assistant_id: 'whatsapp',
        assistant_version: '0.2.0',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Published WhatsApp',
        source_digest: `sha256:${'f'.repeat(64)}`,
        summary: 'This publication must be shadowed by the staged Local build.',
      }],
    }),
  }));
  await page.route('**/api/local-assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
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
      }],
      trace_id: 'c'.repeat(32),
    }),
  }));
  await page.route('**/api/local-assistants/*/icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: localIcon,
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      assistants: [{
        assistant: 'whatsapp',
        assistant_version: '0.2.1',
        status: 'running',
        provenance,
      }],
    }),
  }));
  await page.route('**/api/teams/marketing/assistants/local', async (route) => {
    expect(await route.request().postDataJSON()).toEqual({ image_id: imageId });
    provenance = 'local';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        assistant: 'whatsapp',
        image_id: imageId,
        installed: true,
        provenance: 'local',
        unpublished: true,
      }),
    });
  });

  await page.goto('/assistants/');

  const card = page.getByRole('article', { name: 'whatsapp — Local' });
  await expect(card).not.toHaveClass(/is-installed/);
  await expect(page.getByText('Published WhatsApp', { exact: true })).toHaveCount(0);
  await card.hover();
  await card.getByRole('button', { name: 'Install or replace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Install WhatsApp Automation?' });
  await expect(dialog).toContainText('Local snapshots are not published, reviewed, signed, or scanned by Shimpz.');
  await dialog.getByRole('button', { name: 'Install or replace' }).click();
  await expect(card).toHaveClass(/is-installed/);
});

test('asks for the first Team from the Store when no Team exists', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: 1, locale: 'en', assistants: [] }),
  }));

  await page.goto('/assistants/');

  const dialog = page.getByRole('dialog', { name: 'Create a Team' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
});
