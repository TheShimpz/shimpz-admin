// Admin's session socket while Admin cannot be reached (ADR-0114 decision 5): one place speaks about the connection,
// pages keep what they know and never show a connectivity failure or an empty state they do not know, reads wait for
// the socket and finish once it is back, changes stay disabled meanwhile, and the socket never stops reconnecting.
import { expect, test } from '@playwright/test';

import { publicAssistant } from './assistantPages.js';
import { messages } from '../src/lib/messages.js';
import { dropSessions, raiseTopic, readsOf, routeConnect, routeRead, routeScenario, waitForRead } from './scenarioRoutes.js';

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

test('a change Admin announced while the socket was closed is read once it reopens, and nothing else is', async ({ page }) => {
  await routeScenario(page, 'ready');
  let renamed = false;
  await routeRead(page, 'teams.list', () => (renamed
    ? { status: 200, json: { teams: [{ team_id: 'marketing', team_name: 'Growth', status: 'running' }] } }
    : undefined));
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: chatPage.send, exact: true })).toBeEnabled();
  const navigation = page.locator('.shell-sidebar');
  const listReads = (await readsOf(page, 'teams.list')).length;
  const releaseReads = (await readsOf(page, 'platform.release')).length;
  refusing = true;
  await dropSessions(page);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  // Another tab renames the Team while this one cannot hear it: Admin's revision of the list advances.
  renamed = true;
  await raiseTopic(page, 'teams');
  refusing = false;
  await expect(navigation.getByRole('link', { name: 'Growth', exact: true })).toBeVisible({ timeout: 20_000 });
  expect((await readsOf(page, 'teams.list')).length).toBe(listReads + 1);
  // A topic whose revision did not move is not read again.
  expect((await readsOf(page, 'platform.release')).length).toBe(releaseReads);
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

test('a provider key typed while Admin reconnects stays in its field and is saved only once Admin is back', async ({ page }) => {
  const scenario = await routeScenario(page, 'ready');
  // OpenAI, the Team's provider, has no key yet, so the composer asks for one.
  const providers = scenario.call('models.list', {}).json.providers;
  await routeRead(page, 'models.list', () => ({
    status: 200, json: { providers: providers.map((entry) => ({ ...entry, configured: false, masked: null })) },
  }));
  const saves = [];
  await routeRead(page, 'models.save', ({ provider, body }) => {
    saves.push(provider);
    const saved = providers.find((entry) => entry.id === provider);
    return { status: 200, json: { ...saved, configured: true, masked: `••••${body.api_key.slice(-4)}` } };
  });
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  const key = page.getByLabel(messages.en.providerSetup.key);
  const save = page.getByRole('button', { name: messages.en.providerSetup.saveKey });
  // The key field takes the focus once the conversation has loaded and can be typed in.
  await expect(key).toBeFocused();

  refusing = true;
  await dropSessions(page);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  await key.fill('test-provider-key-word');
  await expect(save).toBeDisabled();
  await key.press('Enter');
  await expect(key).toHaveValue('test-provider-key-word');
  expect(saves).toEqual([]);

  refusing = false;
  await expect(save).toBeEnabled({ timeout: 20_000 });
  await expect(key).toHaveValue('test-provider-key-word');
  await save.click();
  await expect.poll(() => saves).toEqual(['openai']);
});

test('a provider key whose answer was lost after a Team switch is read again for the Team shown once Admin is back', async ({ page }) => {
  const scenario = await routeScenario(page, 'ready');
  // OpenAI, every Team's provider, has no key until Admin stores the one typed below.
  const providers = scenario.call('models.list', {}).json.providers;
  let stored = false;
  await routeRead(page, 'models.list', () => ({
    status: 200,
    json: { providers: providers.map((entry) => ({ ...entry, configured: stored, masked: stored ? '••••word' : null })) },
  }));
  // Admin stores the key, and its answer never arrives before the connection drops.
  await routeRead(page, 'models.save', () => {
    stored = true;
    return new Promise(() => {});
  });
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  const key = page.getByLabel(messages.en.providerSetup.key);
  await expect(key).toBeFocused();
  await key.fill('test-provider-key-word');
  await page.getByRole('button', { name: messages.en.providerSetup.saveKey }).click();
  await waitForRead(page, 'models.save');

  // The Supervisor opens another Team while the key's answer is still on its way, and then the connection drops.
  await page.locator('.shell-sidebar').getByRole('link', { name: 'Trinity', exact: true }).click();
  await expect(page).toHaveURL(/team=trinity/);
  const listReads = (await readsOf(page, 'models.list')).length;
  refusing = true;
  await dropSessions(page);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  refusing = false;

  // Once Admin is back, the providers are read again and Trinity's chat opens with the stored key, never sent again.
  await expect(page.getByRole('textbox', { name: chatPage.send, exact: true })).toBeEnabled({ timeout: 20_000 });
  expect((await readsOf(page, 'models.list')).length).toBeGreaterThan(listReads);
  expect(await readsOf(page, 'models.save')).toHaveLength(1);
});

