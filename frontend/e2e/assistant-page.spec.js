import { expect, test } from '@playwright/test';

import { assistantDetails, publicAssistant, stagedSnapshot } from './assistantPages.js';
import { accessibilityViolations } from './axe.js';
import { switchLanguage } from './interaction.js';
import { messages } from '../src/lib/i18n/catalogs.js';
import { dropSessions, nextRead, raiseTopic, readsOf, routeRead, waitForRead } from './scenarioRoutes.js';
import { authenticatedLocalSession } from './scenarios.js';

// One Assistant's own page (ADR-0087 functional coverage): it reads the exact target for the Team its link names,
// shows its copy, Actions, credentials, and Creator links, and installs or removes it only for that Team.
const ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlN7eIAAAAASUVORK5CYII=',
  'base64',
);
// A credential's help: what the secret is and how to get it, and the official page to get it from (ADR-0090).
const TOKEN_HELP = 'A key that lets this Assistant change your DNS. Open My Profile > API Tokens, create a token, and copy it.';
const TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens';
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
  stored_inputs: [{ id: 'api-token', label: 'Cloudflare API token', description: TOKEN_HELP, help_url: TOKEN_PAGE }],
});

// `inventory()` is the Team's installed Assistants at each read (null fails that read); `deletes` records every
// uninstall request and `deleteStatus` answers it; `stagedStatus` fails the Local snapshot enumeration when it is not
// 200. `stagedGate()`, `inventoryGate()`, and `detailsGate(locale)` (either page) may return a promise that holds that
// reply until it settles.
async function routePage(page, {
  inventory = () => [],
  staged = [stagedSnapshot({ name: 'Cloudflare' })],
  stagedStatus = 200,
  stagedGate = () => undefined,
  published = [],
  deletes = [],
  deleteStatus = 200,
  stagedPage = STAGED_PAGE,
  detailsGate = () => undefined,
  inventoryGate = () => undefined,
  installRefusal = false,
} = {}) {
  const ok = (json, status = 200) => ({ status, json });
  await routeRead(page, 'teams.list', () => ok({ teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] }));
  await routeRead(page, 'assistants.registry', () => ok({ assistants: [] }));
  await routeRead(page, 'store.catalog', ({ locale }) => ok({ version: 1, locale, assistants: published, next: null }));
  await routeRead(page, 'snapshots.list', async () => {
    await stagedGate();
    if (stagedStatus !== 200) {
      return ok({ error: 'unavailable', code: 'local-assistant-snapshots-unavailable' }, stagedStatus);
    }
    return ok({ assistants: staged, trace_id: 'c'.repeat(32) });
  });
  await routeRead(page, 'snapshots.details', async ({ locale }) => {
    await detailsGate(locale);
    const copy = typeof stagedPage === 'function' ? stagedPage(locale) : stagedPage;
    return ok({ ...copy, locale });
  });
  await routeRead(page, 'assistants.list', async ({ team_id: teamId }) => {
    if (teamId !== 'marketing') return undefined;
    // A read that fails is refused (an outage would only be read again until it answers).
    if (inventory() === null) return ok({ assistants: 'unreadable' });
    await inventoryGate();
    return ok({ assistants: inventory() });
  });
  await routeRead(page, 'assistants.details', async ({ team_id: teamId, assistant_id: assistantId, locale }) => {
    if (teamId !== 'marketing' || assistantId !== 'shimpz-cloudflare') return undefined;
    await detailsGate(locale);
    const installed = inventory().find((entry) => entry.assistant === 'shimpz-cloudflare');
    return ok({ ...STAGED_PAGE, locale, assistant_version: installed.assistant_version });
  });
  await routeRead(page, 'assistants.uninstall', ({ team_id: teamId, assistant_id: assistantId }) => {
    if (teamId !== 'marketing' || assistantId !== 'shimpz-cloudflare') return undefined;
    deletes.push(assistantId);
    if (deleteStatus !== 200) return ok({ detail: 'Team refused the request' }, deleteStatus);
    return ok({ assistant: 'shimpz-cloudflare', uninstalled: true });
  });
  for (const method of ['assistants.install', 'assistants.install_local']) {
    await routeRead(page, method, () => (installRefusal
      ? ok({ detail: 'Team is full', code: 'assistant_limit_reached' }, 409)
      : undefined));
  }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/icon') || url.pathname.endsWith('/catalog-icon')) {
      return route.fulfill({ contentType: 'image/png', body: ICON });
    }
    const body = { '/api/session': authenticatedLocalSession() }[url.pathname];
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
  // A secret the person enters says what it is and how to get it, with one link to the page where it is made.
  await expect(sheet.getByText(TOKEN_HELP)).toBeVisible();
  const help = sheet.getByRole('link', { name: 'How to get it ↗' });
  await expect(help).toHaveCount(1);
  await expect(help).toHaveAttribute('href', TOKEN_PAGE);
  await expect(help).toHaveAttribute('target', '_blank');
  await expect(help).toHaveAttribute('rel', 'noopener noreferrer');
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

