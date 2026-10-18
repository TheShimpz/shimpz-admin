// A reply's files from the web in the built Admin (ADR-0117 §7): each is a card under the reply that says where it came
// from; its download opens the dialog that records the Supervisor's acknowledgement with Team before saving it, and a
// cancelled or refused acknowledgement saves nothing. Such a file opens only through Team's renditions.
import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { DOWNLOAD_FIXTURE, WEB_FILES } from './attachmentScenarios.js';
import { routeRead, routeScenario, sessionCalls } from './scenarioRoutes.js';
import { messages } from '../src/lib/i18n/catalogs.js';

const EN = messages.en;
const WEB = EN.attachments.web;
const DOWNLOAD_ROUTE = '**/api/teams/marketing/files/*/download';
const downloadLink = (list, name) => list.getByRole('link', { name: EN.attachments.downloadNamed.replace('{name}', name) });

async function openChat(page) {
  await routeScenario(page, 'browser-files');
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: EN.chatPage.send, exact: true })).toBeEnabled({ timeout: 20_000 });
  return page.locator('.conversation').getByRole('list', { name: WEB.list });
}

const acknowledgements = async (page) => (await sessionCalls(page)).filter((call) => call.method === 'files.acknowledge');

test('a file from the web is saved only once its acknowledgement was recorded @browser-sensitive', async ({ page }) => {
  const files = await openChat(page);
  await expect(files.getByRole('listitem')).toHaveCount(2);
  await expect(files.getByRole('listitem').filter({ hasText: WEB_FILES.pdf.name })).toContainText(WEB.origin);
  await page.route(DOWNLOAD_ROUTE, (route) => route.continue());

  // Cancelling records nothing and saves nothing.
  const dialog = page.getByRole('dialog', { name: WEB.title });
  await downloadLink(files, WEB_FILES.pdf.name).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(WEB_FILES.pdf.name);
  await dialog.getByRole('button', { name: WEB.cancel }).click();
  await expect(dialog).toHaveCount(0);
  expect(await acknowledgements(page)).toEqual([]);

  // Downloading records the acknowledgement of exactly that file, then saves its original.
  await downloadLink(files, WEB_FILES.pdf.name).click();
  const saved = page.waitForEvent('download');
  await dialog.getByRole('button', { name: WEB.download }).click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe(WEB_FILES.pdf.name);
  expect(readFileSync(await download.path(), 'utf8')).toBe(DOWNLOAD_FIXTURE);
  await expect(dialog).toHaveCount(0);
  expect(await acknowledgements(page)).toEqual([
    { method: 'files.acknowledge', params: { team_id: 'marketing', file_id: WEB_FILES.pdf.id } },
  ]);
});

test('a refused acknowledgement keeps the dialog open and saves nothing', async ({ page }) => {
  const files = await openChat(page);
  await routeRead(page, 'files.acknowledge', () => ({
    status: 403,
    json: { detail: 'file acknowledgement unavailable', code: 'file-acknowledgement-required' },
  }));
  let downloads = 0;
  await page.route(DOWNLOAD_ROUTE, (route) => {
    downloads += 1;
    return route.continue();
  });
  await downloadLink(files, WEB_FILES.text.name).click();
  const dialog = page.getByRole('dialog', { name: WEB.title });
  await dialog.getByRole('button', { name: WEB.download }).click();
  await expect(dialog.getByText(WEB.failed)).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(downloads).toBe(0);
});

test('an attachment Team holds as from the web asks for the same acknowledgement before it is saved', async ({
  page,
}) => {
  await openChat(page);
  // Team refuses the person's own copy, whose bytes the Browser downloaded too, until it is acknowledged.
  await page.route(`**/api/teams/marketing/files/${WEB_FILES.copy.id}/download`, (route) => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'file download unavailable', code: 'file-acknowledgement-required' }),
  }));
  const sent = page.locator('.conversation').getByRole('list', { name: EN.attachments.list });
  await downloadLink(sent, WEB_FILES.copy.name).click();
  const dialog = page.getByRole('dialog', { name: WEB.title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: WEB.cancel }).click();
  // From then on the card says where its bytes came from.
  await expect(sent.getByRole('listitem').filter({ hasText: WEB_FILES.copy.name })).toContainText(WEB.origin);
  expect(await acknowledgements(page)).toEqual([]);
});

test('a file from the web opens only through Team renditions, never its own text', async ({ page }) => {
  const files = await openChat(page);
  // The PDF opens over the chat; the text file, whose viewer would read its original, has no viewer.
  await expect(files.getByRole('button', { name: EN.attachments.openFile.replace('{name}', WEB_FILES.pdf.name) }))
    .toBeVisible();
  await expect(files.getByRole('button', { name: EN.attachments.openFile.replace('{name}', WEB_FILES.text.name) }))
    .toHaveCount(0);
  await expect(downloadLink(files, WEB_FILES.text.name)).toBeVisible();
});
