import { expect, test } from '@playwright/test';

const visualContract = {
  animations: 'disabled',
  fullPage: true,
  maxDiffPixels: 100,
};

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
  await expect(page.locator('.shimpz-card')).toHaveCount(1);
  await expect(page).toHaveScreenshot('setup-surface.png', visualContract);
});

test('uses the compact locale control at 360 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ profile: 'local', authenticated: false, initialized: false }),
  }));
  await page.goto('/');
  await expect(page.locator('.locale-full')).toBeHidden();
  await expect(page.locator('.locale-compact')).toBeVisible();
  await page.locator('.locale-compact').getByRole('button', { name: 'Language: English' }).click();
  await expect(page.getByRole('menu', { name: 'Language' })).toBeVisible();
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
  await expect(page.getByText('Loading the Assistant Store…', { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot('authenticated-shell.png', visualContract);

  const localeTrigger = page.getByRole('button', { name: 'Language: English' });
  await localeTrigger.click();
  const localeMenu = page.getByRole('menu', { name: 'Language' });
  await expect(localeMenu).toBeVisible();
  const [iconBox, labelBox] = await Promise.all([
    localeTrigger.locator('svg').boundingBox(),
    localeTrigger.getByText('English', { exact: true }).boundingBox(),
  ]);
  expect(iconBox).not.toBeNull();
  expect(labelBox).not.toBeNull();
  expect(labelBox.x - (iconBox.x + iconBox.width)).toBeGreaterThanOrEqual(7);
  await expect(localeMenu.getByRole('menuitemradio').first()).toHaveCSS('border-top-width', '0px');
  await expect(page).toHaveScreenshot('locale-menu.png', visualContract);
});

test('projects the read-only Local platform update status in the authenticated shell', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ profile: 'local', authenticated: true, origin_admitted: true }),
  }));
  await page.route('**/api/platform-release', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      release: `ghcr.io/theshimpz/shimpz-local-release@sha256:${'a'.repeat(64)}`,
      ordinal: 42,
      checked_at: '2026-08-08T22:52:21Z',
      outcome: 'updated',
    }),
  }));

  await page.goto('/assistants/');

  const status = page.getByText('System updated', { exact: true });
  await expect(status).toBeVisible();
  await expect(status.locator('..')).toHaveAttribute('title', 'Local platform release 42');
  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: /Português/ }).click();
  await expect(page.getByText('Sistema atualizado', { exact: true })).toBeVisible();
});

