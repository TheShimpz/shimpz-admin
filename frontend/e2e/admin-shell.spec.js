import { expect, test } from '@playwright/test';

test('renders the Local setup through the shared design system', async ({ page }) => {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ profile: 'local', authenticated: false, initialized: false }),
  }));

  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel(/password/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /create password/i })).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-image', 'none');
  await expect(page.locator('.shimpz-panel')).toHaveCount(1);
});

test('renders authenticated navigation with canonical primitives', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable in the presentation contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ profile: 'local', authenticated: true, origin_admitted: true }),
  }));

  await page.goto('/assistants/');

  await expect(page.getByRole('link', { name: /assistants/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /chat/i })).toBeVisible();
  await expect(page.locator('.shimpz-nav-item')).toHaveCount(2);
  await expect(page.locator('body')).toHaveCSS('background-image', 'none');
});

test('opens the Store destination workflow through shared modal controls', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
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
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
  await page.route('**/api/teams/marketing/files', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ files: [] }),
  }));

  await page.goto('/assistants/');
  const destination = page.getByRole('button', { name: /marketing/i });
  await expect(destination).toBeVisible();
  await destination.click();

  await expect(page.getByRole('dialog', { name: 'Choose a destination Team' })).toBeVisible();
  await expect(page.getByRole('button', { name: /marketing/i }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a destination Team' })).toBeHidden();

  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: 'Português' }).click();
  await expect(page.locator('iframe')).toHaveAttribute('src', /\/pt\/assistants\/embed/);
  await expect(page.getByText('Carregando a Store de Assistants…')).toBeVisible();
});
