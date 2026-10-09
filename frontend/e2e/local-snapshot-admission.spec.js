import { expect, test } from '@playwright/test';
import { LOCALES } from '../src/lib/locales.js';
import { messages } from '../src/lib/messages.js';
import { assistantDetails } from './assistantPages.js';

// Team admits a staged snapshot's preview from the image's own files. A refused preview (409) keeps that Assistant's
// page uninstallable and names the next action; a transient failure stays installable, and every load validates each
// staged image again.
const REFUSED = `sha256:${'a'.repeat(64)}`;
const ADMITTED = `sha256:${'b'.repeat(64)}`;
const UNAVAILABLE = `sha256:${'c'.repeat(64)}`;
const ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlN7eIAAAAASUVORK5CYII=',
  'base64',
);
const NEXT_ACTION = /shimpz assistant stage/;

function snapshot(assistantId, imageId) {
  return {
    assistant_id: assistantId, assistant_version: '0.1.0', name: `Staged ${assistantId}`,
    summary: 'Exercises Local snapshot admission.', actions: ['list-zones'], integrations: [],
    declared_creators: ['@shimpz'], created_at: '2026-09-17T07:00:00Z', image_id: imageId,
    platform: 'linux/amd64', provenance: 'local', unpublished: true,
  };
}

function refusal(code, status) {
  return { status, json: { detail: 'Local Assistant preview failed admission', code } };
}

// `preview(imageId)` answers one image's icon, summary, and page: a route.fulfill options object, or a promise of one.
// `bindings(assistantId)` answers an installed Assistant's page the same way.
async function routeStore(page, { snapshots, preview, installed = () => [], installs = [], bindings = () => ({}) }) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const locale = url.searchParams.get('locale');
    const previewPath = /^\/api\/local-assistants\/([0-9a-f]{64})\/(icon|summary|details)$/.exec(url.pathname);
    if (previewPath) {
      const imageId = `sha256:${previewPath[1]}`;
      const answer = await preview(imageId);
      if (answer.status) return route.fulfill(answer);
      if (previewPath[2] === 'icon') return route.fulfill({ contentType: 'image/png', body: ICON });
      if (previewPath[2] === 'details') {
        const staged = snapshots().find((entry) => entry.image_id === imageId);
        return route.fulfill({ json: stagedDetails(staged, locale) });
      }
      return route.fulfill({ json: { locale, summary: 'Exercises Local snapshot admission.' } });
    }
    const bindingPath = /^\/api\/teams\/marketing\/assistants\/([a-z-]+)\/details$/.exec(url.pathname);
    if (bindingPath) return route.fulfill(bindings(bindingPath[1]));
    if (url.pathname === '/api/teams/marketing/assistants/local') {
      installs.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, json: { detail: 'Local Assistant snapshot failed admission' } });
    }
    const body = {
      '/api/session': {
        profile: 'local', authenticated: true, initialized: true, authentication_state: 'configured',
        authentication_method: 'webauthn', origin_admitted: true, oauth_completion_mode: 'automatic',
        passkey_enrollment_available: true, passkey_registered: true,
      },
      '/api/teams': { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] },
      '/api/assistants': { assistants: [] },
      '/api/teams/marketing/assistants': { assistants: installed() },
      '/api/assistant-catalog': { version: 1, locale: url.searchParams.get('locale'), assistants: [] },
      '/api/local-assistants': { assistants: snapshots(), trace_id: 'c'.repeat(32) },
    }[url.pathname];
    return route.fulfill({ status: body ? 200 : 503, json: body ?? {} });
  });
}

function stagedDetails(staged, locale) {
  return assistantDetails({
    locale,
    assistant_id: staged.assistant_id,
    assistant_version: staged.assistant_version,
    name: staged.name,
    summary: staged.summary,
  });
}

async function openPage(page, assistantId) {
  await page.goto(`/assistants/${assistantId}?team=marketing`);
  return page.getByRole('article');
}

