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

async function routeReadyChat(page) {
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
  await page.route('**/api/teams/marketing/inference', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ team_id: 'marketing', provider: 'openai', model: 'gpt-5.6-terra' }),
  }));
  await page.route('**/api/teams/marketing/assistant-integrations', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ integrations: [] }),
  }));
  await page.routeWebSocket('**/api/teams/marketing/chat/ws', (socket) => {
    socket.onMessage((message) => {
      const frame = JSON.parse(message);
      if (frame.type === 'sync') {
        socket.send(JSON.stringify({ type: 'sync-empty' }));
      } else if (frame.type === 'chat') {
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
          reply: '**Rendered answer** with a [safe link](https://example.com).',
        }));
      }
    });
  });
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

test('compiled Chat renders Markdown, execution receipt, and the integrations drawer', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop project owns this full workflow.');
  await routeReadyChat(page);
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  const integrations = page.getByRole('button', { name: 'Assistant integrations' });
  await integrations.click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  await expect(drawer).toBeVisible();
  await page.getByRole('button', { name: 'Close integrations' }).click();
  await expect(drawer).toBeHidden();

  await composer.fill('Show the rendered response');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'safe link' })).toHaveAttribute('href', 'https://example.com/');
  await expect(page.getByText(/1 execution stages completed/i)).toBeVisible();
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
