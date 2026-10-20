// A Team's Sign-ins in the built Admin (ADR-0117, Sign-ins amendment): the composer's Sign-ins list with Forget, and a
// sign-in session whose Browser the person drives in a dialog, then Saves under a label or Cancels.
import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe.js';
import { CLIENT_MESSAGES, rfbServer, solid } from './rfbServer.js';
import { SIGN_IN_SESSION, SIGN_IN_VIEW } from './scenarios.js';
import { readsOf, routeRead, routeScenario } from './scenarioRoutes.js';
import { messages } from '../src/lib/i18n/catalogs.js';

const COPY = messages.en.signIns;
const CHAT = messages.en.chatPage;
const SESSION = messages.en.signInSession;
const CONTROL = `**/api/teams/marketing/browser/views/${SIGN_IN_VIEW}/control`;
const WORK = 'a'.repeat(32);

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

async function openList(page) {
  await page.getByRole('button', { name: COPY.label, exact: true }).click();
  const panel = page.getByRole('dialog', { name: COPY.label });
  await expect(panel.getByRole('list', { name: COPY.label })).toBeVisible();
  return panel;
}

async function startSession(page, address = 'mail.example.net') {
  const panel = await openList(page);
  await panel.getByRole('textbox', { name: COPY.urlLabel }).fill(address);
  await panel.getByRole('button', { name: COPY.start, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: SESSION.title.replace('{site}', 'mail.example.net') });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the list names each Sign-in and Forget removes exactly the one asked', async ({ page }) => {
  await openChat(page);
  const panel = await openList(page);
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Forget Work (mail.example.com)', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(1);
  await expect(panel.getByRole('listitem')).toContainText('shop.example.org');
  expect(await readsOf(page, 'sign_ins.forget')).toEqual([{ team_id: 'marketing', body: { sign_in_id: WORK } }]);
});

test('a sign-in session is driven by the person and saved under their label @browser-sensitive', async ({ page }) => {
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
  await expect(dialog).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);

  await expect(dialog.getByRole('button', { name: SESSION.save })).toBeDisabled();
  await dialog.getByRole('textbox', { name: SESSION.labelField }).fill('  Inbox  ');
  await dialog.getByRole('button', { name: SESSION.save }).click();
  await expect(dialog).toBeHidden();
  expect(await readsOf(page, 'sign_in.save')).toEqual([
    { team_id: 'marketing', body: { sign_in_session_id: SIGN_IN_SESSION, label: 'Inbox' } },
  ]);
  const panel = await openList(page);
  await expect(panel.getByRole('listitem')).toHaveCount(3);
  await expect(panel.getByRole('listitem').last()).toContainText('Inbox');
});

test('a refused save says what to do and keeps the session; Cancel keeps nothing', async ({ page }) => {
  await openChat(page);
  await routeRead(page, 'sign_in.save', () => ({ status: 409, json: { detail: 'x', code: 'sign-in-windows' } }));
  const dialog = await startSession(page);
  await dialog.getByRole('textbox', { name: SESSION.labelField }).fill('Inbox');
  await dialog.getByRole('button', { name: SESSION.save }).click();
  await expect(dialog.getByText(SESSION.windows)).toBeVisible();
  await expect(dialog.getByRole('button', { name: SESSION.save })).toBeEnabled();
  await dialog.getByRole('button', { name: SESSION.cancel }).click();
  await expect(dialog).toBeHidden();
  expect(await readsOf(page, 'sign_in.cancel')).toEqual([
    { team_id: 'marketing', body: { sign_in_session_id: SIGN_IN_SESSION } },
  ]);
  const panel = await openList(page);
  await expect(panel.getByRole('listitem')).toHaveCount(2);
});

test('an address that is not https is refused before Admin is asked', async ({ page }) => {
  await openChat(page);
  const panel = await openList(page);
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
  const panel = await openList(page);
  await panel.getByRole('textbox', { name: COPY.urlLabel }).fill('mail.example.net');
  await panel.getByRole('textbox', { name: COPY.urlLabel }).press('Enter');
  const dialog = page.getByRole('dialog', { name: SESSION.title.replace('{site}', 'mail.example.net') });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: SESSION.labelField }).fill('Inbox');
  await dialog.getByRole('textbox', { name: SESSION.labelField }).press('Enter');
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