test('keeps a refused staged snapshot uninstallable while transient failures stay installable', async ({ page }) => {
  await routeStore(page, {
    snapshots: () => [
      snapshot('admitted', ADMITTED),
      snapshot('refused', REFUSED),
      snapshot('unavailable', UNAVAILABLE),
    ],
    preview: (imageId) => ({
      [REFUSED]: refusal('local-assistant-preview-invalid', 409),
      [UNAVAILABLE]: refusal('local-assistant-preview-unavailable', 503),
    })[imageId] ?? {},
  });

  let sheet = await openPage(page, 'refused');
  await expect(sheet.getByText(NEXT_ACTION)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();

  sheet = await openPage(page, 'admitted');
  await expect(sheet.locator('.icon-frame img')).toHaveAttribute('src', /^blob:/);
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
  await expect(sheet.getByText(NEXT_ACTION)).toHaveCount(0);

  sheet = await openPage(page, 'unavailable');
  await expect(sheet.getByText('The details of this Assistant could not be read.')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
  await expect(sheet.getByText(NEXT_ACTION)).toHaveCount(0);
});

test('offers no install while a staged preview is still being admitted, and none once it is refused', async ({ page }) => {
  let releasePreview;
  const previewHeld = new Promise((resolve) => { releasePreview = resolve; });
  const installs = [];
  await routeStore(page, {
    snapshots: () => [snapshot('refused', REFUSED)],
    preview: async () => {
      await previewHeld;
      return refusal('local-assistant-preview-invalid', 409);
    },
    installs,
  });

  const sheet = await openPage(page, 'refused');
  const install = sheet.getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeDisabled();
  releasePreview();
  await expect(sheet.getByText(NEXT_ACTION)).toBeVisible();
  await expect(install).toBeDisabled();
  await install.click({ force: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(installs).toEqual([]);
});

test('keeps Uninstall for an installed Local Assistant whose binding no longer reads', async ({ page }) => {
  await routeStore(page, {
    snapshots: () => [snapshot('refused', REFUSED)],
    preview: () => refusal('local-assistant-preview-invalid', 409),
    installed: () => [{ assistant: 'refused', assistant_version: '0.1.0', status: 'invalid', provenance: 'local' }],
    bindings: () => refusal('assistant-manifest-invalid', 409),
  });

  const sheet = await openPage(page, 'refused');
  // The installed binding, not the staged image, is what this page shows: its details are unavailable, it names no
  // staged-image action, and it can still be removed.
  await expect(sheet.getByText('The details of this Assistant could not be read.')).toBeVisible();
  await expect(sheet.getByText(NEXT_ACTION)).toHaveCount(0);
  await expect(sheet.getByRole('heading', { level: 1 })).toHaveText('refused');
  await sheet.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Uninstall refused?' })).toBeVisible();
});

async function reloadInPortuguese(page) {
  const name = (code) => LOCALES.find((entry) => entry.code === code).name;
  await page.getByRole('button', { name: messages.en.shell.languageCurrent.replace('{name}', name('en')) }).click();
  await page.getByRole('menuitemradio', { name: name('pt') }).click();
}

// The same image proves the refusal is never cached: a refusal cached per image would also block it, so a restaged
// new image adds nothing.
test('a refusal is validated again on the next load for the same image', async ({ page }) => {
  let admitted = false;
  await routeStore(page, {
    snapshots: () => [snapshot('restaged', REFUSED)],
    preview: () => (admitted ? {} : refusal('local-assistant-preview-invalid', 409)),
  });

  const sheet = await openPage(page, 'restaged');
  await expect(sheet.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();

  admitted = true;
  await reloadInPortuguese(page);

  await expect(sheet.locator('.icon-frame img')).toHaveAttribute('src', /^blob:/);
  await expect(sheet.getByRole('button', { name: messages.pt.assistantPage.install, exact: true })).toBeEnabled();
  await expect(sheet.getByText(NEXT_ACTION)).toHaveCount(0);
});