test('refuses a change when the Team inventory cannot be read right before it', async ({ page }) => {
  let readable = true;
  const deletes = [];
  await routePage(page, {
    inventory: () => (readable
      ? [{ assistant: 'shimpz-cloudflare', assistant_version: '0.5.2', status: 'running', provenance: 'local' }]
      : null),
    deletes,
  });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await page.getByRole('article').getByRole('button', { name: 'Uninstall', exact: true }).click();
  readable = false;
  await page.getByRole('dialog', { name: 'Uninstall Cloudflare?' }).getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByRole('dialog').getByRole('alert'))
    .toHaveText('The Assistants installed in this Team could not be read. Try again.');
  expect(deletes).toEqual([]);
});

test('reports an Assistant another actor already removed as uninstalled without removing it again', async ({ page }) => {
  let installed = true;
  const deletes = [];
  await routePage(page, {
    inventory: () => (installed
      ? [{ assistant: 'shimpz-cloudflare', assistant_version: '0.5.2', status: 'running', provenance: 'local' }]
      : []),
    deletes,
  });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await page.getByRole('article').getByRole('button', { name: 'Uninstall', exact: true }).click();
  installed = false;
  await page.getByRole('dialog', { name: 'Uninstall Cloudflare?' }).getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByText('Assistant uninstalled', { exact: true })).toBeVisible();
  expect(deletes).toEqual([]);
});

test('offers no install when this machine could not list its staged Assistants', async ({ page }) => {
  await routePage(page, { stagedStatus: 503, published: [publicAssistant()] });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');
  await expect(sheet.getByText('The Assistants of this machine could not be read, so none is offered for installation.'))
    .toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
});

test('lists an Integration and a Stored Input that share one id as two credentials', async ({ page }) => {
  await routePage(page, {
    stagedPage: { ...STAGED_PAGE, stored_inputs: [{ ...STAGED_PAGE.stored_inputs[0], id: 'cloudflare' }] },
  });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');
  await sheet.locator('summary').filter({ hasText: 'Credentials' }).click();
  await expect(sheet.getByText('cloudflare account', { exact: true })).toBeVisible();
  await expect(sheet.getByText('cloudflare API token', { exact: true })).toBeVisible();
  await expect(sheet.getByText('cloudflare', { exact: true })).toHaveCount(2);
});


test('reports a failed uninstall in the interface language', async ({ page }) => {
  const copy = messages.pt;
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  await routePage(page, {
    inventory: () => [{ assistant: 'shimpz-cloudflare', assistant_version: '0.5.2', status: 'running', provenance: 'local' }],
    deleteStatus: 500,
  });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await page.getByRole('article').getByRole('button', { name: copy.assistantPage.uninstall, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: copy.store.assistantUninstallConfirm }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(copy.assistantPage.uninstallFailed);
  // The request disabled the button pressed, which takes the focus back as the retry it became.
  await expect(page.getByRole('dialog').getByRole('button', { name: copy.store.assistantActionRetry })).toBeFocused();
});

test('a failed uninstall leaves the focus on the page where the person pressed meanwhile', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await routePage(page, {
    inventory: () => [{ assistant: 'shimpz-cloudflare', assistant_version: '0.5.2', status: 'running', provenance: 'local' }],
    deleteStatus: 500,
  });
  await routeRead(page, 'assistants.uninstall', async () => {
    await held;
    return undefined;
  });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await page.getByRole('article').getByRole('button', { name: messages.en.assistantPage.uninstall, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: messages.en.store.assistantUninstallConfirm }).click();
  await expect(dialog.getByRole('button', { name: messages.en.store.assistantUninstalling })).toBeDisabled();
  // A press on the dialog's text is the person's own move: it focuses the dialog itself, which keeps the focus.
  await dialog.getByRole('heading').first().click();
  await expect(dialog).toBeFocused();
  release();
  await expect(dialog.getByRole('alert')).toHaveText(messages.en.assistantPage.uninstallFailed);
  await expect(dialog.getByRole('button', { name: messages.en.store.assistantActionRetry })).toBeEnabled();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(dialog).toBeFocused();
});

