// Only the person's own input keeps the Supervisor session alive (ADR-0114): the page reports it on its session socket at
// most once a minute, never anything it does on its own.
import { expect, test } from '@playwright/test';

import { activityReports, raiseTopic, routeScenario } from './scenarioRoutes.js';

const MINUTE = 60_000;

async function openChat(page) {
  await page.clock.install();
  const scenario = await routeScenario(page);
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  await expect.poll(() => scenario.sessions.some((session) => session.subscribed('teams'))).toBe(true);
  return scenario;
}

test('nothing the page reads or receives on its own reports the person\'s activity', async ({ page }) => {
  await openChat(page);
  for (const topic of [
    'teams',
    'team/marketing/history',
    'team/marketing/routines',
    'space/resources',
    'platform/release',
    'security/summary',
    'session',
  ]) {
    await raiseTopic(page, topic);
  }
  await page.clock.fastForward(5 * MINUTE);
  await raiseTopic(page, 'team/marketing/history');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  expect(await activityReports(page)).toBe(0);
});

test('keyboard input alone reports the person\'s activity, at most once a minute', async ({ page }) => {
  await openChat(page);
  await page.keyboard.press('Tab');
  await expect.poll(() => activityReports(page)).toBe(1);
  await page.keyboard.press('Tab');
  await page.keyboard.type('hi');
  await page.clock.fastForward(30_000);
  await page.keyboard.press('Shift+Tab');
  expect(await activityReports(page)).toBe(1);
  // A minute after the last report, the next keystroke reports again.
  await page.clock.fastForward(MINUTE);
  await page.keyboard.press('Tab');
  await expect.poll(() => activityReports(page)).toBe(2);
});

test('a pointer reports the person\'s activity', async ({ page }) => {
  await openChat(page);
  await page.getByRole('textbox', { name: 'Send', exact: true }).click();
  await expect.poll(() => activityReports(page)).toBe(1);
});

test('events the page dispatches itself never report activity', async ({ page }) => {
  await openChat(page);
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  for (const type of ['keydown', 'pointerdown', 'click', 'touchstart', 'wheel', 'input', 'compositionend']) {
    await composer.dispatchEvent(type);
  }
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    document.body.click();
  });
  await page.clock.fastForward(1_000);
  expect(await activityReports(page)).toBe(0);
});
