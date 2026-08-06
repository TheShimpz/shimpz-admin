import { readFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const modelCatalog = JSON.parse(
  readFileSync(new URL('../src/lib/modelCatalog.json', import.meta.url), 'utf8'),
);

const visualContract = {
  animations: 'disabled',
  fullPage: true,
  maxDiffPixels: 100,
};

async function routeSetup(page) {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ profile: 'local', authenticated: false, initialized: false }),
  }));
}

async function routeReadyChat(page, { integrationChallenge = false, missingInference = false, reply } = {}) {
  let inferenceWrites = 0;
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable outside this rendered contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ profile: 'local', authenticated: true, origin_admitted: true }),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [{ id: 'shimpz-cloudflare', title: 'Shimpz Cloudflare' }] }),
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [{ assistant: 'shimpz-cloudflare', status: 'running' }] }),
  }));
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare/icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  }));
  await page.route('**/api/teams/marketing/files', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ files: [] }),
  }));
  await page.route('**/api/model-providers', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      providers: modelCatalog.providers.map(({ credential_validation: _credential, ...provider }) => ({
        ...provider,
        configured: true,
        masked: '••••1234',
      })),
    }),
  }));
  await page.route('**/api/teams/marketing/inference', (route) => {
    if (missingInference && route.request().method() === 'GET') {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'not configured' }),
      });
    }
    if (route.request().method() === 'PUT') inferenceWrites += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ team_id: 'marketing', provider: 'openai', model: 'gpt-5.6-terra' }),
    });
  });
  await page.route('**/api/teams/marketing/assistant-integrations', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      integrations: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_name: 'Shimpz Cloudflare',
        id: 'cloudflare',
        provider: 'cloudflare',
        name: 'Cloudflare',
        summary: 'Reads reviewed zone and DNS metadata.',
        scopes: ['dns.read', 'offline_access', 'zone.read'],
        status: 'connected',
        integration: { id: 'account-1', name: 'Shimpz', username: null },
        expires_at: '2026-08-31T12:00:00.000Z',
      }],
    }),
  }));
  await page.routeWebSocket('**/api/teams/marketing/chat/ws', (socket) => {
    socket.onMessage((message) => {
      const frame = JSON.parse(message);
      if (frame.type === 'sync') {
        socket.send(JSON.stringify({ type: 'sync-empty' }));
      } else if (frame.type === 'chat') {
        if (integrationChallenge) {
          socket.send(JSON.stringify({
            type: 'integrations-required',
            challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            expires_in: 300,
            requirements: [{
              assistant_id: 'shimpz-cloudflare',
              assistant_name: 'Shimpz Cloudflare',
              integration_id: 'cloudflare',
              provider: 'cloudflare',
              name: 'Cloudflare',
              summary: 'Reads reviewed zone and DNS metadata.',
              scopes: ['dns.read', 'offline_access', 'zone.read'],
              powers: [{ id: 'list-zones', name: 'List zones', summary: 'Lists Cloudflare zones.' }],
            }],
          }));
          return;
        }
        socket.send(JSON.stringify({
          type: 'progress',
          seq: 1,
          origin: 'admin',
          phase: 'admin-preparation',
          state: 'finished',
          elapsed_ms: 19,
        }));
        socket.send(JSON.stringify({
          type: 'done',
          team_id: 'marketing',
          team_name: 'Marketing',
          reply: reply ?? '**Rendered answer** with a [safe link](https://example.com).',
        }));
      }
    });
  });
  return { inferenceWrites: () => inferenceWrites };
}

test('setup surface is accessible and never overflows its viewport', async ({ page }) => {
  await routeSetup(page);
  await page.goto('/');

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
});

test('language menu implements keyboard navigation and RTL direction', async ({ page }) => {
  await routeSetup(page);
  await page.goto('/');

  const trigger = page.getByRole('button', { name: 'Language: English' });
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Language' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitemradio', { name: 'العربية' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('button', { name: 'اللغة: العربية' })).toBeFocused();
});

test('opens Chat directly when the provider key already exists', async ({ page }) => {
  const requests = await routeReadyChat(page, { missingInference: true });
  await page.goto('/chat/');

  await expect(page.locator('.provider-gate')).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  expect(requests.inferenceWrites()).toBe(1);
});