test('reports an install Team refused at its Assistant limit in the interface language', async ({ page }) => {
  const copy = messages.pt;
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  await routePage(page, { installRefusal: true });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await page.getByRole('article').getByRole('button', { name: copy.assistantPage.install, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: copy.store.localInstall, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert'))
    .toHaveText(copy.store.assistantLimitReached.replace('{maximum}', '16'));
  await expect(page.getByRole('dialog').getByRole('button', { name: copy.store.localInstall, exact: true })).toBeFocused();
});

test('an install and its uninstall give the focus to the action that replaced the one that opened the dialog @browser-sensitive', async ({ page }) => {
  let installed = false;
  await routePage(page, {
    staged: [],
    published: [publicAssistant()],
    inventory: () => (installed
      ? [{ assistant: 'shimpz-cloudflare', assistant_version: '0.4.5', status: 'running', provenance: 'published' }]
      : []),
  });
  await routeRead(page, 'assistants.install', () => {
    installed = true;
    return { status: 200, json: { assistant: 'shimpz-cloudflare', installed: true } };
  });
  await routeRead(page, 'assistants.uninstall', () => {
    installed = false;
    return { status: 200, json: { assistant: 'shimpz-cloudflare', uninstalled: true } };
  });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');
  await sheet.getByRole('button', { name: 'Install', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: messages.en.assistantStore.confirm, exact: true }).click();
  await expect(page.getByText('Assistant installed', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Uninstall', exact: true })).toBeFocused();

  await sheet.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByText('Assistant uninstalled', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeFocused();
});

test("an uninstall's Install takes the focus once its staged build's page arrives", async ({ page }) => {
  let installed = true;
  let release = () => {};
  let hold = false;
  await routePage(page, {
    inventory: () => (installed
      ? [{ assistant: 'shimpz-cloudflare', assistant_version: '0.5.2', status: 'running', provenance: 'local' }]
      : []),
    detailsGate: () => (hold ? new Promise((resolve) => { release = resolve; }) : undefined),
  });
  await routeRead(page, 'assistants.uninstall', () => {
    installed = false;
    hold = true;
    return { status: 200, json: { assistant: 'shimpz-cloudflare', uninstalled: true } };
  });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');
  await sheet.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByText('Assistant uninstalled', { exact: true })).toBeVisible();
  const install = sheet.getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeDisabled();
  release();
  await expect(install).toBeEnabled();
  await expect(install).toBeFocused();
});

test("an uninstall's Install hand-off never focuses another Assistant the browser went back to", async ({ page }) => {
  let installed = true;
  let release = () => {};
  let hold = false;
  await routePage(page, {
    published: [publicAssistant({ assistant_id: 'shimpz-github', name: 'Shimpz GitHub' })],
    inventory: () => (installed
      ? [{ assistant: 'shimpz-cloudflare', assistant_version: '0.5.2', status: 'running', provenance: 'local' }]
      : []),
    detailsGate: () => (hold ? new Promise((resolve) => { release = resolve; }) : undefined),
  });
  await routeRead(page, 'assistants.uninstall', () => {
    installed = false;
    hold = true;
    return { status: 200, json: { assistant: 'shimpz-cloudflare', uninstalled: true } };
  });
  // The browser's history holds another Assistant's page, the catalog, then this one, reached through the catalog.
  await page.goto('/assistants/shimpz-github?team=marketing');
  const sheet = page.getByRole('article');
  const other = sheet.getByRole('button', { name: 'Install', exact: true });
  await expect(other).toBeEnabled();
  await sheet.getByRole('link', { name: messages.en.assistantPage.back }).click();
  await page.getByRole('link', { name: /^Cloudflare/ }).click();
  await expect(page).toHaveURL(/\/assistants\/shimpz-cloudflare\?/);
  await sheet.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByText('Assistant uninstalled', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
  // Going back two pages from the browser's history is nobody's move on the page, and the page is the same component.
  await page.evaluate(() => history.go(-2));
  await expect(page).toHaveURL(/\/assistants\/shimpz-github\?/);
  await expect(other).toBeEnabled();
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await settle();
  await expect(other).not.toBeFocused();
  release();
  await settle();
  await expect(other).not.toBeFocused();
});

test("an uninstall's Install gets no focus once the person pressed elsewhere while its staged build's page was read", async ({ page }) => {
  let installed = true;
  let release = () => {};
  let hold = false;
  await routePage(page, {
    inventory: () => (installed
      ? [{ assistant: 'shimpz-cloudflare', assistant_version: '0.5.2', status: 'running', provenance: 'local' }]
      : []),
    detailsGate: () => (hold ? new Promise((resolve) => { release = resolve; }) : undefined),
  });
  await routeRead(page, 'assistants.uninstall', () => {
    installed = false;
    hold = true;
    return { status: 200, json: { assistant: 'shimpz-cloudflare', uninstalled: true } };
  });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');
  await sheet.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByText('Assistant uninstalled', { exact: true })).toBeVisible();
  const install = sheet.getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeDisabled();
  // A press on the Admin version, which nothing focuses, leaves the focus on the document, as the person chose.
  await page.getByText(/^Admin (?:dev|v\d)/).click();
  release();
  await expect(install).toBeEnabled();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('never shows a page read for the previous language once the language changed', async ({ page }) => {
  const portuguese = "Configure o DNS dos seus domínios sem abrir um painel.";
  const portugueseHelp = 'Uma chave que permite a este Assistente alterar seu DNS. Abra Meu perfil > Tokens de API e crie um token.';
  const portugueseToken = { ...STAGED_PAGE.stored_inputs[0], label: 'Token da API da Cloudflare', description: portugueseHelp };
  let releaseEnglish;
  const englishHeld = new Promise((resolve) => { releaseEnglish = resolve; });
  await routePage(page, {
    // Only the English reply names the second Creator, so its copy is recognizable wherever it would appear.
    stagedPage: (locale) => (locale === 'pt'
      ? { ...STAGED_PAGE, creators: ['@shimpz'], summary: portuguese, stored_inputs: [portugueseToken] }
      : STAGED_PAGE),
    detailsGate: (locale) => (locale === 'en' ? englishHeld.then(() => { englishAnswered = true; }) : undefined),
  });
  let englishAnswered = false;
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await waitForRead(page, 'snapshots.details', (params) => params.locale === 'en');

  // The language changes while the English page is still being read.
  await switchLanguage(page, 'en', 'pt');
  await waitForRead(page, 'snapshots.details', (params) => params.locale === 'pt');
  // The English answer arrives after the change; the page drops it.
  releaseEnglish();
  await expect.poll(() => englishAnswered).toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sheet = page.getByRole('article');
  await expect(sheet.getByText('@roxygens', { exact: true })).toHaveCount(0);
  await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(portuguese);
  await expect(sheet.getByText('@roxygens', { exact: true })).toHaveCount(0);
  // A credential's help follows the interface language too, and keeps its one help link.
  await sheet.locator('summary').filter({ hasText: 'Credenciais' }).click();
  await expect(sheet.getByText(portugueseHelp)).toBeVisible();
  await expect(sheet.getByText(TOKEN_HELP)).toHaveCount(0);
  await expect(sheet.getByRole('link', { name: 'Como obter ↗' })).toHaveAttribute('href', TOKEN_PAGE);
});

test('reads an installed Assistant page again when its reply arrived during an inventory read', async ({ page }) => {
  let releaseDetails;
  const detailsHeld = new Promise((resolve) => { releaseDetails = resolve; });
  let holdDetails = true;
  let inventoryHeld;
  let releaseInventory;
  const deletes = [];
  await routePage(page, {
    inventory: () => [{ assistant: 'shimpz-cloudflare', assistant_version: '0.5.2', status: 'running', provenance: 'local' }],
    deletes,
    deleteStatus: 500,
    detailsGate: () => (holdDetails ? detailsHeld.then(() => { detailsServed = true; }) : undefined),
    inventoryGate: () => inventoryHeld,
  });
  let detailsServed = false;
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await waitForRead(page, 'assistants.details', (params) => params.assistant_id === 'shimpz-cloudflare');
  const sheet = page.getByRole('article');
  await sheet.getByRole('button', { name: 'Uninstall', exact: true }).click();

  // The Team inventory is read again right before the uninstall; the page's reply lands during that read.
  inventoryHeld = new Promise((resolve) => { releaseInventory = resolve; });
  const inventoryRequested = nextRead(page, 'assistants.list');
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall Assistant' }).click();
  await inventoryRequested;
  holdDetails = false;
  releaseDetails();
  await expect.poll(() => detailsServed).toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  inventoryHeld = undefined;
  releaseInventory();

  // Team refuses the uninstall and keeps the binding: the page shows its copy instead of loading forever.
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Team did not confirm the removal.');
  expect(deletes).toHaveLength(1);
  await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(STAGED_PAGE.summary);
});

test('an install whose answer is lost with the connection says its outcome is unknown and reads the Team again', async ({ page }) => {
  await routePage(page, { staged: [], published: [publicAssistant()] });
  // Team takes the install, and Admin's connection drops before it answers.
  await routeRead(page, 'assistants.install', () => new Promise(() => {}));
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await page.getByRole('article').getByRole('button', { name: 'Install', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: messages.en.assistantStore.confirm, exact: true }).click();
  await waitForRead(page, 'assistants.install');
  const inventoryReads = (await readsOf(page, 'assistants.list')).length;
  await dropSessions(page);

  await expect(dialog.getByRole('alert')).toHaveText(messages.en.shell.outcomeUnknown);
  // The install is never sent again; the Team's Assistants are read again once Admin is back.
  await expect.poll(async () => (await readsOf(page, 'assistants.list')).length).toBeGreaterThan(inventoryReads);
  expect(await readsOf(page, 'assistants.install')).toHaveLength(1);
});

test('the Store catalog is read in its bounded pages and every page is shown', async ({ page }) => {
  await routePage(page, { staged: [] });
  const assistants = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((name) => publicAssistant({
    assistant_id: `shimpz-${name}`,
    name: `Shimpz ${name[0].toUpperCase()}${name.slice(1)}`,
  }));
  const digest = 'c'.repeat(32);
  await routeRead(page, 'store.catalog', ({ locale, cursor }) => {
    const start = cursor ? Number(cursor.split('.')[0]) : 0;
    const end = Math.min(start + 2, assistants.length);
    return { status: 200, json: {
      version: 1, locale, assistants: assistants.slice(start, end), next: end < assistants.length ? `${end}.${digest}` : null,
    } };
  });
  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: messages.en.store.frameTitle });
  for (const assistant of assistants) {
    await expect(catalog.getByRole('link', { name: new RegExp(`^${assistant.name}`) })).toBeVisible();
  }
  expect((await readsOf(page, 'store.catalog')).map((params) => params.cursor ?? null))
    .toEqual([null, `2.${digest}`, `4.${digest}`]);
});

test('a snapshot staged elsewhere appears once Admin says the staged Assistants changed', async ({ page }) => {
  const staged = [stagedSnapshot({ name: 'Cloudflare' })];
  await routePage(page, { staged });
  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: messages.en.store.frameTitle });
  await expect(catalog.getByRole('link', { name: /^Cloudflare/ })).toBeVisible();
  await expect(catalog.getByRole('link', { name: /^Exa Search/ })).toHaveCount(0);

  staged.push(stagedSnapshot({ assistant_id: 'shimpz-exa', name: 'Exa Search', image_id: `sha256:${'c'.repeat(64)}` }));
  await raiseTopic(page, 'local-assistants');
  await expect(catalog.getByRole('link', { name: /^Exa Search/ })).toBeVisible();
});

test('the catalog recovers from a Store catalog that was briefly unavailable without a reload', async ({ page }) => {
  await routePage(page, { staged: [] });
  let unavailable = true;
  await routeRead(page, 'store.catalog', ({ locale }) => (unavailable
    ? { status: 502, json: { detail: 'Assistant catalog is unavailable' } }
    : { status: 200, json: { version: 1, locale, assistants: [publicAssistant()], next: null } }));
  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: messages.en.store.frameTitle });
  await expect(catalog.getByText('Assistant catalog is unavailable', { exact: true })).toBeVisible();
  unavailable = false;
  // The catalog is read again on its own, and the failure leaves with it.
  await expect(catalog.getByRole('link', { name: /^Shimpz Cloudflare/ })).toBeVisible({ timeout: 15_000 });
  await expect(catalog.getByText('Assistant catalog is unavailable', { exact: true })).toHaveCount(0);
});