test('a provider key whose answer was lost while the next Team still loads is read again once that Team loads', async ({ page }) => {
  const scenario = await routeScenario(page, 'ready');
  const providers = scenario.call('models.list', {}).json.providers;
  let stored = false;
  await routeRead(page, 'models.list', () => ({
    status: 200,
    json: { providers: providers.map((entry) => ({ ...entry, configured: stored, masked: stored ? '••••word' : null })) },
  }));
  await routeRead(page, 'models.save', () => {
    stored = true;
    return new Promise(() => {});
  });
  // Trinity's first selection read never answers: the connection drops while Trinity still loads.
  let trinityHeld = false;
  await routeRead(page, 'inference.read', ({ team_id: teamId }) => {
    if (teamId !== 'trinity' || trinityHeld) return undefined;
    trinityHeld = true;
    return new Promise(() => {});
  });
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  const key = page.getByLabel(messages.en.providerSetup.key);
  await expect(key).toBeFocused();
  await key.fill('test-provider-key-word');
  await page.getByRole('button', { name: messages.en.providerSetup.saveKey }).click();
  await waitForRead(page, 'models.save');

  await page.locator('.shell-sidebar').getByRole('link', { name: 'Trinity', exact: true }).click();
  await waitForRead(page, 'inference.read', (params) => params.team_id === 'trinity');
  refusing = true;
  await dropSessions(page);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  refusing = false;

  // Trinity finishes loading once Admin is back, reads the providers again, and opens with the stored key.
  await expect(page.getByRole('textbox', { name: chatPage.send, exact: true })).toBeEnabled({ timeout: 20_000 });
  expect(await readsOf(page, 'models.save')).toHaveLength(1);
});

test('a fast-routing key whose answer was lost says its outcome is unknown and shows the key Admin holds once back', async ({ page }) => {
  await routeScenario(page, 'ready');
  let stored = false;
  await routeRead(page, 'decision.read', () => ({
    status: 200, json: { provider: 'typesafe', configured: stored, masked: stored ? '••••word' : null },
  }));
  // Admin stores the key and announces it, and the connection drops before the save's own answer arrives.
  await routeRead(page, 'decision.save', () => {
    stored = true;
    void raiseTopic(page, 'space/decision');
    return new Promise(() => {});
  });
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: chatPage.send, exact: true })).toBeEnabled();
  const trigger = page.getByRole('button', { name: /^Fast routing \(Jev\)/ });
  await trigger.click();
  const fast = page.getByRole('dialog', { name: 'Fast routing (Jev)' });
  await fast.getByLabel('TypeSafe API key').fill('test-typesafe-key-word');
  await fast.getByRole('button', { name: 'Save', exact: true }).click();
  await waitForRead(page, 'decision.save');
  refusing = true;
  await dropSessions(page);
  await expect(fast.getByRole('alert')).toHaveText(shell.outcomeUnknown);

  refusing = false;
  // The key Admin holds shows from the read its announcement asked for, and is never saved again.
  await expect(trigger).toHaveAccessibleName(/••••word/, { timeout: 20_000 });
  expect(await readsOf(page, 'decision.save')).toHaveLength(1);
});

