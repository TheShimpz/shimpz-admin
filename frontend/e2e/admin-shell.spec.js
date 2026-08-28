import { expect, test } from '@playwright/test';

const visualStylePath = new URL('./visual-contract.css', import.meta.url).pathname;
const visualContract = {
  animations: 'allow',
  fullPage: true,
  maxDiffPixels: 100,
  stylePath: visualStylePath,
};

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

test('renders the Local setup through the shared design system', async ({ page }) => {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(localSession()),
  }));

  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel(/password/i).first()).toBeVisible();
  await expect(page.locator('input[type="password"]').first()).toHaveAttribute('minlength', '15');
  await expect(page.getByText('At least 15 characters. This password stays on your machine.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-image', 'none');
  await expect(page.locator('.shimpz-card')).toHaveCount(1);
  await expect(page).toHaveScreenshot('setup-surface.png', visualContract);
});

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

  await expect(page.getByRole('link', { name: /chat/i })).toBeVisible();
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
  await expect(page.getByRole('link', { name: /chat/i })).toBeVisible();

  sessionState = 'none';
  await page.goto('http://localhost:4173/');
  await page.getByLabel('Password', { exact: true }).fill('violet otter lantern quartz 92');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Use a passkey' }).click();

  await expect.poll(() => assertionReceived).toBe(true);
  await expect(page.getByRole('link', { name: /chat/i })).toBeVisible();
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

  await expect(page.getByText('Space // recovery', { exact: true })).toBeVisible();
  await expect(page.getByText('Space // first run', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Supervisor password reset required' })).toBeVisible();
  await expect(page.getByLabel('Recovery commands')).toContainText('shimpz reset');
  await expect(page.getByLabel('Recovery commands')).toContainText('shimpz install');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test('uses the compact locale control at 360 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(localSession()),
  }));
  await page.goto('/');
  await expect(page.locator('.locale-full')).toBeHidden();
  await expect(page.locator('.locale-compact')).toBeVisible();
  await page.locator('.locale-compact').getByRole('button', { name: 'Language: English' }).click();
  await expect(page.getByRole('menu', { name: 'Language' })).toBeVisible();
});

test('renders authenticated navigation with canonical primitives', async ({ page }, testInfo) => {
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable in the presentation contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('https://shimpz.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body style="margin:0;background:#000"></body></html>',
  }));

  await page.goto('/assistants/');

  await expect(page.getByRole('link', { name: /assistants/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /chat/i })).toBeVisible();
  await expect(page.locator('.shimpz-nav-item')).toHaveCount(2);
  await expect(page.locator('body')).toHaveCSS('background-image', 'none');
  await expect(page.getByText('Loading the Assistant Store…', { exact: true })).toBeVisible();
  await page.addStyleTag({ path: visualStylePath });
  await expect(page).toHaveScreenshot('authenticated-shell.png', visualContract);

  const localeTrigger = page.getByRole('button', { name: 'Language: English' });
  await localeTrigger.click();
  const localeMenu = page.getByRole('menu', { name: 'Language' });
  await expect(localeMenu).toBeVisible();
  const iconBox = await localeTrigger.locator('svg').boundingBox();
  expect(iconBox).not.toBeNull();
  if (testInfo.project.name === 'mobile') {
    await expect(localeTrigger.getByText('English', { exact: true })).toHaveCount(0);
  } else {
    const labelBox = await localeTrigger.getByText('English', { exact: true }).boundingBox();
    expect(labelBox).not.toBeNull();
    expect(labelBox.x - (iconBox.x + iconBox.width)).toBeGreaterThanOrEqual(7);
  }
  await expect(localeMenu.getByRole('menuitemradio').first()).toHaveCSS('border-top-width', '0px');
  await expect(page).toHaveScreenshot('locale-menu.png', visualContract);

  if (testInfo.project.name === 'desktop') {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open notifications. 0 unread.' }).click();
    const notificationDialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(notificationDialog).toBeVisible();
    const notificationBox = await notificationDialog.boundingBox();
    expect(notificationBox).not.toBeNull();
    expect(Math.abs(notificationBox.width - 448)).toBeLessThan(1);
    expect(Math.abs((notificationBox.x + notificationBox.width) - page.viewportSize().width)).toBeLessThan(1);
    expect(Math.abs(notificationBox.height - page.viewportSize().height)).toBeLessThan(1);
    await expect(notificationDialog).toHaveScreenshot('notification-drawer.png', visualContract);
    await notificationDialog.getByRole('button', { name: 'Close notifications' }).click();
  }
});

