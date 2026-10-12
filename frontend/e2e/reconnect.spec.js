// Admin's session socket while Admin cannot be reached (ADR-0114 decision 5): one place speaks about the connection,
// pages keep what they know and never show a connectivity failure or an empty state they do not know, reads wait for
// the socket and finish once it is back, changes stay disabled meanwhile, and the socket never stops reconnecting.
import { expect, test } from '@playwright/test';

import { publicAssistant } from './assistantPages.js';
import { messages } from '../src/lib/messages.js';
import { dropSessions, routeConnect, routeRead, routeScenario } from './scenarioRoutes.js';

const shell = messages.en.shell;
const chatPage = messages.en.chatPage;

// Refuses each session socket while `refusing()` holds, as a restarting or unreachable Admin does: the upgrade fails
// before the socket opens. Returns the count of refused sockets.
async function refuseWhile(page, refusing) {
  const refused = { count: 0 };
  await routeConnect(page, (socket) => {
    if (!refusing()) return true;
    refused.count += 1;
    socket.connectToServer();
    return false;
  });
  return refused;
}

// Every connectivity message a page could show besides the shell's own.
function pageConnectivityErrors(page) {
  return [
    page.getByText(chatPage.emptyTeams),
    page.getByText(chatPage.loadFailed),
    page.getByText(chatPage.disconnected),
    page.getByText(chatPage.connectionFailed),
    page.getByText('Admin is reconnecting.', { exact: false }),
  ];
}

test('a chat opened while Admin is unreachable shows no page error or empty state, and loads on its own once it is back', async ({ page }) => {
  await routeScenario(page, 'ready');
  let refusing = true;
  const refused = await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  await expect.poll(() => refused.count).toBeGreaterThan(1);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  for (const error of pageConnectivityErrors(page)) await expect(error).toHaveCount(0);

  refusing = false;
  const composer = page.getByRole('textbox', { name: chatPage.send, exact: true });
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator('.shell-sidebar').getByRole('link', { name: 'Marketing', exact: true })).toBeVisible();
  await expect(page.getByText(shell.reconnecting)).toHaveCount(0);
  for (const error of pageConnectivityErrors(page)) await expect(error).toHaveCount(0);
});

test('a long outage keeps reconnecting, says Admin cannot be reached, and recovers without a refresh', { tag: '@slow' }, async ({ page }) => {
  test.slow();
  await page.clock.install();
  await routeScenario(page, 'ready');
  let refusing = false;
  const refused = await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  const composer = page.getByRole('textbox', { name: chatPage.send, exact: true });
  await expect(composer).toBeEnabled();

  refusing = true;
  await dropSessions(page);
  // Five minutes of the page's own clock: far past the time a release swap takes.
  for (let second = 0; second < 300; second += 10) await page.clock.runFor(10_000);
  await expect(page.getByText(shell.reconnectFailed)).toBeVisible();
  await expect(page.getByText(shell.reconnecting)).toHaveCount(0);
  for (const error of pageConnectivityErrors(page)) await expect(error).toHaveCount(0);
  // Retries continue at a bounded pace: never given up, never more often than the backoff allows.
  const attempts = refused.count;
  for (let second = 0; second < 120; second += 10) await page.clock.runFor(10_000);
  expect(refused.count).toBeGreaterThan(attempts);
  expect(refused.count - attempts).toBeLessThan(12);

  refusing = false;
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return composer.isEnabled();
  }, { timeout: 30_000 }).toBe(true);
  await expect(page.getByText(shell.reconnectFailed)).toHaveCount(0);
});

test('an offline browser says so, and reconnects as soon as it is online again', async ({ page }) => {
  await page.clock.install();
  await routeScenario(page, 'ready');
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  const composer = page.getByRole('textbox', { name: chatPage.send, exact: true });
  await expect(composer).toBeEnabled();

  refusing = true;
  await page.context().setOffline(true);
  await dropSessions(page);
  await expect(page.getByText(shell.offline)).toBeVisible();
  await expect(page.getByText(shell.reconnecting)).toHaveCount(0);
  // Long enough on the page's clock for the backoff to reach its cap.
  for (let second = 0; second < 120; second += 10) await page.clock.runFor(10_000);

  refusing = false;
  await page.context().setOffline(false);
  // Coming online retries at once, without waiting out the backoff.
  await expect(composer).toBeEnabled();
  await expect(page.getByText(shell.offline)).toHaveCount(0);
});

test('a change stays disabled while Admin reconnects and is offered again once it is back', async ({ page }) => {
  await routeScenario(page, 'catalog');
  await routeRead(page, 'store.catalog', ({ locale }) => ({
    status: 200, json: { version: 1, locale, assistants: [publicAssistant({ assistant_id: 'shimpz-dns' })], next: null },
  }));
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/assistants/shimpz-dns?team=marketing');
  const install = page.getByRole('article').getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeEnabled();

  refusing = true;
  await dropSessions(page);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  await expect(install).toBeDisabled();

  refusing = false;
  await expect(install).toBeEnabled({ timeout: 20_000 });
});
