// A Team's browser session in the built Admin (ADR-0117, 2026-10-20 amendment): the composer's panel with what the
// session holds, a sign-in session whose Browser the person drives in a dialog, then Saves or Cancels, and the
// session's deletion with the Supervisor password and a code.
import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe.js';
import { CLIENT_MESSAGES, rfbServer, solid } from './rfbServer.js';
import {
  SIGN_IN_CODE,
  SIGN_IN_ID,
  SIGN_IN_INCARNATION,
  SIGN_IN_PASSWORD,
  SIGN_IN_SESSION,
  SIGN_IN_VIEW,
} from './scenarios.js';
import { readsOf, routeRead, routeScenario } from './scenarioRoutes.js';
import { messages } from '../src/lib/i18n/catalogs.js';

const COPY = messages.en.signIn;
const SECURITY = messages.en.security;
const CHAT = messages.en.chatPage;
const SESSION = messages.en.signInSession;
const CONTROL = `**/api/teams/marketing/browser/views/${SIGN_IN_VIEW}/control`;

// Open the chat of the `sign-ins` scenario, its sign-in session's display recording what the page sends it.
async function openChat(page) {
  const scenario = await routeScenario(page, 'sign-ins');
  const display = { streams: [], scenario };
  await page.routeWebSocket(CONTROL, (socket) => {
    const server = rfbServer({ screen: ({ incremental }) => (incremental ? null : [solid(1280, 800, [40, 120, 200])]) });
    display.streams.push({ socket, server });
    socket.onMessage((message) => {
      for (const answer of server.receive(new Uint8Array(message))) socket.send(Buffer.from(answer));
    });
    socket.send(Buffer.from(server.greeting));
  });
  await page.goto('/chat/?team=marketing');
  // noVNC admits a socket only when its own class names its methods and handlers (browser-watch.spec.js).
  await page.evaluate(() => {
    const own = window.WebSocket.prototype;
    const base = Object.getPrototypeOf(own);
    for (const [name, property] of Object.entries(Object.getOwnPropertyDescriptors(base))) {
      if (!Object.hasOwn(own, name)) Object.defineProperty(own, name, property);
    }
  });
  return display;
}

async function openPanel(page) {
  await page.getByRole('button', { name: COPY.label, exact: true }).click();
  const panel = page.getByRole('dialog', { name: COPY.label });
  await expect(panel.getByRole('textbox', { name: COPY.urlLabel })).toBeVisible();
  return panel;
}

async function startSession(page, address = 'mail.example.net') {
  const panel = await openPanel(page);
  await panel.getByRole('textbox', { name: COPY.urlLabel }).fill(address);
  await panel.getByRole('button', { name: COPY.start, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: SESSION.title.replace('{site}', 'mail.example.net') });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the panel shows what the browser session holds and its state', async ({ page }) => {
  await openChat(page);
  const panel = await openPanel(page);
  const held = panel.getByRole('region', { name: COPY.label });
  await expect(held).toContainText(COPY.ready);
  await expect(held.getByRole('listitem')).toHaveText(['mail.example.com', 'shop.example.org']);
});

test('a sign-in session is driven by the person and saved as the next generation @browser-sensitive', async ({ page }) => {
  const display = await openChat(page);
  const dialog = await startSession(page);
  expect(await readsOf(page, 'sign_in.start')).toEqual([
    { team_id: 'marketing', body: { url: 'https://mail.example.net', locale: 'en' } },
  ]);
  const screen = dialog.getByRole('application', { name: SESSION.screen });
  await expect(screen.locator('canvas')).toBeVisible();
  await expect.poll(() => display.streams.length).toBe(1);
  // The person's pointer and keys reach the sign-in Browser, and Esc stays with the page.
  const box = await screen.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type('me');
  await page.keyboard.press('Escape');
  const received = () => display.streams[0].server.received;
  await expect.poll(() => received().includes(CLIENT_MESSAGES.POINTER)).toBe(true);
  await expect.poll(() => received().includes(CLIENT_MESSAGES.KEY)).toBe(true);
  // Every message is one the display reads whole, in KasmVNC's own sizes: none is misread as another.
  expect(received().every((type) => [0, 2, 3, CLIENT_MESSAGES.KEY, CLIENT_MESSAGES.POINTER].includes(type))).toBe(true);
  await expect(dialog).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);

  await dialog.getByRole('button', { name: SESSION.save }).click();
  await expect(dialog).toBeHidden();
  expect(await readsOf(page, 'sign_in.save')).toEqual([
    { team_id: 'marketing', body: { sign_in_session_id: SIGN_IN_SESSION } },
  ]);
  const panel = await openPanel(page);
  await expect(panel.getByRole('region', { name: COPY.label }).getByRole('listitem')).toContainText(['example.net']);
});

test('a refused save says what to do and keeps the session; Cancel leaves it needing the person', async ({ page }) => {
  await openChat(page);
  await routeRead(page, 'sign_in.save', () => ({ status: 409, json: { detail: 'x', code: 'sign-in-windows' } }));
  const dialog = await startSession(page);
  await dialog.getByRole('button', { name: SESSION.save }).click();
  await expect(dialog.getByText(SESSION.windows)).toBeVisible();
  await expect(dialog.getByRole('button', { name: SESSION.save })).toBeEnabled();
  await dialog.getByRole('button', { name: SESSION.cancel }).click();
  await expect(dialog).toBeHidden();
  expect(await readsOf(page, 'sign_in.cancel')).toEqual([
    { team_id: 'marketing', body: { sign_in_session_id: SIGN_IN_SESSION } },
  ]);
  const panel = await openPanel(page);
  await expect(panel.getByRole('region', { name: COPY.label })).toContainText(COPY.needsPerson);
});

