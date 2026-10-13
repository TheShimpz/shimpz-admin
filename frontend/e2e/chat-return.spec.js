// Returning to a Team's chat (ADR-0114, values a session keeps): the session keeps each recently shown Team's
// conversation, so the chat opens it at once, checks it is still current, and only then attaches its channel; Send
// still waits for the channel and a fresh inventory.
import { expect, test } from '@playwright/test';

import { messages } from '../src/lib/i18n/catalogs.js';
import { raiseTopic, readsOf, routeChat, routeRead, routeScenario, sessionFrames } from './scenarioRoutes.js';

const chatPage = messages.en.chatPage;
const AT = '2026-10-01T12:00:00Z';
const ok = (json) => ({ status: 200, json });
const rowId = (number) => number.toString(16).padStart(32, '0');
const question = (number) => ({
  id: `${rowId(number)}:user`, created_at: AT, kind: 'message', role: 'user', text: `Question ${number}`,
});
const answer = (number, author = 'Marketing') => ({
  id: `${rowId(number)}:reply`, created_at: AT, kind: 'message', role: 'assistant', author, text: `Answer ${number}`,
});
const exchanges = (from, to, author) => Array.from({ length: to - from + 1 }, (_, index) => [
  question(from + index), answer(from + index, author),
]).flat();

// Marketing's chat history: `pages` maps a cursor (null for the newest page) to `{ entries, before }`, and `answer`
// may replace an answer (a promise holds it); every other Team keeps what the scenario answers.
async function routeHistory(page, history) {
  await routeRead(page, 'history.page', async (params) => {
    if (params.team_id !== 'marketing' || params.routine) return undefined;
    return (await history.answer?.(params)) ?? ok(history.pages[params.before ?? null]);
  });
}

// Marketing's chat channel: each attach synchronizes it, at once or, while `holding`, once `release()` is called.
async function routeSync(page) {
  const sync = { holding: false, waiting: [] };
  sync.release = () => {
    sync.holding = false;
    for (const send of sync.waiting.splice(0)) send();
  };
  await routeChat(page, 'marketing', (channel) => {
    channel.onMessage((text) => {
      if (JSON.parse(text).type !== 'sync') return;
      const send = () => channel.send({ type: 'sync-empty' });
      if (sync.holding) sync.waiting.push(send);
      else send();
    });
  });
  return sync;
}

async function attaches(page) {
  return (await sessionFrames(page)).filter((frame) => frame.type === 'call' && frame.method === 'chat.attach').length;
}

const composer = (page) => page.getByRole('textbox', { name: chatPage.send, exact: true });
const sidebar = (page) => page.locator('.shell-sidebar');

async function openChat(page) {
  await page.goto('/chat/?team=marketing');
  await expect(composer(page)).toBeEnabled();
}

async function leaveForStore(page) {
  await sidebar(page).getByRole('link', { name: 'Open the Store for Marketing' }).click();
  await expect(page).toHaveURL(/\/assistants\/?\?/);
  await expect(composer(page)).toHaveCount(0);
}

