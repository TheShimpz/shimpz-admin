// Chat turns detached from their page (ADR-0119): a page that opens while its Team's turn runs is shown where the turn
// is and then its reply; a turn that waits for the Space's chat gate shows its place in line; a turn that ended
// without a reply keeps how it ended; a message left without an ending says so; and the Supervisor sets how many
// conversations the Space runs at once.
import { expect, test } from '@playwright/test';

import { messages } from '../src/lib/i18n/catalogs.js';
import { readsOf, routeChat, routeRead, routeScenario } from './scenarioRoutes.js';

const chatPage = messages.en.chatPage;
const limitCopy = messages.en.chatLimitMenu;
const AT = '2026-10-01T12:00:00Z';
const TURN = 'a'.repeat(32);
const ok = (json) => ({ status: 200, json });
const composer = (page) => page.getByRole('textbox', { name: chatPage.send, exact: true });

const step = (seq, phase, state) => ({
  type: 'progress',
  seq,
  origin: 'team',
  phase,
  state,
  ...(state === 'finished' ? { elapsed_ms: 40 } : {}),
});
const done = (reply) => ({
  type: 'done',
  team_id: 'marketing',
  team_name: 'Marketing',
  reply,
  clarification: null,
});

async function routeHistory(page, entries) {
  await routeRead(page, 'history.page', (params) => (
    params.team_id === 'marketing' && !params.routine ? ok({ entries, before: null }) : undefined
  ));
}

// Marketing's channel: each attach is answered by `onSync(channel)`, and each chat frame by `onChat(channel)`.
async function routeMarketing(page, { onSync, onChat = () => {} }) {
  const channels = [];
  await routeChat(page, 'marketing', (channel) => {
    channels.push(channel);
    channel.onMessage((text) => {
      const frame = JSON.parse(text);
      if (frame.type === 'sync') onSync(channel);
      if (frame.type === 'chat') onChat(channel);
    });
  });
  return channels;
}

test('a page that opens while its turn runs shows where it is, then its reply', async ({ page }) => {
  await routeScenario(page);
  await routeHistory(page, [
    { id: `${TURN}:user`, created_at: AT, kind: 'message', role: 'user', text: 'Read the edital' },
  ]);
  const channels = await routeMarketing(page, {
    onSync: (channel) => channel.send({
      type: 'running',
      elapsed_ms: 12_000,
      position: null,
      cursor: 2,
      events: [step(1, 'team-context', 'started'), step(2, 'team-context', 'finished')],
    }),
  });
  await page.goto('/chat/?team=marketing');
  const thinking = page.getByRole('group', { name: chatPage.sending });
  await expect(thinking).toBeVisible();
  // It counts from when the turn started, not from when this page opened.
  await expect(thinking).toContainText(/1[2-9] s/);
  // The message it answers is not shown as unfinished.
  await expect(page.getByText(chatPage.unfinished)).toHaveCount(0);
  channels[0].send(step(3, 'model', 'started'));
  channels[0].send(done('Prazo: 30/11.'));
  await expect(page.getByText('Prazo: 30/11.')).toBeVisible();
  await expect(thinking).toHaveCount(0);
});

test('a turn that waits for the Space shows its place in line, then runs', async ({ page }) => {
  await routeScenario(page);
  await routeMarketing(page, {
    onSync: (channel) => channel.send({ type: 'sync-empty' }),
    onChat: (channel) => {
      channel.send({ type: 'running', elapsed_ms: 0, position: 1, cursor: 0, events: [] });
      setTimeout(() => {
        channel.send({ type: 'running', elapsed_ms: 900, position: null, cursor: 0, events: [] });
        channel.send(step(1, 'team-context', 'started'));
        channel.send(done('Ran once its turn came.'));
      }, 800);
    },
  });
  await page.goto('/chat/?team=marketing');
  await expect(composer(page)).toBeEnabled();
  await composer(page).fill('Summarize the launch plan');
  await composer(page).press('Enter');
  const thinking = page.getByRole('group', { name: chatPage.sending });
  await expect(thinking).toContainText(chatPage.progress.queued.replace('{position}', '1'));
  await expect(page.getByText('Ran once its turn came.')).toBeVisible();
});

test('a turn that ended without a reply keeps how it ended, and one without an ending says so', async ({ page }) => {
  await routeScenario(page);
  const other = 'b'.repeat(32);
  const last = 'c'.repeat(32);
  await routeHistory(page, [
    { id: `${TURN}:user`, created_at: AT, kind: 'message', role: 'user', text: 'Book the meeting room' },
    { id: `${TURN}:status`, created_at: AT, kind: 'status', state: 'stopped' },
    { id: `${other}:user`, created_at: AT, kind: 'message', role: 'user', text: 'Read the weather' },
    {
      id: `${other}:status`,
      created_at: AT,
      kind: 'status',
      state: 'failed',
      status: 503,
      detail: 'Brain runtime is unavailable',
    },
    { id: `${last}:user`, created_at: AT, kind: 'message', role: 'user', text: 'Draft the newsletter' },
  ]);
  await routeMarketing(page, { onSync: (channel) => channel.send({ type: 'sync-empty' }) });
  await page.goto('/chat/?team=marketing');
  await expect(page.getByText(chatPage.turnStopped)).toBeVisible();
  await expect(page.getByText(chatPage.runtimeFailed)).toBeVisible();
  await expect(page.getByText(chatPage.unfinished)).toBeVisible();
});

test('an earlier page that ends with a message answered on the next page does not call it unanswered', async ({ page }) => {
  await routeScenario(page);
  const cursor = 'AAAAAAAAAAI';
  // The page boundary falls between a message and its reply.
  await routeRead(page, 'history.page', (params) => {
    if (params.team_id !== 'marketing' || params.routine) return undefined;
    return params.before === cursor
      ? ok({ entries: [{ id: `${TURN}:user`, created_at: AT, kind: 'message', role: 'user', text: 'Read the edital' }], before: null })
      : ok({ entries: [{ id: `${TURN}:reply`, created_at: AT, kind: 'message', role: 'assistant', text: 'Prazo: 30/11.', author: 'Marketing' }], before: cursor });
  });
  await routeMarketing(page, { onSync: (channel) => channel.send({ type: 'sync-empty' }) });
  await page.goto('/chat/?team=marketing');
  await expect(page.getByText('Read the edital', { exact: true })).toBeVisible();
  await expect(page.getByText('Prazo: 30/11.', { exact: true })).toBeVisible();
  await expect(page.getByText(chatPage.unfinished)).toHaveCount(0);
});

test('the Supervisor sets how many conversations the Space runs at once', async ({ page }) => {
  await routeScenario(page);
  await routeMarketing(page, { onSync: (channel) => channel.send({ type: 'sync-empty' }) });
  await page.goto('/chat/?team=marketing');
  await expect(composer(page)).toBeEnabled();
  await page.getByRole('button', { name: `${limitCopy.label}: 2`, exact: true }).click();
  const choices = page.getByRole('group', { name: limitCopy.label });
  await expect(choices.getByRole('button', { name: '2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await choices.getByRole('button', { name: '1', exact: true }).click();
  await expect(choices.getByRole('button', { name: '1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const saves = await readsOf(page, 'chat_limit.save');
  expect(saves.map((params) => params.body)).toEqual([{ limit: 1 }]);
});
