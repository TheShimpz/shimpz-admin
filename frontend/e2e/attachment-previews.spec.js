// A sent message's files in the built Admin (ADR-0093): an image's card shows a thumbnail drawn from Team's sanitized
// rendition, every card opens its file over the chat and gives focus back when it closes, a PDF shows Team's renditions
// of its pages, a text file shows its own text as text, a file without a preview keeps its badge, an image Team cannot
// read is left out, and a message just sent and then reloaded shows the thumbnail both times. An image's rendition
// reaches the page only as an image load.
import { expect, test } from '@playwright/test';

import { png } from './png.js';
import { PREVIEW_IMAGES } from './attachmentScenarios.js';
import { routeScenario } from './scenarioRoutes.js';
import { messages } from '../src/lib/i18n/catalogs.js';

const EN = messages.en;
const open = (name) => EN.attachments.openFile.replace('{name}', name);
const PREVIEW_ROUTE = '**/api/teams/marketing/files/*/preview';
const PAGE_ROUTE = '**/api/teams/marketing/files/*/pages/*/preview';
const DOWNLOAD_ROUTE = '**/api/teams/marketing/files/*/download';
const PAGE_COUNT = 2;

const RENDITION = png(600, 400);

// Team's rendition of every file of Marketing, except one it no longer holds; every request the page sends is kept.
async function routePreviews(page) {
  const requests = [];
  await page.route(PREVIEW_ROUTE, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ path, type: request.resourceType() });
    if (path.split('/')[5] === PREVIEW_IMAGES.collected) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"file-not-found"}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      body: RENDITION,
    });
  });
  return requests;
}

// Open Marketing's chat in `scenario`, its image renditions routed after the scenario so they answer first.
async function openChat(page, scenario) {
  await routeScenario(page, scenario);
  const requests = await routePreviews(page);
  await page.goto('/chat/?team=marketing');
  const composer = page.getByRole('textbox', { name: EN.chatPage.send, exact: true });
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  return { composer, requests };
}

