import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe.js';
import { routeScenario } from './scenarioRoutes.js';
import { recoveryCodeSet } from './securityScenarios.js';

// Recovery codes (ADR-0051) against the built Admin with scenario fixtures (ADR-0087): shown once at enrollment, a sign-in
// with one begins the authenticator's re-enrollment, and Security replaces them all after a confirmation.
const PASSWORD = 'violet otter lantern quartz 92';
const ADMIN_OPEN = /^(New Team|Open the Team list)$/;

function recordRequests(page, pattern) {
  const bodies = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (pattern.test(url.pathname)) bodies.push([url.pathname, request.postDataJSON()]);
  });
  return bodies;
}

test('first setup shows the recovery codes once, to copy or download, before Admin opens', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await routeScenario(page, 'setup');
  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Six-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveText(recoveryCodeSet(0));
  // The recovery-codes screen's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download codes' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('shimpz-recovery-codes.txt');
  const saved = await readFile(await file.path(), 'utf8');
  expect(saved.trim().split('\n').slice(-10)).toEqual(recoveryCodeSet(0));
  await page.getByRole('button', { name: 'Copy codes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Codes copied.' })).toBeVisible();
  expect((await page.evaluate(() => navigator.clipboard.readText())).trim().split('\n').slice(-10))
    .toEqual(recoveryCodeSet(0));

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: ADMIN_OPEN })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recovery codes' })).toHaveCount(0);
});

test('a recovery code signs in only through a new authenticator and shows a new set of codes', async ({ page }) => {
  await routeScenario(page, 'sign-in');
  const sent = recordRequests(page, /^\/api\/login/);
  await page.goto('/');

  async function password() {
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  await password();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByRole('textbox', { name: 'Recovery code' }).fill('aaaa-bbbb-cccc');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('That recovery code was not accepted');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();

  await password();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(recoveryCodeSet(0)[3].toUpperCase());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your authenticator again' })).toBeVisible();
  await expect(page.getByAltText('QR code for the Shimpz Supervisor authenticator')).toHaveAttribute('src', /^data:image\/png;base64,/);

  // A mistyped code keeps the re-enrollment open.
  await page.getByLabel('Six-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page.getByRole('alert')).toContainText('That code was not accepted');
  await page.getByLabel('Six-digit code').fill('654321');
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveText(recoveryCodeSet(1));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: ADMIN_OPEN })).toBeVisible();
  expect(sent).toEqual([
    ['/api/login', { password: PASSWORD }],
    ['/api/login/recovery', { code: 'aaaa-bbbb-cccc' }],
    ['/api/login', { password: PASSWORD }],
    ['/api/login/recovery', { code: recoveryCodeSet(0)[3].toUpperCase() }],
    ['/api/login/recovery/totp', { code: '000000' }],
    ['/api/login/recovery/totp', { code: '654321' }],
  ]);
});

test('until the authenticator is enrolled again, a sign-in asks only for another recovery code', async ({ page }) => {
  const scenario = await routeScenario(page, 'sign-in');
  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(recoveryCodeSet(0)[0]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your authenticator again' })).toBeVisible();

  await page.reload();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('textbox', { name: 'Recovery code' })).toBeVisible();
  await expect(page.getByLabel('Six-digit code')).toHaveCount(0);
  expect(scenario.respond({ method: 'POST', path: '/api/session' }).json.authenticated).toBe(false);
});

test('Security replaces every recovery code after the password and an authenticator code', async ({ page }) => {
  await routeScenario(page, 'recovery-codes');
  const sent = recordRequests(page, /^\/api\/admin\/recovery-codes/);
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Security' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign-in security' });
  await expect(dialog).toContainText('2 of 10');
  await dialog.getByRole('button', { name: 'Generate new codes' }).click();
  await dialog.getByLabel('Supervisor password').fill('wrong password');
  await dialog.getByLabel('Six-digit code').fill('123456');
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(dialog.getByText('The Supervisor password is incorrect.')).toBeVisible();

  await dialog.getByLabel('Supervisor password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveText(recoveryCodeSet(1));
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).toContainText('10 of 10');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Security' })).toBeFocused();
  expect(sent).toEqual([
    ['/api/admin/recovery-codes/confirmation', { password: 'wrong password' }],
    ['/api/admin/recovery-codes/confirmation', { password: PASSWORD }],
    ['/api/admin/recovery-codes', { code: '123456' }],
  ]);
});
