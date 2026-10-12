// Only the person's own input keeps the Supervisor session alive (ADR-0114): the page reports it on its session socket at
// most once a minute, never anything it does on its own, and warns shortly before an idle session ends.
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

test('a session about to idle out warns first, and staying signed in renews it', async ({ page }) => {
  const scenario = await openChat(page);
  const [session] = scenario.sessions;
  // Admin answers the person's report with the session's renewed deadlines.
  session.onActivity = () => {
    return { idle_seconds: 3600, absolute_seconds: 80_000 };
  };
  session.deadlines(150, 80_000);
  const warning = page.getByRole('alertdialog', { name: 'Your session is about to end' });
  await page.clock.fastForward(20_000);
  await expect(warning).toHaveCount(0);
  // Two minutes before the idle deadline, the person is asked, with the one action focused.
  await page.clock.fastForward(15_000);
  await expect(warning).toBeVisible();
  const stay = warning.getByRole('button', { name: 'Stay signed in' });
  await expect(stay).toBeFocused();
  await stay.click();
  await expect(warning).toBeHidden();
  await expect.poll(() => activityReports(page)).toBe(1);
  // The renewed deadline is an hour away: no warning until two minutes before it.
  await page.clock.fastForward(30 * MINUTE);
  await expect(warning).toHaveCount(0);
});

test('the warning answers the keyboard alone', async ({ page }) => {
  const scenario = await openChat(page);
  const [session] = scenario.sessions;
  session.onActivity = () => ({ idle_seconds: 3600, absolute_seconds: 80_000 });
  session.deadlines(100, 80_000);
  const warning = page.getByRole('alertdialog', { name: 'Your session is about to end' });
  await expect(warning).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(warning).toBeHidden();
  await expect.poll(() => activityReports(page)).toBe(1);
});

test('a session that reaches its absolute expiry first is not warned about', async ({ page }) => {
  const scenario = await openChat(page);
  scenario.sessions[0].deadlines(150, 100);
  await page.clock.fastForward(60_000);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
