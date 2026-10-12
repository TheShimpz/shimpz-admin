import { expect, test } from '@playwright/test';

import { dropSessions, readsOf, routeRead, routeScenario, sessionCalls, waitForRead } from './scenarioRoutes.js';
import { messages } from '../src/lib/messages.js';

// Replacing the Supervisor signing key (ADR-0051) against the built Admin with scenario fixtures (ADR-0087): Security
// confirms it with the password and a second factor, and says how Team answered.
const PASSWORD = 'violet otter lantern quartz 92';
const copy = messages.en.security;

// The signing key operations the page asked for over its session socket (ADR-0114), in order.
async function keyCalls(page) {
  return (await sessionCalls(page)).filter((call) => call.method.startsWith('supervisor_key.'))
    .map((call) => [call.method, call.params.body]);
}

async function replaceKey(page, password) {
  await page.getByRole('button', { name: 'Supervisor' }).click();
  await page.getByRole('menuitem', { name: copy.open }).click();
  const dialog = page.getByRole('dialog', { name: copy.title });
  await dialog.getByRole('region', { name: copy.keyLabel }).getByRole('button', { name: copy.rotate }).click();
  await dialog.getByLabel(copy.password).fill(password);
  await dialog.getByLabel(copy.code).fill('123456');
  await dialog.getByRole('button', { name: copy.rotate, exact: true }).click();
  return dialog;
}

test('Security replaces the signing key after the password and an authenticator code', async ({ page }) => {
  await routeScenario(page, 'supervisor-key');
  await page.goto('/chat/');

  const dialog = await replaceKey(page, 'wrong password');
  await expect(dialog.getByText(copy.passwordIncorrect)).toBeVisible();
  await dialog.getByLabel(copy.password).fill(PASSWORD);
  await dialog.getByRole('button', { name: copy.rotate, exact: true }).click();

  const key = dialog.getByRole('region', { name: copy.keyLabel });
  await expect(key.getByRole('status')).toContainText(copy.rotated);
  expect(await keyCalls(page)).toEqual([
    ['supervisor_key.confirmation', { password: 'wrong password' }],
    ['supervisor_key.confirmation', { password: PASSWORD }],
    ['supervisor_key.rotate', { code: '123456' }],
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

test('a replacement whose answer was lost says its outcome is unknown and is never sent again', async ({ page }) => {
  await routeScenario(page, 'supervisor-key');
  // Admin receives the confirmed replacement over the session socket, and the connection drops before it answers.
  await routeRead(page, 'supervisor_key.rotate', () => new Promise(() => {}));
  await page.goto('/chat/');

  const dialog = await replaceKey(page, PASSWORD);
  await waitForRead(page, 'supervisor_key.rotate');
  await dropSessions(page);
  await expect(dialog.getByRole('alert')).toContainText(messages.en.shell.outcomeUnknown);
  expect(await readsOf(page, 'supervisor_key.rotate')).toHaveLength(1);
});