test('a provider key that Admin stores only after the connection dropped opens the chat once Admin announces it', async ({ page }) => {
  const scenario = await routeScenario(page, 'ready');
  const providers = scenario.call('models.list', {}).json.providers;
  let stored = false;
  await routeRead(page, 'models.list', () => ({
    status: 200,
    json: { providers: providers.map((entry) => ({ ...entry, configured: stored, masked: stored ? '••••word' : null })) },
  }));
  // The save is still running when the connection drops: the page's recovery read finds no key yet.
  await routeRead(page, 'models.save', () => new Promise(() => {}));
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  const key = page.getByLabel(messages.en.providerSetup.key);
  await expect(key).toBeFocused();
  await key.fill('test-provider-key-word');
  await page.getByRole('button', { name: messages.en.providerSetup.saveKey }).click();
  await waitForRead(page, 'models.save');
  const listReads = (await readsOf(page, 'models.list')).length;
  refusing = true;
  await dropSessions(page);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  refusing = false;
  await expect.poll(async () => (await readsOf(page, 'models.list')).length).toBeGreaterThan(listReads);
  await expect(page.getByText(shell.reconnecting)).toHaveCount(0);

  // The save finishes on Admin afterwards, and Admin announces the Space's providers changed.
  stored = true;
  await raiseTopic(page, 'space/models');
  await expect(page.getByRole('textbox', { name: chatPage.send, exact: true })).toBeEnabled();
  expect(await readsOf(page, 'models.save')).toHaveLength(1);
});

test('a fast-routing key that Admin stores only after the connection dropped shows once Admin announces it', async ({ page }) => {
  await routeScenario(page, 'ready');
  let stored = false;
  await routeRead(page, 'decision.read', () => ({
    status: 200, json: { provider: 'typesafe', configured: stored, masked: stored ? '••••word' : null },
  }));
  await routeRead(page, 'decision.save', () => new Promise(() => {}));
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: chatPage.send, exact: true })).toBeEnabled();
  const trigger = page.getByRole('button', { name: /^Fast routing \(Jev\)/ });
  await trigger.click();
  const fast = page.getByRole('dialog', { name: 'Fast routing (Jev)' });
  await fast.getByLabel('TypeSafe API key').fill('test-typesafe-key-word');
  await fast.getByRole('button', { name: 'Save', exact: true }).click();
  await waitForRead(page, 'decision.save');
  const reads = (await readsOf(page, 'decision.read')).length;
  refusing = true;
  await dropSessions(page);
  await expect(fast.getByRole('alert')).toHaveText(shell.outcomeUnknown);
  refusing = false;
  await expect(page.getByText(shell.reconnecting)).toHaveCount(0);
  expect((await readsOf(page, 'decision.read')).length).toBe(reads);
  await expect(trigger).not.toHaveAccessibleName(/••••word/);

  stored = true;
  await raiseTopic(page, 'space/decision');
  await expect(trigger).toHaveAccessibleName(/••••word/);
  expect(await readsOf(page, 'decision.save')).toHaveLength(1);
});

test('an open Integrations drawer reads its Integrations again once Admin is back if they changed meanwhile', async ({ page }) => {
  await routeScenario(page, 'ready');
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: chatPage.send, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  await waitForRead(page, 'integrations.list');
  const reads = (await readsOf(page, 'integrations.list')).length;

  refusing = true;
  await dropSessions(page);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  // Another tab connects an Integration while this one cannot hear it.
  await raiseTopic(page, 'team/marketing/integrations');
  refusing = false;
  await expect.poll(async () => (await readsOf(page, 'integrations.list')).length, { timeout: 20_000 })
    .toBeGreaterThan(reads);
  await expect.poll(async () => (await readsOf(page, 'stored_inputs.list')).length).toBeGreaterThan(reads);
});

