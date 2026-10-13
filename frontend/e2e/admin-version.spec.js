// The Admin version the sidebar names is the one both this page and the Admin it reaches were built from: Admin names
// its commit on every session socket as it opens, and a page built from another commit, such as a tab left open across
// an update, says so over every page and reloads only when the person asks.
import { expect, test } from '@playwright/test';

import { messages } from '../src/lib/i18n/catalogs.js';
import { buildVersion } from '../src/lib/space/version.js';
import { dropSessions, routeScenario, routeSourceRevision } from './scenarioRoutes.js';
import { SOURCE_TIME } from './sessionSocket.js';

// The commit this build names: the gate builds and runs the suite with the same SOURCE_DATE_EPOCH and SOURCE_REVISION.
const OWN = process.env.SOURCE_REVISION ?? '';
const OTHER = OWN === 'b'.repeat(40) ? 'c'.repeat(40) : 'b'.repeat(40);
const reload = { name: messages.en.shell.versionReload };
// The bar names the version of the Admin the page reaches.
const staleNotice = (page) => page.getByRole('status').filter({
  hasText: messages.en.shell.versionStale.replace('{version}', buildVersion(String(SOURCE_TIME), OTHER)),
});

test.beforeEach(() => {
  expect(OWN, 'the suite runs against a build that names its commit (SOURCE_REVISION)').toMatch(/^[0-9a-f]{40}$/);
});

function shownVersion(page) {
  return page.getByText(`Admin ${buildVersion(process.env.SOURCE_DATE_EPOCH, OWN)}`, { exact: true });
}

test('an Admin built from this page\'s commit shows the version', async ({ page }) => {
  await routeSourceRevision(page, OWN);
  await routeScenario(page, 'ready');
  await page.goto('/chat/?team=marketing');

  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
  await expect(shownVersion(page)).toBeVisible();
  await expect(page.getByRole('button', reload)).toHaveCount(0);
  await expect(staleNotice(page)).toHaveCount(0);
});

test('a page built from another commit than Admin offers a reload, and only its click reloads', { tag: '@mobile' }, async ({ page }) => {
  await routeSourceRevision(page, OTHER);
  await routeScenario(page, 'ready');
  await page.goto('/chat/?team=marketing');

  const notice = page.getByRole('button', reload);
  await expect(staleNotice(page)).toBeVisible();
  await expect(notice).toBeVisible();
  await page.evaluate(() => { window.shimpzBeforeReload = true; });
  // The page stays as it is until the person asks: a reload would lose a draft or a turn under way.
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('A draft');
  expect(await page.evaluate(() => window.shimpzBeforeReload)).toBe(true);

  const reloaded = page.waitForEvent('load');
  await notice.click();
  await reloaded;
  expect(await page.evaluate(() => window.shimpzBeforeReload)).toBeUndefined();
  await expect(page.getByRole('button', reload)).toBeVisible();
});

test('a reconnect that reaches an Admin built from another commit says so over the page', async ({ page }) => {
  await routeSourceRevision(page, OWN);
  await routeScenario(page, 'ready');
  await page.goto('/chat/?team=marketing');
  await expect(shownVersion(page)).toBeVisible();

  // An update replaces Admin: the socket drops and reopens on the new Admin, which names its own commit.
  await routeSourceRevision(page, OTHER);
  await dropSessions(page, 1012);

  await expect(staleNotice(page)).toBeVisible();
  await expect(page.getByRole('button', reload)).toBeVisible();
});
