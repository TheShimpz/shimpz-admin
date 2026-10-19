// A running Browser task's screen in the built Admin (ADR-0117, over KasmVNC): while the turn's current step is the
// Browser, its display shows by itself under the progress, beside a full-screen toggle; the view only shows and sends the
// display no key, pointer, or clipboard, full screen shows it alone and returns it, and a task that ended says so.
import { expect, test } from '@playwright/test';

import { CLIENT_MESSAGES, rfbServer, solid } from './rfbServer.js';
import { BROWSER_VIEW } from './scenarios.js';
import { routeRead, routeScenario, sessionCalls } from './scenarioRoutes.js';
import { messages } from '../src/lib/i18n/catalogs.js';

const EN = messages.en.chatPage;
const WATCH = EN.progress.watch;
const STREAM = `**/api/teams/marketing/browser/views/${BROWSER_VIEW}/stream`;
const PAGE = [40, 120, 200];
const INPUT = new Set(Object.values(CLIENT_MESSAGES));

// Start a turn whose Browser task keeps running; its display draws one screen of PAGE and records what the page sends,
// until the test ends the task.
async function startTask(page, message = 'Open example.com and tell me its title.') {
  const scenario = await routeScenario(page, 'browser-watch');
  const display = { streams: [], closed: 0, ended: false };
  await routeRead(page, 'browser.view', () => (display.ended
    ? { status: 404, json: { detail: 'browser view unavailable', code: 'browser-not-running' } }
    : undefined));
  await page.routeWebSocket(STREAM, (socket) => {
    const server = rfbServer({ screen: ({ incremental }) => (incremental ? null : [solid(1280, 800, PAGE)]) });
    display.streams.push({ socket, server });
    socket.onMessage((message) => {
      for (const answer of server.receive(new Uint8Array(message))) socket.send(Buffer.from(answer));
    });
    socket.onClose(() => { display.closed += 1; });
    socket.send(Buffer.from(server.greeting));
  });
  await page.goto('/chat/?team=marketing');
  // noVNC admits a socket only when its own class names its methods and handlers, as the browser's WebSocket does;
  // Playwright's routed socket inherits them from a base class, so they are named on its own class too.
  await page.evaluate(() => {
    const own = window.WebSocket.prototype;
    const base = Object.getPrototypeOf(own);
    for (const [name, property] of Object.entries(Object.getOwnPropertyDescriptors(base))) {
      if (!Object.hasOwn(own, name)) Object.defineProperty(own, name, property);
    }
  });
  const composer = page.getByRole('textbox', { name: EN.send, exact: true });
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  await composer.fill(message);
  await composer.press('Enter');
  // The screen shows by itself once the turn's current step is the Browser task.
  await expect(page.getByRole('figure', { name: WATCH.title })).toBeVisible();
  return {
    scenario,
    display,
    end() {
      display.ended = true;
      for (const { socket } of display.streams) socket.close({ code: 4404, reason: '' });
    },
  };
}

// The colour noVNC drew at the middle of the view's screen.
function middlePixel(page) {
  return page.getByRole('img', { name: WATCH.alt }).locator('canvas').evaluate((canvas) => {
    const { data } = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1);
    return [...data.slice(0, 3)];
  });
}

test('the running task\'s screen shows by itself and is sent no input @browser-sensitive', async ({ page }) => {
  const { display } = await startTask(page);
  const view = page.getByRole('figure', { name: WATCH.title });
  const screen = view.getByRole('img', { name: WATCH.alt });
  await expect(screen).toBeVisible();
  await expect.poll(() => middlePixel(page)).toEqual(PAGE);
  expect((await sessionCalls(page)).filter((call) => call.method === 'browser.view')).toEqual([
    { method: 'browser.view', params: { team_id: 'marketing' } },
  ]);
  // Clicking, scrolling, and typing over the screen reach nothing in the task's page.
  const box = await screen.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await page.keyboard.type('typed');
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(300);
  expect(display.streams).toHaveLength(1);
  expect(display.streams[0].server.received.filter((type) => INPUT.has(type))).toEqual([]);
  await expect(view.getByRole('button')).toHaveCount(0);
  await expect(view.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: EN.stop, exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: WATCH.fullscreen, exact: true })).toBeEnabled();
});

test('full screen shows the task\'s screen alone and returns it to the chat', async ({ page }) => {
  await startTask(page);
  await expect.poll(() => middlePixel(page)).toEqual(PAGE);
  const screen = page.getByRole('img', { name: WATCH.alt });
  await page.getByRole('button', { name: WATCH.fullscreen, exact: true }).click();
  await expect.poll(() => screen.evaluate((element) => document.fullscreenElement?.contains(element) ?? false)).toBe(true);
  // The screen still shows the task's page while it fills the display.
  await expect.poll(() => middlePixel(page)).toEqual(PAGE);
  await page.getByRole('button', { name: WATCH.exitFullscreen, exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.getByRole('button', { name: WATCH.fullscreen, exact: true })).toBeVisible();
});

test('a task that ends while its screen is full screen says so there', async ({ page }) => {
  const { end } = await startTask(page);
  await expect.poll(() => middlePixel(page)).toEqual(PAGE);
  await page.getByRole('button', { name: WATCH.fullscreen, exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  end();
  const status = page.getByRole('figure', { name: WATCH.title }).getByRole('status');
  await expect(status).toHaveText(WATCH.ended);
  await expect(status).toBeVisible();
  expect(await status.evaluate((element) => document.fullscreenElement?.contains(element) ?? false)).toBe(true);
});

test('a task that ended says so and opens nothing more', async ({ page }) => {
  const { display, end } = await startTask(page);
  await expect.poll(() => middlePixel(page)).toEqual(PAGE);
  end();
  await expect(page.getByRole('figure', { name: WATCH.title }).getByRole('status')).toHaveText(WATCH.ended);
  await page.waitForTimeout(1_000);
  expect(display.streams).toHaveLength(1);
});

test('the screen that opens under a long message is scrolled to, as the message was', async ({ page }) => {
  const steps = Array.from({ length: 80 }, (_, index) => `${index + 1}. Open the next notice and read its deadline.`);
  await startTask(page, steps.join('\n'));
  // The reader follows the task from the progress line above its screen, without scrolling by hand.
  await expect(page.getByRole('button', { name: WATCH.fullscreen, exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('img', { name: WATCH.alt })).toBeInViewport({ ratio: 0.5 });
});