test('a sent image opens from its thumbnail and every way of closing it gives focus back @browser-sensitive', async ({
  page,
}) => {
  const { requests } = await openChat(page, 'attachment-images');
  // A message's files sit below its text, inside it.
  const message = page.locator('.conversation').getByRole('list', { name: EN.attachments.list });
  const opener = message.getByRole('button', { name: open('Harbour at dusk.jpg'), exact: true });
  await expect(opener.locator('img')).toBeVisible();
  await expect(message.getByRole('button', { name: open('Team portrait.png'), exact: true })).toBeVisible();
  // The thumbnail keeps the rendition's proportions, drawn from one image load of it.
  const shape = await opener.locator('img').evaluate((image) => [image.naturalWidth, image.naturalHeight]);
  expect(shape).toEqual([600, 400]);
  await expect.poll(() => requests.map((request) => request.path.split('/')[5]).sort()).toEqual(
    [PREVIEW_IMAGES.landscape, PREVIEW_IMAGES.portrait, PREVIEW_IMAGES.collected].sort(),
  );
  expect(requests.every((request) => request.type === 'image')).toBe(true);
  // A PDF's pages are asked for only once it is opened, and the image Team no longer holds is left out.
  await expect(message.getByRole('listitem').filter({ hasText: 'Launch brief.pdf' })).toBeVisible();
  await expect(message.getByRole('listitem').filter({ hasText: 'Old draft.png' })).toHaveCount(0);

  const dialog = page.getByRole('dialog', { name: 'Harbour at dusk.jpg' });
  await opener.click();
  await expect(dialog).toBeVisible();
  // The dialog shows the full rendition at its own size, never the 480-pixel thumbnail.
  const full = dialog.getByRole('img', { name: 'Harbour at dusk.jpg' });
  await expect.poll(() => full.evaluate((image) => image.complete && image.naturalWidth)).toBe(600);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await dialog.getByRole('button', { name: EN.attachments.closeViewer, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(dialog).toBeVisible();
  // A click on the backdrop, outside the image and its header, closes it too.
  await page.mouse.click(4, 4);
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('an image just sent shows its thumbnail, and so does its message after a reload', async ({ page }) => {
  const { composer, requests } = await openChat(page, 'attachments');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: EN.attachments.attach, exact: true }).click();
  await (await chooser).setFiles([{ name: 'photo.png', mimeType: 'image/png', buffer: RENDITION }]);
  const pending = page.locator('form').getByRole('list', { name: EN.attachments.list });
  await expect(pending.getByRole('listitem').filter({ hasText: 'photo.png' })).not.toHaveAttribute('aria-busy');
  // Once Team stored it, the composer shows its thumbnail as the sent message will, never one of the local file.
  await expect(pending.getByRole('button', { name: open('photo.png'), exact: true }).locator('img')).toBeVisible();
  await composer.fill('What is in this photo?');
  await page.getByRole('button', { name: EN.chatPage.send, exact: true }).click();
  await expect(page.getByText('I read the file you attached.', { exact: false })).toBeVisible();
  const sent = page.locator('.conversation').getByRole('list', { name: EN.attachments.list });
  await expect(sent.getByRole('button', { name: open('photo.png'), exact: true }).locator('img')).toBeVisible();
  // Both thumbnails come from one request for the stored file the message carried.
  expect(requests).toHaveLength(1);
  expect(requests[0].path).toMatch(/^\/api\/teams\/marketing\/files\/[0-9a-f]{32}\/preview$/);

  await page.reload();
  const reloaded = page.locator('.conversation').getByRole('list', { name: EN.attachments.list });
  await reloaded.getByRole('button', { name: open('photo.png'), exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'photo.png' })).toBeVisible();
});

test('the viewer moves through the message\'s files by its arrows and the arrow keys', async ({ page }) => {
  await openChat(page, 'attachment-images');
  const message = page.locator('.conversation').getByRole('list', { name: EN.attachments.list });
  // The image Team no longer holds is left out once its thumbnail fails, so the viewer holds the four others.
  await expect(message.getByRole('listitem').filter({ hasText: 'Old draft.png' })).toHaveCount(0);
  await message.getByRole('button', { name: open('Harbour at dusk.jpg'), exact: true }).click();
  const viewer = page.locator('dialog.file-viewer');
  const previous = viewer.getByRole('button', { name: EN.attachments.previousFile, exact: true });
  const next = viewer.getByRole('button', { name: EN.attachments.nextFile, exact: true });
  await expect(viewer.getByRole('heading', { name: 'Harbour at dusk.jpg' })).toBeVisible();
  // The first file has nowhere to go back to: its arrow stays, disabled.
  await expect(previous).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(viewer.getByRole('heading', { name: 'Team portrait.png' })).toBeVisible();
  await expect(previous).toBeEnabled();
  await page.keyboard.press('ArrowLeft');
  await expect(viewer.getByRole('heading', { name: 'Harbour at dusk.jpg' })).toBeVisible();
  await next.click();
  await expect(viewer.getByRole('heading', { name: 'Team portrait.png' })).toBeVisible();
  await next.click();
  await expect(viewer.getByRole('heading', { name: 'Launch brief.pdf' })).toBeVisible();
  await next.click();
  await expect(viewer.getByRole('heading', { name: 'Campaign notes.md' })).toBeVisible();
  // The last file has nowhere to go on to.
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(viewer.getByRole('heading', { name: 'Launch brief.pdf' })).toBeVisible();
});

test('a PDF opens on Team\'s renditions of its pages and a text file on its own text, shown as text', async ({ page }) => {
  const pages = [];
  await openChat(page, 'attachment-images');
  await page.route(PAGE_ROUTE, (route) => {
    const number = Number(new URL(route.request().url()).pathname.split('/')[7]);
    pages.push(number);
    if (number > PAGE_COUNT) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"file-not-found"}' });
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'cache-control': 'no-store', 'x-page-count': String(PAGE_COUNT) },
      body: RENDITION,
    });
  });
  await page.route(DOWNLOAD_ROUTE, (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    headers: { 'content-disposition': 'attachment', 'cache-control': 'no-store' },
    body: '# Notes\n<b>never markup</b>\n',
  }));
  const message = page.locator('.conversation').getByRole('list', { name: EN.attachments.list });
  // The whole card opens its file, not only its badge.
  await message.getByRole('listitem').filter({ hasText: 'Launch brief.pdf' }).getByText('PDF ·').click();
  const viewer = page.getByRole('dialog', { name: 'Launch brief.pdf' });
  for (const number of [1, 2]) {
    const sheet = viewer.getByRole('img', { name: EN.attachments.pageNumber.replace('{page}', String(number)) });
    await sheet.scrollIntoViewIfNeeded();
    await expect.poll(() => sheet.evaluate((image) => image.complete && image.naturalWidth)).toBe(600);
  }
  // Only the document's own pages are asked for, each once.
  expect([...pages].sort()).toEqual([1, 2]);

  await page.keyboard.press('ArrowRight');
  const notes = page.getByRole('dialog', { name: 'Campaign notes.md' });
  await expect(notes.getByText('<b>never markup</b>')).toBeVisible();
  await expect(notes.locator('b')).toHaveCount(0);
});

test('a stored file\'s card offers its download under its own name', async ({ page }) => {
  await openChat(page, 'attachment-images');
  await page.route(DOWNLOAD_ROUTE, (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    headers: { 'content-disposition': 'attachment', 'cache-control': 'no-store' },
    body: 'brief',
  }));
  const message = page.locator('.conversation').getByRole('list', { name: EN.attachments.list });
  const link = message.getByRole('link', { name: EN.attachments.downloadNamed.replace('{name}', 'Launch brief.pdf') });
  const saved = page.waitForEvent('download');
  await link.click();
  expect((await saved).suggestedFilename()).toBe('Launch brief.pdf');
  // Downloading never opens the viewer.
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