test('uses one bounded app chrome and scroll region on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile shell contract');
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable in the mobile shell contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));

  await page.goto('/assistants/');

  const shell = page.locator('[data-slot="workspace-shell"]');
  const header = page.locator('[data-slot="workspace-header"]');
  const main = page.locator('[data-slot="workspace-main"]');
  const tabs = page.locator('[data-slot="workspace-sidebar"]');
  const tabLinks = tabs.locator('nav').getByRole('link');
  await expect(shell).toHaveCSS('overflow', 'hidden');
  await expect(main).toHaveCSS('overflow-y', 'auto');
  await expect(tabs.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(tabLinks).toHaveCount(2);

  const [headerBox, mainBox, tabsBox, assistantTabBox, chatTabBox] = await Promise.all([
    header.boundingBox(),
    main.boundingBox(),
    tabs.boundingBox(),
    tabLinks.nth(0).boundingBox(),
    tabLinks.nth(1).boundingBox(),
  ]);
  expect(headerBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect(assistantTabBox).not.toBeNull();
  expect(chatTabBox).not.toBeNull();
  expect(Math.abs(headerBox.y)).toBeLessThan(1);
  expect(Math.abs(mainBox.y - (headerBox.y + headerBox.height))).toBeLessThan(1);
  expect(Math.abs((mainBox.y + mainBox.height) - tabsBox.y)).toBeLessThan(1);
  expect(Math.abs(tabsBox.y + tabsBox.height - page.viewportSize().height)).toBeLessThan(1);
  expect(Math.abs(tabsBox.x)).toBeLessThan(1);
  expect(Math.abs(tabsBox.width - page.viewportSize().width)).toBeLessThan(1);
  expect(assistantTabBox.height).toBeGreaterThanOrEqual(44);
  expect(chatTabBox.height).toBeGreaterThanOrEqual(44);
  expect(Math.abs(assistantTabBox.width - chatTabBox.width)).toBeLessThanOrEqual(1);

  const appbarButtons = header.getByRole('button');
  await expect(appbarButtons).toHaveCount(2);
  for (const button of await appbarButtons.all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }

  const contextError = main.locator('.context-error');
  const retry = contextError.getByRole('button');
  await expect(contextError).toBeVisible();
  await expect(retry).toBeVisible();
  const [errorBox, retryBox] = await Promise.all([contextError.boundingBox(), retry.boundingBox()]);
  expect(errorBox).not.toBeNull();
  expect(retryBox).not.toBeNull();
  expect(errorBox.y).toBeGreaterThanOrEqual(mainBox.y);
  expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(mainBox.y + mainBox.height);
  expect(retryBox.height).toBeGreaterThanOrEqual(44);

  const notificationTrigger = header.getByRole('button', { name: 'Open notifications. 0 unread.' });
  await notificationTrigger.click();
  const notificationDialog = page.getByRole('dialog', { name: 'Notifications' });
  await expect(notificationDialog).toBeVisible();
  const notificationBox = await notificationDialog.boundingBox();
  expect(notificationBox).not.toBeNull();
  expect(Math.abs(notificationBox.x)).toBeLessThan(1);
  expect(Math.abs(notificationBox.width - page.viewportSize().width)).toBeLessThan(1);
  expect(Math.abs(notificationBox.height - page.viewportSize().height)).toBeLessThan(1);
  await notificationDialog.getByRole('button', { name: 'Close notifications' }).click();
  await expect(notificationDialog).toBeHidden();

  const overflow = await page.locator('html').evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);

  const skip = page.locator('a[href="#admin-content"]');
  await skip.focus();
  const [skipBox, skipZIndex, headerZIndex] = await Promise.all([
    skip.boundingBox(),
    skip.evaluate((element) => Number.parseInt(getComputedStyle(element).zIndex, 10)),
    header.evaluate((element) => Number.parseInt(getComputedStyle(element).zIndex, 10)),
  ]);
  expect(skipBox).not.toBeNull();
  expect(skipBox.y).toBeGreaterThanOrEqual(0);
  expect(skipZIndex).toBeGreaterThan(headerZIndex);

  await header.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const rtlTabsBox = await tabs.boundingBox();
  expect(rtlTabsBox).not.toBeNull();
  expect(Math.abs(rtlTabsBox.x)).toBeLessThan(1);
  expect(Math.abs(rtlTabsBox.width - page.viewportSize().width)).toBeLessThan(1);

  await page.setViewportSize({ width: 320, height: 640 });
  await expect(tabLinks).toHaveCount(2);
  const narrowOverflow = await page.locator('html').evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(narrowOverflow.scroll).toBeLessThanOrEqual(narrowOverflow.client);
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

test('shows the installed Admin version when Local release status is temporarily unavailable', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));

  await page.goto('/assistants/');

  const status = page.getByText('Admin v0.1.0', { exact: true });
  await expect(status).toBeVisible();
  await expect(status.locator('..').locator('.indicator')).toHaveCSS('background-color', 'rgb(161, 161, 170)');
});

