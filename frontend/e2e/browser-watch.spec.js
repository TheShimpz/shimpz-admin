// Watching a running Browser task's screen in the built Admin (ADR-0117, M2 Watch): while the turn's current step is the
// Browser, Watch opens an inline view of its frames under the progress, with Stop still in reach; the view only shows,
// Close stops asking for frames, and a task that ended says so.
import { expect, test } from '@playwright/test';

import { png } from './png.js';
import { BROWSER_VIEW } from './scenarios.js';
import { routeScenario, sessionCalls } from './scenarioRoutes.js';
import { messages } from '../src/lib/i18n/catalogs.js';

const EN = messages.en.chatPage;
const WATCH = EN.progress.watch;
const FRAMES = `**/api/teams/marketing/browser/views/${BROWSER_VIEW}/frames/*`;
const FRAME = png(1280, 800, [240, 240, 236], [40, 120, 200]);

// Start a turn whose Browser task keeps running; Team's frames answer each cursor with the next frame, after a short
// wait as Team's own wait for a newer frame, until the test ends the task.
async function startTask(page) {
  const scenario = await routeScenario(page, 'browser-watch');
  const asked = [];
  let ended = false;
  await page.route(FRAMES, async (route) => {
    const after = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    asked.push(after);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (ended) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'browser view unavailable', code: 'browser-not-running' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'x-shimpz-browser-frame': String(after + 1), 'cache-control': 'no-store' },
      body: FRAME,
    });
  });
  await page.goto('/chat/?team=marketing');
  const composer = page.getByRole('textbox', { name: EN.send, exact: true });
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  await composer.fill('Open example.com and tell me its title.');
  await composer.press('Enter');
  // The Watch button appears once the turn's current step is the Browser task.
  await expect(page.getByRole('button', { name: WATCH.open, exact: true })).toBeVisible();
  return { scenario, asked, end: () => { ended = true; } };
}

test('watching shows the running task\'s screen while Stop stays in reach @browser-sensitive', async ({ page }) => {
  const { asked } = await startTask(page);
  const watch = page.getByRole('button', { name: WATCH.open, exact: true });
  await watch.click();
  const view = page.getByRole('figure', { name: WATCH.title });
  await expect(view.getByRole('img', { name: WATCH.alt })).toBeVisible();
  await expect.poll(() => asked.length).toBeGreaterThan(2);
  // Each request names the last frame the page shows, so it only ever receives a newer one.
  expect(asked.slice(0, 3)).toEqual([0, 1, 2]);
  expect((await sessionCalls(page)).filter((call) => call.method === 'browser.view')).toEqual([
    { method: 'browser.view', params: { team_id: 'marketing' } },
  ]);
  // The view only shows the page: nothing in it can be pressed or typed into.
  await expect(view.getByRole('button')).toHaveCount(0);
  await expect(view.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: EN.stop, exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: WATCH.close, exact: true })).toHaveAttribute('aria-expanded', 'true');
});

test('closing the view stops asking for frames', async ({ page }) => {
  const { asked } = await startTask(page);
  await page.getByRole('button', { name: WATCH.open, exact: true }).click();
  await expect(page.getByRole('img', { name: WATCH.alt })).toBeVisible();
  await page.getByRole('button', { name: WATCH.close, exact: true }).click();
  await expect(page.getByRole('figure', { name: WATCH.title })).toHaveCount(0);
  const settled = asked.length;
  await page.waitForTimeout(1_000);
  expect(asked.length).toBeLessThanOrEqual(settled + 1);
});

test('a task that ended says so and asks for nothing more', async ({ page }) => {
  const { asked, end } = await startTask(page);
  await page.getByRole('button', { name: WATCH.open, exact: true }).click();
  await expect(page.getByRole('img', { name: WATCH.alt })).toBeVisible();
  end();
  await expect(page.getByRole('figure', { name: WATCH.title }).getByRole('status')).toHaveText(WATCH.ended);
  const settled = asked.length;
  await page.waitForTimeout(1_000);
  expect(asked.length).toBe(settled);
});