async function returnToChat(page, team = 'Marketing') {
  await sidebar(page).getByRole('link', { name: team, exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/?\?/);
}

test('a chat opened again from the Store shows its conversation at once, and takes a message once its channel is ready', async ({ page }) => {
  await routeScenario(page, 'ready');
  await routeHistory(page, { pages: { null: { entries: exchanges(1, 3), before: null } } });
  const sync = await routeSync(page);
  await openChat(page);
  const historyReads = (await readsOf(page, 'history.page')).length;
  await leaveForStore(page);
  // The channel's next synchronization is held.
  sync.holding = true;
  await returnToChat(page);
  // The conversation is there and readable before the channel synchronizes, and nothing of it was read again.
  await expect(page.getByText('Answer 3', { exact: true })).toBeVisible();
  await expect(page.locator('.conversation')).not.toHaveAttribute('inert', '');
  expect((await readsOf(page, 'history.page')).length).toBe(historyReads);
  await expect(composer(page)).toBeDisabled();
  sync.release();
  await expect(composer(page)).toBeEnabled();
});

test('history written while away is read on return, and the channel attaches only once that read succeeded', async ({ page }) => {
  await routeScenario(page, 'ready');
  // Another tab asked a question that was still waiting for its reply when this tab left the chat.
  const history = { pages: { null: { entries: [...exchanges(1, 3), question(4)], before: null } } };
  await routeHistory(page, history);
  await openChat(page);
  await expect(page.getByText('Question 4', { exact: true })).toBeVisible();
  await leaveForStore(page);
  const attached = await attaches(page);
  // Its reply is written while this tab is away; the first read of it on return fails, and the one after succeeds.
  history.pages = { null: { entries: [...exchanges(1, 4)], before: null } };
  let failures = 1;
  history.answer = () => (failures-- > 0 ? { status: 503, json: { detail: 'Synthetic history outage.' } } : undefined);
  await raiseTopic(page, 'team/marketing/history');
  await returnToChat(page);
  // The kept conversation stays readable and says the history could not be read; the channel waits.
  await expect(page.getByText('Question 4', { exact: true })).toBeVisible();
  await expect(page.getByText(chatPage.loadFailed)).toBeVisible();
  await expect(composer(page)).toBeDisabled();
  expect(await attaches(page)).toBe(attached);
  // The read again succeeds: the reply joins its question, the notice leaves, and only then does the channel attach.
  await expect(page.getByText('Answer 4', { exact: true })).toBeVisible();
  await expect(composer(page)).toBeEnabled();
  await expect(page.getByText(chatPage.loadFailed)).toHaveCount(0);
  expect(await attaches(page)).toBe(attached + 1);
});

test('a kept conversation that grows past what a session keeps opens from the newest page before the channel attaches', async ({ page }) => {
  await routeScenario(page, 'ready');
  const history = { pages: { null: { entries: exchanges(1, 2), before: null } } };
  await routeHistory(page, history);
  await openChat(page);
  await leaveForStore(page);
  const attached = await attaches(page);
  // 316 rows are written while away: five pages back to the rows this tab read.
  const cursor = (index) => `AAAAAAAA0${index}A`;
  const written = exchanges(3, 160);
  const newest = written.slice(-64);
  history.pages = {
    null: { entries: newest, before: cursor(1) },
    [cursor(1)]: { entries: written.slice(-128, -64), before: cursor(2) },
    [cursor(2)]: { entries: written.slice(-192, -128), before: cursor(3) },
    [cursor(3)]: { entries: written.slice(-256, -192), before: cursor(4) },
    [cursor(4)]: { entries: [...exchanges(1, 2), ...written.slice(0, 60)], before: null },
  };
  const restarts = [];
  const held = new Promise((resolve) => { history.releaseRestart = resolve; });
  history.answer = (params) => {
    if (params.before) return undefined;
    restarts.push(params);
    // The second newest-page read is the restart: it is held until the test checks nothing attached before it.
    return restarts.length === 2 ? held.then(() => ok(history.pages.null)) : undefined;
  };
  await raiseTopic(page, 'team/marketing/history');
  await returnToChat(page);
  await expect.poll(() => restarts.length).toBe(2);
  expect(await attaches(page)).toBe(attached);
  await expect(composer(page)).toBeDisabled();
  history.releaseRestart();
  await expect(page.getByText('Answer 160', { exact: true })).toBeVisible();
  await expect(composer(page)).toBeEnabled();
  expect(await attaches(page)).toBe(attached + 1);
  // The newest page opened the conversation: none of the rows this tab first read is on screen.
  await expect(page.getByText('Answer 1', { exact: true })).toHaveCount(0);
});

test("each Team's kept conversation is its own, and switching back to one sends once its inventory is read", async ({ page }) => {
  await routeScenario(page, 'ready');
  let inventory = null;
  await routeRead(page, 'assistants.list', async (params) => {
    if (inventory && params.team_id === 'marketing') await inventory;
    return undefined;
  });
  await routeHistory(page, { pages: { null: { entries: exchanges(1, 2), before: null } } });
  await routeRead(page, 'history.page', (params) => (params.team_id === 'trinity' && !params.routine
    ? ok({ entries: [{ ...question(90), text: 'Trinity question' }, { ...answer(90, 'Trinity'), text: 'Trinity answer' }], before: null })
    : undefined));
  await openChat(page);
  await returnToChat(page, 'Trinity');
  await expect(page.getByText('Trinity answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Answer 2', { exact: true })).toHaveCount(0);
  const reads = (await readsOf(page, 'history.page')).length;
  // Marketing's inventory, read again as it is selected, is held.
  let releaseInventory;
  inventory = new Promise((resolve) => { releaseInventory = resolve; });
  await returnToChat(page);
  await expect(page.getByText('Answer 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Trinity answer', { exact: true })).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
  expect((await readsOf(page, 'history.page')).length).toBe(reads);
  // A message waits for the Team's inventory.
  await composer(page).fill('Check the zones');
  const send = page.locator('.composer-send');
  await expect(send).toBeDisabled();
  releaseInventory();
  await expect(send).toBeEnabled();
});

test('a page restored from the back-forward cache forgets the kept conversations and reads them again', async ({ page }) => {
  await routeScenario(page, 'ready');
  await routeHistory(page, { pages: { null: { entries: exchanges(1, 2), before: null } } });
  await openChat(page);
  const reads = (await readsOf(page, 'history.page')).length;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(composer(page)).toBeEnabled();
  await expect(page.getByText('Answer 2', { exact: true })).toBeVisible();
  await expect.poll(async () => (await readsOf(page, 'history.page')).length).toBeGreaterThan(reads);
});
