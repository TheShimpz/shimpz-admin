import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe.js';
import { routeScenario } from './scenarioRoutes.js';

// The Supervisor's own sign-in security (ADR-0051), against the built Admin with scenario fixtures (ADR-0087).

test('refused second-factor codes stay reported across reloads until the Supervisor acknowledges them', async ({ page }) => {
  await routeScenario(page, 'security-alert');
  const acknowledgments = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/admin/security/failures')) acknowledgments.push(request.postDataJSON());
  });

  await page.goto('/chat/');
  const report = page.getByRole('status').filter({ hasText: 'Failed sign-in attempts' });
  await expect(report).toContainText(': 3.');
  await page.reload();
  await expect(report).toContainText(': 3.');

  await report.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(report).toHaveCount(0);
  expect(acknowledgments).toEqual([{ acknowledged: 3 }]);
  await page.reload();
  await expect(page.getByRole('button', { name: /^(New Team|Open the Team list)$/ })).toBeVisible();
  await expect(report).toHaveCount(0);
});

test('an acknowledgment that cannot be saved keeps the report and says so', async ({ page }) => {
  await routeScenario(page, 'security-alert');
  await page.route('**/api/admin/security/failures', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'unavailable' }),
  }));

  await page.goto('/chat/');
  const report = page.getByRole('status').filter({ hasText: 'Failed sign-in attempts' });
  await report.getByRole('button', { name: 'Acknowledge' }).click();

  await expect(page.getByRole('alert')).toContainText('couldn’t be saved');
  await expect(report).toContainText(': 3.');
});

test('Security names the previous sign-in, where it came from, and the failed attempts since', async ({ page }) => {
  await routeScenario(page, 'security-alert');
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Security' }).click();
  const signIns = page.getByRole('dialog', { name: 'Sign-in security' }).getByRole('region', { name: 'Sign-ins' });
  await expect(signIns).toContainText('https://admin.example.com');
  await expect(signIns).toContainText(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date('2026-10-08T21:14:00Z')));
  await expect(signIns).toContainText(': 4.');
  // The Security dialog's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);
});