test('keeps the Local rollback warning visibly textual and localized', async ({ page }) => {
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
  await expect(release).toHaveCSS('color', 'rgb(255, 96, 125)');
  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: /Português/ }).click();
  await expect(release.getByText('Atualização revertida', { exact: true })).toBeVisible();
});

test('opens the Store destination workflow through shared modal controls', async ({ page }) => {
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
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route('**/api/teams/marketing/files', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ files: [] }),
  }));

  await page.goto('/assistants/');
  const storeFrame = page.locator('.store-frame');
  await expect(storeFrame).toHaveCSS('border-top-width', '0px');
  await expect(storeFrame).toHaveCSS('border-right-width', '0px');
  await expect(storeFrame).toHaveCSS('border-bottom-width', '0px');
  await expect(storeFrame).toHaveCSS('border-left-width', '0px');
  await expect(storeFrame).toHaveCSS('clip-path', 'none');
  const destination = page.getByRole('button', { name: /marketing/i });
  const destinationContext = page.locator('.destination-context');
  const destinationKicker = destinationContext.getByText('Installation destination', { exact: true });
  const removedDestinationLead = destinationContext.getByText(
    'Assistants listed below will be installed only in Team Marketing.',
    { exact: true },
  );
  const titleBlock = page.locator('.shimpz-page-intro > div').first();
  await expect(destination).toBeVisible();
  await expect(destinationKicker).toBeVisible();
  await expect(removedDestinationLead).toHaveCount(0);
  await expect(page.locator('.trust-boundary')).toHaveCount(0);
  await expect(titleBlock).toHaveText('Assistants');
  await expect(destination).toHaveCSS('border-top-width', '0px');
  await expect(destination).toHaveCSS('box-shadow', 'none');
  const [kickerBox, teamBox, changeBox, destinationBox, headingBox] = await Promise.all([
    destinationKicker.boundingBox(),
    destination.locator('.destination-name').boundingBox(),
    destination.locator('.destination-change').boundingBox(),
    destination.boundingBox(),
    page.getByRole('heading', { level: 1, name: 'Assistants' }).boundingBox(),
  ]);
  expect(kickerBox).not.toBeNull();
  expect(teamBox).not.toBeNull();
  expect(changeBox).not.toBeNull();
  expect(destinationBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  expect(kickerBox.y + kickerBox.height).toBeLessThanOrEqual(teamBox.y);
  expect(Math.abs(teamBox.x - kickerBox.x)).toBeLessThan(1);
  expect(changeBox.x - (teamBox.x + teamBox.width)).toBeGreaterThanOrEqual(10);
  if (page.viewportSize().width <= 680) {
    expect(destinationBox.y).toBeLessThan(headingBox.y);
  } else {
    expect(destinationBox.x).toBeLessThan(headingBox.x);
    expect(Math.abs(
      (headingBox.y + headingBox.height) - (destinationBox.y + destinationBox.height),
    )).toBeLessThan(1);
  }
  const intro = page.locator('.shimpz-page-intro');
  await expect(intro).toHaveCSS('border-bottom-width', '0px');
  expect(Number.parseFloat(await intro.evaluate(
    (element) => getComputedStyle(element).paddingBottom,
  ))).toBeGreaterThan(0);
  const [teamFontSize, headingFontSize] = await Promise.all([
    destination.locator('.destination-name').evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).fontSize),
    ),
    page.getByRole('heading', { level: 1, name: 'Assistants' }).evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).fontSize),
    ),
  ]);
  expect(teamFontSize).toBeGreaterThan(headingFontSize);
  const [introBox, storeBox] = await Promise.all([
    intro.boundingBox(),
    storeFrame.boundingBox(),
  ]);
  expect(introBox).not.toBeNull();
  expect(storeBox).not.toBeNull();
  expect(storeBox.y).toBeGreaterThanOrEqual(introBox.y + introBox.height);
  await expect(intro).toHaveScreenshot('store-destination.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await destination.click();

  const dialog = page.getByRole('dialog', { name: 'Choose a destination Team' });
  await expect(dialog).toBeVisible();
  const currentChoice = dialog.getByRole('button', { name: /marketing.*current/i });
  await expect(currentChoice).toBeVisible();
  await expect(dialog.getByRole('button', { name: /gestão.*gestao/i })).toBeVisible();
  const [dialogBox, markerBox, copyBox, metaBox] = await Promise.all([
    dialog.boundingBox(),
    currentChoice.locator('.marker').boundingBox(),
    currentChoice.locator('.copy').boundingBox(),
    currentChoice.locator('.meta').boundingBox(),
  ]);
  expect(dialogBox).not.toBeNull();
  expect(markerBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  expect(metaBox).not.toBeNull();
  expect(dialogBox.width).toBeLessThanOrEqual(512);
  expect(Math.abs((dialogBox.x + (dialogBox.width / 2)) - (page.viewportSize().width / 2)))
    .toBeLessThanOrEqual(1);
  expect(copyBox.x - (markerBox.x + markerBox.width)).toBeGreaterThanOrEqual(10);
  expect(metaBox.x).toBeGreaterThan(copyBox.x + copyBox.width);
  await expect(dialog).toHaveScreenshot('store-destination-dialog.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a destination Team' })).toBeHidden();

  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: 'Português' }).click();
  await expect(page.locator('iframe')).toHaveAttribute('src', /\/pt\/assistants\/embed/);
  await expect(page.getByText('Carregando a Store de Assistants…')).toBeVisible();

  await page.getByRole('button', { name: /Português/ }).click();
  await page.getByRole('menuitemradio', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.locator('.destination-trigger').click();
  const rtlChoice = page.locator('dialog.destination-dialog[open] .shimpz-choice-item.is-selected');
  const [rtlCopyBox, rtlMetaBox] = await Promise.all([
    rtlChoice.locator('.copy').boundingBox(),
    rtlChoice.locator('.meta').boundingBox(),
  ]);
  expect(rtlCopyBox).not.toBeNull();
  expect(rtlMetaBox).not.toBeNull();
  expect(rtlMetaBox.x + rtlMetaBox.width).toBeLessThan(rtlCopyBox.x);
});

