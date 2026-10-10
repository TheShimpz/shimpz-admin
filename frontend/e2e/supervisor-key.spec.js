import { expect, test } from '@playwright/test';

import { routeScenario } from './scenarioRoutes.js';
import { messages } from '../src/lib/messages.js';

// Replacing the Supervisor signing key (ADR-0051) against the built Admin with scenario fixtures (ADR-0087): Security
// confirms it with the password and a second factor, and says how Team answered.
const PASSWORD = 'violet otter lantern quartz 92';
const copy = messages.en.security;

function recordRequests(page) {
  const bodies = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/admin/supervisor-key')) bodies.push([url.pathname, request.postDataJSON()]);
  });
  return bodies;
}

async function replaceKey(page, password) {
  await page.getByRole('button', { name: copy.open }).click();
  const dialog = page.getByRole('dialog', { name: copy.title });
  await dialog.getByRole('region', { name: copy.keyLabel }).getByRole('button', { name: copy.rotate }).click();
  await dialog.getByLabel(copy.password).fill(password);
  await dialog.getByLabel(copy.code).fill('123456');
  await dialog.getByRole('button', { name: copy.rotate, exact: true }).click();
  return dialog;
}

test('Security replaces the signing key after the password and an authenticator code', async ({ page }) => {
  await routeScenario(page, 'supervisor-key');
  const sent = recordRequests(page);
  await page.goto('/chat/');

  const dialog = await replaceKey(page, 'wrong password');
  await expect(dialog.getByText(copy.passwordIncorrect)).toBeVisible();
  await dialog.getByLabel(copy.password).fill(PASSWORD);
  await dialog.getByRole('button', { name: copy.rotate, exact: true }).click();

  const key = dialog.getByRole('region', { name: copy.keyLabel });
  await expect(key.getByRole('status')).toContainText(copy.rotated);
  expect(sent).toEqual([
    ['/api/admin/supervisor-key/confirmation', { password: 'wrong password' }],
    ['/api/admin/supervisor-key/confirmation', { password: PASSWORD }],
    ['/api/admin/supervisor-key', { code: '123456' }],
  ]);
});

test('a replacement Team has not answered says the new key is kept and stays in the confirmation', async ({ page }) => {
  await routeScenario(page, 'supervisor-key-pending');
  await page.goto('/chat/');

  const dialog = await replaceKey(page, PASSWORD);
  await expect(dialog.getByRole('alert')).toContainText(copy.rotatePending);
  await expect(dialog.getByRole('button', { name: copy.rotate, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: copy.cancel }).click();
  await expect(dialog.getByRole('region', { name: copy.keyLabel }).getByRole('status')).toHaveCount(0);
});