test('compiled Chat renders Markdown and its execution receipt', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Show the rendered response');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'safe link' })).toHaveAttribute('href', 'https://example.com/');
  await expect(page.getByText(/1 execution stages completed/i)).toBeVisible();
});

test('renders the integrations drawer as a responsive Sheet surface', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('data-slot', 'drawer');
  await expect(drawer.getByRole('heading', { name: 'Shimpz Cloudflare' })).toBeVisible();
  await expect(drawer.getByText('Connected', { exact: true })).toBeVisible();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox.width).toBeLessThanOrEqual((page.viewportSize().width * 0.92) + 1);
  const drawerAxe = await new AxeBuilder({ page }).analyze();
  expect(drawerAxe.violations).toEqual([]);
  await expect(drawer).toHaveScreenshot('integrations-drawer.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await page.getByRole('button', { name: 'Close integrations' }).click();
  await expect(drawer).toBeHidden();
});

test('uses text actions and one semantic selected state in the Assistant chooser', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  await page.locator('.context-controls').getByRole('button').nth(2).click();
  const dialog = page.getByRole('dialog', { name: 'Choose Assistants' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
  const selectAll = dialog.getByRole('button', { name: 'Select all', exact: true });
  const unselectAll = dialog.getByRole('button', { name: 'Unselect all', exact: true });
  await expect(selectAll).toHaveClass(/shimpz-text-action/);
  await expect(unselectAll).toHaveClass(/shimpz-text-action/);
  await expect(selectAll.locator('[data-slot="text-action-icon"]')).toBeVisible();
  const choice = dialog.getByRole('button', { name: 'Shimpz Cloudflare' });
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await expect(choice.locator('img')).toHaveAttribute(
    'src',
    '/api/teams/marketing/assistants/shimpz-cloudflare/icon',
  );
  await expect(dialog).toHaveScreenshot('assistant-chooser.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await unselectAll.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'false');
  await expect(choice.locator('.selection-mark')).toHaveCount(0);
  const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(results.violations).toEqual([]);
});

test('renders the fail-closed Integration challenge dialog', async ({ page }) => {
  await routeReadyChat(page, { integrationChallenge: true });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('List the Cloudflare zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect required integrations' });
  await expect(dialog).toBeVisible();
  const requirement = dialog.locator('[data-slot="card"]', { hasText: 'Shimpz Cloudflare' });
  await expect(requirement).toBeVisible();
  await expect(requirement.getByText('dns.read', { exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(results.violations).toEqual([]);
  await expect(dialog).toHaveScreenshot('integration-required-dialog.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
});

test('keeps long Chat transcripts keyboard-scrollable', async ({ page }) => {
  const longReply = Array.from({ length: 60 }, (_, index) => `Result ${index + 1}: validated DNS record.`).join('\n\n');
  await routeReadyChat(page, { reply: longReply });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Return the complete DNS inventory');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Result 60: validated DNS record.')).toBeVisible();
  const turns = page.locator('.turns');
  await expect(turns).toHaveAttribute('tabindex', '0');
  const dimensions = await turns.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }));
  expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
  await turns.evaluate((element) => { element.scrollTop = 0; });
  await turns.focus();
  await page.keyboard.press('PageDown');
  await expect.poll(() => turns.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test('keeps compact controls and stacked dialog actions usable at 360 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await routeReadyChat(page);
  await page.goto('/chat/');
  await page.getByRole('button', { name: /Team Marketing/i }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a Team' });
  const [closeBox, addBox, dialogBox] = await Promise.all([
    dialog.getByRole('button', { name: 'Close' }).boundingBox(),
    dialog.getByRole('button', { name: 'Add Team' }).boundingBox(),
    dialog.boundingBox(),
  ]);
  expect(closeBox).not.toBeNull();
  expect(addBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox.width).toBeLessThanOrEqual(328);
  expect(Math.abs(closeBox.width - addBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(closeBox.x - addBox.x)).toBeLessThanOrEqual(1);
  expect(addBox.y).toBeLessThan(closeBox.y);
});

test('keeps Assistant lifecycle feedback clear of Chat actions', async ({ page }) => {
  await routeReadyChat(page);
  await page.route('https://shimpz.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body><button type="button">Uninstall</button><script>
      parent.postMessage({ type: 'shimpz:assistant-store-frame', version: 2, height: 420 }, '*');
      document.querySelector('button').addEventListener('click', () => parent.postMessage({
        type: 'shimpz:assistant-uninstall', version: 2, assistant: 'shimpz-cloudflare'
      }, '*'));
    </script></body></html>`,
  }));
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistant: 'shimpz-cloudflare', uninstalled: true }),
  }));

  await page.goto('/assistants/');
  await page.frameLocator('iframe').getByRole('button', { name: 'Uninstall' }).click();
  const dialog = page.getByRole('dialog', { name: 'Uninstall Shimpz Cloudflare?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Uninstall Assistant' }).click();
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText('Shimpz Cloudflare was removed from Marketing.');
  await expect(toast).toHaveCSS('position', 'relative');
  const [toastOnStoreBox, introBox, contentBox] = await Promise.all([
    toast.boundingBox(),
    page.locator('.shimpz-page-intro').boundingBox(),
    page.locator('.authenticated-content').boundingBox(),
  ]);
  expect(toastOnStoreBox).not.toBeNull();
  expect(introBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(Math.abs(toastOnStoreBox.x - contentBox.x)).toBeLessThan(1);
  expect(Math.abs(toastOnStoreBox.width - contentBox.width)).toBeLessThan(1);
  expect(toastOnStoreBox.y + toastOnStoreBox.height).toBeLessThanOrEqual(introBox.y);
  await expect(page).toHaveScreenshot('assistant-lifecycle-alert.png', visualContract);
  await page.getByRole('link', { name: 'Chat' }).click();
  await expect(page).toHaveURL(/\/chat\/?$/);
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  const [toastBox, actionsBox, chatBox] = await Promise.all([
    toast.boundingBox(),
    page.locator('.composer-actions').boundingBox(),
    page.locator('.chat-route').boundingBox(),
  ]);
  expect(toastBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(chatBox.y);
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(page.viewportSize().height);
  const intersectsActions = (
    toastBox.x < actionsBox.x + actionsBox.width &&
    toastBox.x + toastBox.width > actionsBox.x &&
    toastBox.y < actionsBox.y + actionsBox.height &&
    toastBox.y + toastBox.height > actionsBox.y
  );
  expect(intersectsActions).toBe(false);
});

test('matches the ready Chat visual contract without horizontal overflow', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  await expect(page).toHaveScreenshot('chat-ready.png', visualContract);

  await page.getByRole('button', { name: /Brain GPT-5\.6 Terra/i }).click();
  const brainDialog = page.getByRole('dialog', { name: 'Choose a Brain' });
  await expect(brainDialog).toBeVisible();
  await expect(brainDialog.getByText('Current', { exact: true })).toHaveCount(0);
  const selectedModel = brainDialog.getByText('GPT-5.6 Terra', { exact: true });
  const selectedProvider = brainDialog.getByText('OpenAI', { exact: true }).nth(1);
  const [modelBox, providerBox] = await Promise.all([
    selectedModel.boundingBox(),
    selectedProvider.boundingBox(),
  ]);
  expect(modelBox).not.toBeNull();
  expect(providerBox).not.toBeNull();
  expect(providerBox.y).toBeGreaterThanOrEqual(modelBox.y + modelBox.height);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('brain-chooser.png', visualContract);

  await brainDialog.getByRole('button', { name: 'Close' }).click();
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Show the rendered response');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  const userMessage = page.getByRole('article', { name: 'You' });
  await expect(userMessage).toBeVisible();
  expect(await userMessage.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)');
  const [messageBox, exchangeBox] = await Promise.all([
    userMessage.boundingBox(),
    userMessage.locator('xpath=..').boundingBox(),
  ]);
  expect(messageBox).not.toBeNull();
  expect(exchangeBox).not.toBeNull();
  expect(Math.abs((messageBox.x + messageBox.width) - (exchangeBox.x + exchangeBox.width)))
    .toBeLessThanOrEqual(1);
  const receipt = page.locator('.receipt');
  await expect(receipt).toHaveCSS('border-top-width', '0px');
  await expect(page).toHaveScreenshot('chat-completed.png', visualContract);
});