test('an address that is not https is refused before Admin is asked', async ({ page }) => {
  await openChat(page);
  const panel = await openPanel(page);
  await panel.getByRole('textbox', { name: COPY.urlLabel }).fill('http://mail.example.net');
  await panel.getByRole('button', { name: COPY.start, exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(COPY.urlInvalid);
  expect(await readsOf(page, 'sign_in.start')).toEqual([]);
});

test('neither starting nor saving sends the chat draft around them', async ({ page }) => {
  const { scenario } = await openChat(page);
  const composer = page.getByRole('textbox', { name: CHAT.send, exact: true });
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  await composer.fill('A draft that stays.');
  const panel = await openPanel(page);
  await panel.getByRole('textbox', { name: COPY.urlLabel }).fill('mail.example.net');
  await panel.getByRole('textbox', { name: COPY.urlLabel }).press('Enter');
  const dialog = page.getByRole('dialog', { name: SESSION.title.replace('{site}', 'mail.example.net') });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: SESSION.save }).click();
  await expect(dialog).toBeHidden();
  expect(await readsOf(page, 'sign_in.save')).toHaveLength(1);
  await expect(composer).toHaveValue('A draft that stays.');
  expect(scenario.chatFrames().filter((frame) => frame.type === 'chat')).toEqual([]);
});

test('a screen whose connection ended connects again, and a refused Cancel keeps the dialog', async ({ page }) => {
  const display = await openChat(page);
  const dialog = await startSession(page);
  await expect.poll(() => display.streams.length).toBe(1);
  display.streams[0].socket.close({ code: 1013, reason: '' });
  await expect(dialog.getByRole('status')).toHaveText(SESSION.lost);
  await dialog.getByRole('button', { name: SESSION.reconnect }).click();
  await expect.poll(() => display.streams.length).toBe(2);
  await expect(dialog.getByRole('application', { name: SESSION.screen }).locator('canvas')).toBeVisible();
  await routeRead(page, 'sign_in.cancel', () => ({ status: 503, json: { detail: 'x', code: 'browser-unavailable' } }));
  await dialog.getByRole('button', { name: SESSION.cancel }).click();
  await expect(dialog.getByText(SESSION.cancelFailed)).toBeVisible();
  await expect(dialog).toBeVisible();
});

test('a Save the activity log could not record is kept, and the person is told so', async ({ page }) => {
  await openChat(page);
  const record = {
    sign_in_id: SIGN_IN_ID,
    state: 'ready',
    generation: 1,
    team_incarnation: SIGN_IN_INCARNATION,
    sites: ['example.net'],
    sites_truncated: false,
    created_at: '2026-10-20T12:00:00Z',
    saved_at: '2026-10-20T12:00:00Z',
    last_used_at: '2026-10-20T12:00:00Z',
    expires_at: '2026-10-27T12:00:00Z',
  };
  await routeRead(page, 'sign_in.save', () => ({ status: 200, json: { sign_in: record, recorded: false } }));
  const dialog = await startSession(page);
  await dialog.getByRole('button', { name: SESSION.save }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(SESSION.savedUnrecorded)).toBeVisible();
});

test('a Save that failed for another reason keeps the session to save again or cancel at Team', async ({ page }) => {
  await openChat(page);
  await routeRead(page, 'sign_in.save', () => ({ status: 503, json: { detail: 'x', code: 'sign-in-unsaved' } }));
  const dialog = await startSession(page);
  await dialog.getByRole('button', { name: SESSION.save }).click();
  await expect(dialog.getByText(SESSION.unsaved)).toBeVisible();
  await expect(dialog.getByRole('button', { name: SESSION.save })).toBeEnabled();
  await dialog.getByRole('button', { name: SESSION.cancel }).click();
  await expect(dialog).toBeHidden();
  expect(await readsOf(page, 'sign_in.cancel')).toHaveLength(1);
});

test('the session is deleted only with the password and a code, for exactly the session shown', async ({ page }) => {
  await openChat(page);
  const panel = await openPanel(page);
  await panel.getByRole('button', { name: COPY.delete, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: COPY.deleteTitle });
  await expect(dialog).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  // Delete needs the password and a code together; a wrong password deletes nothing.
  await expect(dialog.getByRole('button', { name: COPY.deletion.delete, exact: true })).toBeDisabled();
  await dialog.getByLabel(SECURITY.password, { exact: true }).fill('wrong words');
  await dialog.getByRole('textbox', { name: SECURITY.code }).fill(SIGN_IN_CODE);
  await dialog.getByRole('button', { name: COPY.deletion.delete, exact: true }).click();
  await expect(dialog.getByText(SECURITY.passwordIncorrect)).toBeVisible();
  expect(await readsOf(page, 'sign_in.delete')).toEqual([]);
  await dialog.getByLabel(SECURITY.password, { exact: true }).fill(SIGN_IN_PASSWORD);
  await dialog.getByRole('textbox', { name: SECURITY.code }).fill(SIGN_IN_CODE);
  await dialog.getByRole('button', { name: COPY.deletion.delete, exact: true }).click();
  await expect(dialog).toBeHidden();
  const [deleted] = await readsOf(page, 'sign_in.delete');
  expect(deleted).toEqual({
    team_id: 'marketing',
    sign_in_id: 'a'.repeat(32),
    generation: '1',
    team_incarnation: 'c'.repeat(64),
    body: { code: SIGN_IN_CODE },
  });
  const after = await openPanel(page);
  await expect(after.getByText(COPY.empty)).toBeVisible();
});