test('a change Admin announces while the staged Assistants are read reads them once more, after that read', async ({ page }) => {
  const staged = [stagedSnapshot({ name: 'Cloudflare' })];
  let release;
  let held = false;
  await routePage(page, {
    staged,
    stagedGate: () => (held ? new Promise((resolve) => { release = resolve; }) : undefined),
  });
  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: messages.en.store.frameTitle });
  await expect(catalog.getByRole('link', { name: /^Cloudflare/ })).toBeVisible();
  const before = (await readsOf(page, 'snapshots.list')).length;

  // A first change starts a read Admin holds; a second change lands while it runs.
  held = true;
  await raiseTopic(page, 'local-assistants');
  await expect.poll(async () => (await readsOf(page, 'snapshots.list')).length).toBe(before + 1);
  held = false;
  staged.push(stagedSnapshot({ assistant_id: 'shimpz-exa', name: 'Exa Search', image_id: `sha256:${'c'.repeat(64)}` }));
  await raiseTopic(page, 'local-assistants');
  release();
  await expect(catalog.getByRole('link', { name: /^Exa Search/ })).toBeVisible();
  // Exactly one more read follows the held one.
  await expect.poll(async () => (await readsOf(page, 'snapshots.list')).length).toBe(before + 2);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(await readsOf(page, 'snapshots.list')).toHaveLength(before + 2);
});