test('an open Integrations drawer shows an Assistant installed during an outage once Admin is back', async ({ page }) => {
  await routeScenario(page, 'ready');
  const cloudflare = { assistant: 'shimpz-cloudflare', assistant_version: '0.4.1', status: 'running', provenance: 'published' };
  const slack = { assistant: 'shimpz-slack', assistant_version: '1.2.3', status: 'running', provenance: 'published' };
  let installed = false;
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (teamId === 'marketing'
    ? { status: 200, json: { assistants: installed ? [cloudflare, slack] : [cloudflare] } }
    : undefined));
  await routeRead(page, 'integrations.list', () => ({ status: 200, json: { integrations: installed ? [{
    assistant_id: 'shimpz-slack',
    assistant_name: 'Shimpz Slack',
    assistant_version: '1.2.3',
    id: 'slack',
    provider: 'slack',
    name: 'Slack workspace',
    scopes: ['chat:write'],
    status: 'connected',
    integration: { id: 'account-2', name: 'Shimpz', username: null },
    expires_at: '2026-08-31T12:00:00.000Z',
  }] : [] } }));
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: chatPage.send, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  await waitForRead(page, 'integrations.list');

  // Slack is installed in Marketing while Admin cannot be reached.
  refusing = true;
  await dropSessions(page);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  installed = true;
  // Admin announces both as it installs; this tab hears of them once it is back.
  await raiseTopic(page, 'team/marketing/inventory');
  await raiseTopic(page, 'team/marketing/integrations');
  refusing = false;

  const drawer = page.locator('#assistant-integrations-drawer');
  await expect(drawer.getByRole('region', { name: 'Shimpz Slack' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(messages.en.assistantIntegrations.inventoryFailed)).toHaveCount(0);
});

test('a reopened socket reads only what changed meanwhile, and a change of the inventory and the registry reads each once', async ({ page }) => {
  const scenario = await routeScenario(page, 'ready');
  const subscribed = (topic) => scenario.sessions.at(-1)?.subscribed(topic) ?? false;
  let refusing = false;
  await refuseWhile(page, () => refusing);
  await page.goto('/assistants/?team=marketing');
  await expect(page.getByRole('region', { name: messages.en.store.frameTitle })).toBeVisible();
  await expect.poll(() => subscribed('team/marketing/inventory') && subscribed('assistants/registry')).toBe(true);
  const count = async (method) => (await readsOf(page, method)).length;
  const settled = () => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  await settled();
  let registry = await count('assistants.registry');
  let inventory = await count('assistants.list');

  // Admin answers the reopened socket's subscription at the revisions already read: nothing changed, nothing is read.
  refusing = true;
  await dropSessions(page);
  await expect(page.getByText(shell.reconnecting)).toBeVisible();
  refusing = false;
  await expect(page.getByText(shell.reconnecting)).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => subscribed('team/marketing/inventory') && subscribed('assistants/registry')).toBe(true);
  await settled();
  expect(await count('assistants.registry')).toBe(registry);
  expect(await count('assistants.list')).toBe(inventory);

  // An install raises both topics: each is read once.
  registry = await count('assistants.registry');
  inventory = await count('assistants.list');
  await raiseTopic(page, 'team/marketing/inventory');
  await raiseTopic(page, 'assistants/registry');
  await settled();
  expect(await count('assistants.registry')).toBe(registry + 1);
  expect(await count('assistants.list')).toBe(inventory + 1);
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

test('a fast-routing key Admin refuses to read is said to be unavailable even after it was shown', async ({ page }) => {
  await routeScenario(page, 'ready');
  let refused = false;
  await routeRead(page, 'decision.read', () => (refused
    ? { status: 404, json: { detail: 'not found' } }
    : { status: 200, json: { provider: 'typesafe', configured: true, masked: '••••word' } }));
  await page.goto('/chat/?team=marketing');
  const trigger = page.getByRole('button', { name: /^Fast routing \(Jev\)/ });
  await expect(trigger).toHaveAccessibleName(/••••word/);
  refused = true;
  await raiseTopic(page, 'space/decision');
  await trigger.click();
  const fast = page.getByRole('dialog', { name: 'Fast routing (Jev)' });
  await expect(fast.getByRole('status')).toHaveText(messages.en.brainMenu.fast.unavailable);
  await expect(trigger).not.toHaveAccessibleName(/••••word/);
});

test('data Admin keeps failing to read is said once, over the page, and the page fills in once it reads', async ({ page }) => {
  await routeScenario(page, 'ready');
  let unavailable = true;
  await routeRead(page, 'teams.list', () => (unavailable ? { status: 503, json: { detail: 'Team is unavailable' } } : undefined));
  await page.clock.install();
  await page.goto('/chat/?team=marketing');
  // The boot screen gives way to the one message, which the Space status line mirrors; nothing else speaks of it.
  await expect(page.getByText(shell.dataUnavailable)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.space-status')).toContainText(shell.resourceDataUnavailable);
  await expect(page.getByText(shell.reconnecting)).toHaveCount(0);
  for (const error of pageConnectivityErrors(page)) await expect(error).toHaveCount(0);
  // Admin answers again: the capped retries read it and the message goes.
  unavailable = false;
  await page.clock.runFor(31_000);
  await expect(page.getByRole('textbox', { name: chatPage.send, exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(shell.dataUnavailable)).toHaveCount(0);
});