test('opens the Store destination workflow through shared modal controls', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ profile: 'local', authenticated: true, origin_admitted: true }),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [
      { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
      { team_id: 'gestao', team_name: 'Gestão', status: 'running' },
    ] }),
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
  const storeFrame = page.locator('.store-frame');
  await expect(storeFrame).toHaveCSS('border-top-width', '0px');
  await expect(storeFrame).toHaveCSS('border-right-width', '0px');
  await expect(storeFrame).toHaveCSS('border-bottom-width', '0px');
  await expect(storeFrame).toHaveCSS('border-left-width', '0px');
  await expect(storeFrame).toHaveCSS('clip-path', 'none');
  const destination = page.getByRole('button', { name: /marketing/i });
  const destinationContext = page.locator('.destination-context');
  const destinationKicker = destinationContext.getByText('Installation destination', { exact: true });
  const destinationLead = destinationContext.getByText(
    'Assistants listed below will be installed only in Team Marketing.',
    { exact: true },
  );
  const titleBlock = page.locator('.shimpz-page-intro > div').first();
  await expect(destination).toBeVisible();
  await expect(destinationKicker).toBeVisible();
  await expect(destinationLead).toBeVisible();
  await expect(titleBlock).toHaveText('Assistants');
  await expect(destination).toHaveCSS('border-top-width', '0px');
  await expect(destination).toHaveCSS('box-shadow', 'none');
  const [kickerBox, teamBox, changeBox, destinationBox, leadBox, headingBox] = await Promise.all([
    destinationKicker.boundingBox(),
    destination.locator('.destination-name').boundingBox(),
    destination.locator('.destination-change').boundingBox(),
    destination.boundingBox(),
    destinationLead.boundingBox(),
    page.getByRole('heading', { level: 1, name: 'Assistants' }).boundingBox(),
  ]);
  expect(kickerBox).not.toBeNull();
  expect(teamBox).not.toBeNull();
  expect(changeBox).not.toBeNull();
  expect(destinationBox).not.toBeNull();
  expect(leadBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  expect(kickerBox.y + kickerBox.height).toBeLessThanOrEqual(teamBox.y);
  expect(leadBox.y).toBeGreaterThanOrEqual(teamBox.y + teamBox.height);
  expect(Math.abs(teamBox.x - kickerBox.x)).toBeLessThan(1);
  expect(Math.abs(leadBox.x - kickerBox.x)).toBeLessThan(1);
  expect(changeBox.x - (teamBox.x + teamBox.width)).toBeGreaterThanOrEqual(10);
  if (page.viewportSize().width <= 680) {
    expect(destinationBox.y).toBeLessThan(headingBox.y);
  } else {
    expect(destinationBox.x).toBeLessThan(headingBox.x);
    expect(Math.abs(
      (headingBox.y + headingBox.height) - (leadBox.y + leadBox.height),
    )).toBeLessThan(1);
  }
  const intro = page.locator('.shimpz-page-intro');
  await expect(intro).toHaveCSS('border-bottom-width', '0px');
  expect(Number.parseFloat(await intro.evaluate(
    (element) => getComputedStyle(element).paddingBottom,
  ))).toBeGreaterThan(0);
  const [teamFontSize, headingFontSize] = await Promise.all([
    destination.locator('.destination-name').evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).fontSize),
    ),
    page.getByRole('heading', { level: 1, name: 'Assistants' }).evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).fontSize),
    ),
  ]);
  expect(teamFontSize).toBeGreaterThan(headingFontSize);
  const trustBoundary = page.locator('.trust-boundary');
  await expect(trustBoundary).toHaveCSS('border-top-width', '0px');
  await expect(trustBoundary).toHaveCSS('border-right-width', '0px');
  await expect(trustBoundary).toHaveCSS('border-bottom-width', '0px');
  await expect(trustBoundary).toHaveCSS('border-left-width', '3px');
  await expect(trustBoundary.locator('[data-slot="notice-icon"]')).toBeVisible();
  expect(await trustBoundary.evaluate((element) => (
    Math.abs(element.getBoundingClientRect().width - element.parentElement.getBoundingClientRect().width) < 1
  ))).toBe(true);
  const [introBox, trustBox, storeBox, noticeIconBox, noticeBodyBox] = await Promise.all([
    intro.boundingBox(),
    trustBoundary.boundingBox(),
    storeFrame.boundingBox(),
    trustBoundary.locator('[data-slot="notice-icon"]').boundingBox(),
    trustBoundary.locator('[data-slot="notice-body"]').boundingBox(),
  ]);
  expect(introBox).not.toBeNull();
  expect(trustBox).not.toBeNull();
  expect(storeBox).not.toBeNull();
  expect(noticeIconBox).not.toBeNull();
  expect(noticeBodyBox).not.toBeNull();
  expect(trustBox.y).toBeGreaterThanOrEqual(introBox.y + introBox.height);
  expect(storeBox.y).toBeGreaterThanOrEqual(trustBox.y + trustBox.height);
  expect(Math.abs(
    (noticeIconBox.y + noticeIconBox.height / 2) - (noticeBodyBox.y + noticeBodyBox.height / 2),
  )).toBeLessThan(1);
  await expect(intro).toHaveScreenshot('store-destination.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await destination.click();

  const dialog = page.getByRole('dialog', { name: 'Choose a destination Team' });
  await expect(dialog).toBeVisible();
  const currentChoice = dialog.getByRole('button', { name: /marketing.*current/i });
  await expect(currentChoice).toBeVisible();
  await expect(dialog.getByRole('button', { name: /gestão.*gestao/i })).toBeVisible();
  const [dialogBox, markerBox, copyBox, metaBox] = await Promise.all([
    dialog.boundingBox(),
    currentChoice.locator('.marker').boundingBox(),
    currentChoice.locator('.copy').boundingBox(),
    currentChoice.locator('.meta').boundingBox(),
  ]);
  expect(dialogBox).not.toBeNull();
  expect(markerBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  expect(metaBox).not.toBeNull();
  expect(dialogBox.width).toBeLessThanOrEqual(512);
  expect(Math.abs((dialogBox.x + (dialogBox.width / 2)) - (page.viewportSize().width / 2)))
    .toBeLessThanOrEqual(1);
  expect(copyBox.x - (markerBox.x + markerBox.width)).toBeGreaterThanOrEqual(10);
  expect(metaBox.x).toBeGreaterThan(copyBox.x + copyBox.width);
  await expect(dialog).toHaveScreenshot('store-destination-dialog.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a destination Team' })).toBeHidden();

  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: 'Português' }).click();
  await expect(page.locator('iframe')).toHaveAttribute('src', /\/pt\/assistants\/embed/);
  await expect(page.getByText('Carregando a Store de Assistants…')).toBeVisible();

  await page.getByRole('button', { name: /Português/ }).click();
  await page.getByRole('menuitemradio', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.locator('.destination-trigger').click();
  const rtlChoice = page.locator('dialog.destination-dialog[open] .shimpz-choice-item.is-selected');
  const [rtlCopyBox, rtlMetaBox] = await Promise.all([
    rtlChoice.locator('.copy').boundingBox(),
    rtlChoice.locator('.meta').boundingBox(),
  ]);
  expect(rtlCopyBox).not.toBeNull();
  expect(rtlMetaBox).not.toBeNull();
  expect(rtlMetaBox.x + rtlMetaBox.width).toBeLessThan(rtlCopyBox.x);
});
