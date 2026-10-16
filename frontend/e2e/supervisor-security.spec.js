import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe.js';
import { readsOf, routeRead, routeScenario } from './scenarioRoutes.js';

// The Supervisor's own sign-in security (ADR-0051), against the built Admin with scenario fixtures (ADR-0087).

test('refused second-factor codes stay reported across reloads until the Supervisor acknowledges them', async ({ page }) => {
  await routeScenario(page, 'security-alert');

  await page.goto('/chat/');
  const report = page.getByRole('status').filter({ hasText: 'Failed sign-in attempts' });
  await expect(report).toContainText(': 3.');
  await page.reload();
  await expect(report).toContainText(': 3.');

  await report.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(report).toHaveCount(0);
  // The acknowledgment goes over the session socket (ADR-0114).
  expect(await readsOf(page, 'security.acknowledge')).toEqual([{ body: { acknowledged: 3 } }]);
  await page.reload();
  await expect(page.getByRole('button', { name: /^(New Team|Open the Team list)$/ })).toBeVisible();
  await expect(report).toHaveCount(0);
});

test('an acknowledgment that cannot be saved keeps the report and says so', async ({ page }) => {
  await routeScenario(page, 'security-alert');
  await routeRead(page, 'security.acknowledge', () => ({ status: 503, json: { detail: 'unavailable' } }));

  await page.goto('/chat/');
  const report = page.getByRole('status').filter({ hasText: 'Failed sign-in attempts' });
  const acknowledge = report.getByRole('button', { name: 'Acknowledge' });
  await acknowledge.click();

  await expect(page.getByRole('alert')).toContainText('couldn’t be saved');
  await expect(report).toContainText(': 3.');
  // The request disabled Acknowledge, which takes the focus back for another try.
  await expect(acknowledge).toBeFocused();
});

test('an acknowledgment that fails after the person pressed elsewhere gives nothing the focus', async ({ page }) => {
  await routeScenario(page, 'security-alert');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await routeRead(page, 'security.acknowledge', async () => {
    await held;
    return { status: 503, json: { detail: 'unavailable' } };
  });

  await page.goto('/chat/');
  const report = page.getByRole('status').filter({ hasText: 'Failed sign-in attempts' });
  const acknowledge = report.getByRole('button');
  await acknowledge.click();
  await expect(acknowledge).toBeDisabled();
  // A press on the Admin version, which nothing focuses, leaves the focus on the document, as the person chose.
  await page.getByText(/^Admin (?:dev|v\d)/).click();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  release();
  await expect(page.getByRole('alert')).toContainText('couldn’t be saved');
  await expect(acknowledge).toBeEnabled();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('an acknowledgment that fails after the person moved the focus out of the alert gives nothing the focus', async ({ page }) => {
  await routeScenario(page, 'security-alert');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await routeRead(page, 'security.acknowledge', async () => {
    await held;
    return { status: 503, json: { detail: 'unavailable' } };
  });

  await page.goto('/chat/');
  const report = page.getByRole('status').filter({ hasText: 'Failed sign-in attempts' });
  const acknowledge = report.getByRole('button');
  await acknowledge.click();
  await expect(acknowledge).toBeDisabled();
  // The person moved the focus out of the alert; once it falls to the document again without a press, the alert's
  // Acknowledge, enabled again, still leaves it there.
  const supervisor = page.getByRole('button', { name: 'Supervisor' });
  await supervisor.focus();
  await supervisor.evaluate((element) => element.blur());
  release();
  await expect(page.getByRole('alert')).toContainText('couldn’t be saved');
  await expect(acknowledge).toBeEnabled();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('Security names the previous sign-in, where it came from, and the failed attempts since', async ({ page }) => {
  await routeScenario(page, 'security-alert');
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Supervisor' }).click();
  await page.getByRole('menuitem', { name: 'Security' }).click();
  const signIns = page.getByRole('dialog', { name: 'Sign-in security' }).getByRole('region', { name: 'Sign-ins' });
  await expect(signIns).toContainText('https://admin.example.com');
  await expect(signIns).toContainText(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date('2026-10-08T21:14:00Z')));
  await expect(signIns).toContainText(': 4.');
  // The Security dialog's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);
});
