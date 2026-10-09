import { expect, test } from '@playwright/test';

import { assistantDetails, publicAssistant, stagedSnapshot } from './assistantPages.js';
import { accessibilityViolations } from './axe.js';

// One Assistant's own page (ADR-0087 functional coverage): it reads the exact target for the Team its link names,
// shows its copy, Actions, credentials, and Creator links, and installs or removes it only for that Team.
const ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlN7eIAAAAASUVORK5CYII=',
  'base64',
);
const SESSION = {
  profile: 'local', authenticated: true, initialized: true, authentication_state: 'configured',
  authentication_method: 'webauthn', origin_admitted: true, oauth_completion_mode: 'automatic',
  passkey_enrollment_available: true, passkey_registered: true,
};
const STAGED_PAGE = assistantDetails({
  assistant_version: '0.5.2',
  name: 'Cloudflare',
  creators: ['@shimpz', '@roxygens'],
  summary: "Set up your domains' DNS without opening a dashboard.",
  description: 'Point a subdomain or verify a domain by asking in plain words: it checks what exists and applies a change only after your password.',
  links: { github: 'https://github.com/TheShimpz/shimpz-cloudflare', site: 'https://shimpz.com/', x: 'https://x.com/shimpz' },
  actions: [
    { id: 'delete-dns-record', effect: 'mutating', description: 'Remove one DNS record.' },
    { id: 'get-zone', effect: 'read_only', description: 'See the details of one domain.' },
    { id: 'list-zones', effect: 'read_only', description: 'See your domains.' },
  ],
  integrations: [{ id: 'cloudflare', provider: 'cloudflare' }],
  stored_inputs: [{ id: 'api-token', label: 'Cloudflare API token' }],
});

// `inventory()` is the Team's installed Assistants at each read; `deletes` records every uninstall request.
async function routePage(page, { inventory = () => [], staged = [stagedSnapshot({ name: 'Cloudflare' })], published = [], deletes = [] } = {}) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const locale = url.searchParams.get('locale');
    if (url.pathname.endsWith('/icon') || url.pathname.endsWith('/catalog-icon')) {
      return route.fulfill({ contentType: 'image/png', body: ICON });
    }
    if (/^\/api\/local-assistants\/[0-9a-f]{64}\/details$/.test(url.pathname)) {
      return route.fulfill({ json: { ...STAGED_PAGE, locale } });
    }
    if (url.pathname === '/api/teams/marketing/assistants/shimpz-cloudflare/details') {
      const installed = inventory().find((entry) => entry.assistant === 'shimpz-cloudflare');
      return route.fulfill({ json: { ...STAGED_PAGE, locale, assistant_version: installed.assistant_version } });
    }
    if (url.pathname === '/api/teams/marketing/assistants/shimpz-cloudflare' && request.method() === 'DELETE') {
      deletes.push(url.pathname);
      return route.fulfill({ json: { assistant: 'shimpz-cloudflare', uninstalled: true } });
    }
    const body = {
      '/api/session': SESSION,
      '/api/teams': { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] },
      '/api/assistants': { assistants: [] },
      '/api/teams/marketing/assistants': { assistants: inventory() },
      '/api/teams/marketing/files': { files: [] },
      '/api/assistant-catalog': { version: 1, locale, assistants: published },
      '/api/local-assistants': { assistants: staged, trace_id: 'c'.repeat(32) },
    }[url.pathname];
    return route.fulfill({ status: body ? 200 : 503, json: body ?? {} });
  });
}

test('shows what an Assistant is for, every Action, its credentials, and its Creator links', async ({ page }) => {
  await routePage(page);
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');

  await expect(sheet.getByRole('heading', { level: 1 })).toHaveText('Cloudflare');
  await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(STAGED_PAGE.summary);
  await expect(sheet.getByText(STAGED_PAGE.description, { exact: true })).toBeVisible();
  await expect(sheet.getByText('@roxygens', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();

  // Each list folds behind its own line and opens by keyboard, with every row's slug and plain-language description.
  await sheet.locator('summary').filter({ hasText: 'Credentials' }).focus();
  await page.keyboard.press('Enter');
  await expect(sheet.getByText('cloudflare account', { exact: true })).toBeVisible();
  await expect(sheet.getByText('cloudflare API token', { exact: true })).toBeVisible();
  await sheet.locator('summary').filter({ hasText: 'Read Actions' }).focus();
  await page.keyboard.press('Space');
  await expect(sheet.getByText('get-zone', { exact: true })).toBeVisible();
  await expect(sheet.getByText('see your domains.', { exact: true })).toBeVisible();
  await expect(sheet.getByText('remove one DNS record.', { exact: true })).toBeHidden();
  await sheet.getByText('Write Actions', { exact: true }).click();
  await expect(sheet.getByText('remove one DNS record.', { exact: true })).toBeVisible();

  // The Creator's links open their own pages in a new browsing context that cannot reach back into Admin.
  const links = sheet.getByRole('navigation', { name: 'Creator links' });
  await expect(links.getByRole('link')).toHaveText(['Website', 'GitHub', 'X']);
  for (const [name, href] of [['Website', 'https://shimpz.com/'], ['GitHub', STAGED_PAGE.links.github]]) {
    const link = links.getByRole('link', { name });
    await expect(link).toHaveAttribute('href', href);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }

  // The Assistant page's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('works by touch on a phone: lists open and the action reaches its dialog', { tag: '@mobile' }, async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, 'the phone projects prove the touch path');
  await routePage(page);
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');
  await sheet.getByText('Write Actions', { exact: true }).tap();
  await expect(sheet.getByText('remove one DNS record.', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Install', exact: true }).tap();
  await expect(page.getByRole('dialog', { name: 'Install Cloudflare?' })).toBeVisible();
});

test('shows no link rail for an Assistant that declares no Creator links', async ({ page }) => {
  await routePage(page, { staged: [], published: [publicAssistant({ links: {} })] });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');
  await expect(sheet.getByRole('heading', { level: 1 })).toHaveText('Shimpz Cloudflare');
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
  await expect(sheet.getByRole('navigation')).toHaveCount(0);
});

test('refuses an uninstall when the installed Assistant changed after its dialog opened', async ({ page }) => {
  let version = '0.5.2';
  const deletes = [];
  await routePage(page, {
    inventory: () => [{ assistant: 'shimpz-cloudflare', assistant_version: version, status: 'running', provenance: 'local' }],
    deletes,
  });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');
  await expect(sheet.getByText('Installed in this Team', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Uninstall', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Uninstall Cloudflare?' });
  await expect(dialog).toBeVisible();

  // The Team now runs another version of this Assistant than the one the dialog was opened for.
  version = '0.6.0';
  await dialog.getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('This Assistant changed in this Team. Review its page again.');
  expect(deletes).toEqual([]);
});

test('names no action for an Assistant this Team cannot see and for a Team the link does not name', async ({ page }) => {
  await routePage(page, { staged: [] });
  await page.goto('/assistants/not-staged?team=marketing');
  const sheet = page.getByRole('article');
  await expect(sheet.getByText('This Assistant is not in the Assistants of this Team.', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button')).toHaveCount(0);
  await expect(page.locator('[data-slot="boot-screen"]')).toHaveCount(0);

  await routePage(page);
  await page.goto('/assistants/shimpz-cloudflare?team=missing');
  await expect(page.getByText('The Team in this link is not available. Choose a Team from the Team list.')).toBeVisible();
  await expect(page.getByRole('article').getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
});
