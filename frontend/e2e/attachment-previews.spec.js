// A sent image in the built Admin (ADR-0093): its message shows a thumbnail drawn from Team's sanitized rendition, the
// thumbnail opens the image over the chat and gives focus back when it closes, a file without a preview keeps its card,
// and a message just sent and then reloaded shows the thumbnail both times. The rendition reaches the page only as an
// image load.
import { expect, test } from '@playwright/test';

import { png } from './png.js';
import { PREVIEW_IMAGES } from './attachmentScenarios.js';
import { routeScenario } from './scenarioRoutes.js';
import { messages } from '../src/lib/i18n/catalogs.js';

const EN = messages.en;
const open = (name) => EN.attachments.openImage.replace('{name}', name);
const PREVIEW_ROUTE = '**/api/teams/marketing/files/*/preview';

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
  const message = page.getByRole('article', { name: EN.chatPage.you });
  const opener = message.getByRole('button', { name: open('Harbour at dusk.jpg'), exact: true });
  await expect(opener.getByRole('img', { name: 'Harbour at dusk.jpg' })).toBeVisible();
  await expect(message.getByRole('button', { name: open('Team portrait.png'), exact: true })).toBeVisible();
  // The thumbnail is the rendition's centred square at 320 device pixels, drawn from one image load of it.
  const shape = await opener.getByRole('img').evaluate((image) => [image.naturalWidth, image.naturalHeight]);
  expect(shape).toEqual([320, 320]);
  await expect.poll(() => requests.map((request) => request.path.split('/')[5]).sort()).toEqual(
    [PREVIEW_IMAGES.landscape, PREVIEW_IMAGES.portrait, PREVIEW_IMAGES.collected].sort(),
  );
  expect(requests.every((request) => request.type === 'image')).toBe(true);
  // A PDF is never asked for, and the image Team no longer holds keeps its card.
  await expect(message.getByRole('listitem').filter({ hasText: 'Launch brief.pdf' })).toBeVisible();
  await expect(message.getByRole('listitem').filter({ hasText: 'Old draft.png' })).toBeVisible();
  await expect(message.getByRole('button', { name: open('Old draft.png'), exact: true })).toHaveCount(0);

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
  await dialog.getByRole('button', { name: EN.attachments.closeImage, exact: true }).click();
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
  // The composer shows the file's card, never a thumbnail of the unsent file.
  await expect(pending.getByRole('img')).toHaveCount(0);
  await composer.fill('What is in this photo?');
  await page.getByRole('button', { name: EN.chatPage.send, exact: true }).click();
  await expect(page.getByText('I read the file you attached.', { exact: false })).toBeVisible();
  const sent = page.getByRole('article', { name: EN.chatPage.you });
  await expect(sent.getByRole('button', { name: open('photo.png'), exact: true })).toBeVisible();
  // The thumbnail asked for the stored file the message carried.
  expect(requests).toHaveLength(1);
  expect(requests[0].path).toMatch(/^\/api\/teams\/marketing\/files\/[0-9a-f]{32}\/preview$/);

  await page.reload();
  const reloaded = page.getByRole('article', { name: EN.chatPage.you });
  await reloaded.getByRole('button', { name: open('photo.png'), exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'photo.png' })).toBeVisible();
});

test('the viewer moves through the message\'s images by its arrows and the arrow keys', async ({ page }) => {
  await openChat(page, 'attachment-images');
  const message = page.getByRole('article', { name: EN.chatPage.you });
  await message.getByRole('button', { name: open('Harbour at dusk.jpg'), exact: true }).click();
  const viewer = page.locator('dialog.image-viewer');
  const previous = viewer.getByRole('button', { name: EN.attachments.previousImage, exact: true });
  const next = viewer.getByRole('button', { name: EN.attachments.nextImage, exact: true });
  await expect(viewer.getByRole('heading', { name: 'Harbour at dusk.jpg' })).toBeVisible();
  // The first image has nowhere to go back to: its arrow stays, disabled.
  await expect(previous).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(viewer.getByRole('heading', { name: 'Team portrait.png' })).toBeVisible();
  await expect(previous).toBeEnabled();
  await next.click();
  // An image Team no longer holds says so, and is the last one.
  await expect(viewer.getByRole('heading', { name: 'Old draft.png' })).toBeVisible();
  await expect(viewer.getByText(EN.attachments.notRead)).toBeVisible();
  await expect(next).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(viewer.getByRole('heading', { name: 'Team portrait.png' })).toBeVisible();
  await previous.click();
  await expect(viewer.getByRole('heading', { name: 'Harbour at dusk.jpg' })).toBeVisible();
});