test('installs an exact unpublished Local Assistant snapshot into the selected Team', async ({ page }) => {
  const imageId = `sha256:${'b'.repeat(64)}`;
  let installed = false;
  await page.route('https://shimpz.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body>Store test frame</body></html>',
  }));
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
  await page.route('**/api/local-assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      assistants: [{
        assistant_id: 'whatsapp',
        assistant_version: '0.1.0',
        created_at: '2026-08-28T17:00:00Z',
        image_id: imageId,
        platform: 'linux/amd64',
        provenance: 'local',
        unpublished: true,
      }],
      trace_id: 'c'.repeat(32),
    }),
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      assistants: installed
        ? [{ assistant: 'whatsapp', assistant_version: '0.1.0', status: 'running' }]
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
        staged_image_retained: imageId,
        remove_command: `docker image rm ${imageId}`,
      }),
    });
  });

  await page.goto('/assistants/');

  const panel = page.getByRole('region', { name: 'Staged on this machine' });
  await expect(panel).toContainText('Local snapshots are not published, reviewed, signed, or scanned by Shimpz.');
  await expect(panel).toContainText(imageId);
  await panel.getByRole('button', { name: 'Install or replace' }).click();
  await expect(panel.getByRole('button', { name: 'Installing…' })).toBeVisible();
  await expect(page.getByText('Local Assistant installed', { exact: true })).toBeVisible();
  await expect(page.getByText('whatsapp is ready in Marketing', { exact: false })).toBeVisible();

  const storeFrame = page.frames().find((frame) => frame.url().startsWith('https://shimpz.com/'));
  expect(storeFrame).toBeDefined();
  await storeFrame.evaluate(() => window.parent.postMessage({
    type: 'shimpz:assistant-uninstall',
    version: 2,
    assistant: 'whatsapp',
  }, '*'));
  await expect(page.getByRole('dialog', { name: 'Uninstall whatsapp?' })).toBeVisible();
  await page.getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByText('Assistant uninstalled', { exact: true })).toBeVisible();
  await expect(page.getByText(`docker image rm ${imageId}`, { exact: false })).toBeVisible();
});

test('keeps the Store destination guidance when no Team exists', async ({ page }) => {
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
  await page.route('https://shimpz.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body style="margin:0;background:#000"></body></html>',
  }));

  await page.goto('/assistants/');

  await expect(page.locator('.destination-name')).toHaveText('Choose a destination Team');
  await expect(page.locator('.destination-lead')).toHaveText(
    'Create a Team to give new Assistants a private destination.',
  );
});