test('an Assistant staged elsewhere opens on its own page once Admin says the staged Assistants changed', async ({ page }) => {
  const staged = [];
  await routePage(page, { staged });
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const sheet = page.getByRole('article');
  await expect(sheet.getByText(messages.en.assistantPage.notFound)).toBeVisible();
  staged.push(stagedSnapshot({ name: 'Cloudflare' }));
  await raiseTopic(page, 'local-assistants');
  await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(STAGED_PAGE.summary);
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
});

test('this machine\'s staged Assistants are read again on their own after Team briefly could not list them', async ({ page }) => {
  let status = 503;
  await routePage(page, { published: [publicAssistant({ assistant_id: 'shimpz-exa', name: 'Exa Search' })] });
  await routeRead(page, 'snapshots.list', () => (status === 503
    ? { status: 503, json: { error: 'unavailable', code: 'local-assistant-snapshots-unavailable' } }
    : undefined));
  await page.goto('/assistants/?team=marketing');
  const catalog = page.getByRole('region', { name: messages.en.store.frameTitle });
  await expect(catalog.getByRole('button', { name: messages.en.store.localRetry })).toBeVisible();
  await expect(catalog.getByRole('link', { name: /^Exa Search/ })).toBeVisible();
  status = 200;
  await expect(catalog.getByRole('link', { name: /^Cloudflare/ })).toBeVisible({ timeout: 15_000 });
  await expect(catalog.getByRole('button', { name: messages.en.store.localRetry })).toHaveCount(0);
});

test('an icon that never arrives shows as unavailable once its load gives up', async ({ page }) => {
  await routePage(page);
  // The staged icon is asked for and never answered.
  await page.route('**/api/local-assistants/*/icon', () => {});
  await page.clock.install();
  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  const icon = page.getByRole('article').locator('.shimpz-assistant-icon');
  await expect(icon).toHaveAttribute('data-state', 'loading');
  await page.clock.runFor(30_000);
  await expect(icon).toHaveAttribute('data-state', 'failed');
});
