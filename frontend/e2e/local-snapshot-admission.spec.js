import { expect, test } from '@playwright/test';
import { LOCALES } from '../src/lib/locales.js';
import { messages } from '../src/lib/messages.js';

// Team admits a staged snapshot's preview from the image's own files. A refused preview (409) keeps that card
// uninstallable and names the next action; a transient failure stays installable, and every load validates each
// staged image again.
const REFUSED = `sha256:${'a'.repeat(64)}`;
const ADMITTED = `sha256:${'b'.repeat(64)}`;
const UNAVAILABLE = `sha256:${'c'.repeat(64)}`;
const RESTAGED = `sha256:${'d'.repeat(64)}`;
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

// `preview(imageId)` answers one image's icon and summary: a route.fulfill options object, or a promise of one.
async function routeStore(page, { snapshots, preview, installed = () => [], installs = [] }) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const previewPath = /^\/api\/local-assistants\/([0-9a-f]{64})\/(icon|summary)$/.exec(url.pathname);
    if (previewPath) {
      const answer = await preview(`sha256:${previewPath[1]}`);
      if (answer.status) return route.fulfill(answer);
      if (previewPath[2] === 'icon') return route.fulfill({ contentType: 'image/png', body: ICON });
      const locale = url.searchParams.get('locale');
      return route.fulfill({ json: { locale, summary: 'Exercises Local snapshot admission.' } });
    }
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

function card(page, assistantId) {
  return page.getByRole('article', { name: `${assistantId} — Local` });
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

  await page.goto('/assistants/');

  const refused = card(page, 'refused');
  await expect(refused.getByRole('button', { name: 'Install or replace' })).toBeDisabled();
  await expect(refused.getByRole('status')).toHaveText(NEXT_ACTION);
  await expect(card(page, 'admitted').locator('.shimpz-assistant-icon img')).toHaveAttribute('src', /^blob:/);
  await expect(card(page, 'admitted').getByRole('button', { name: 'Install or replace' })).toBeEnabled();
  await expect(card(page, 'unavailable').getByRole('button', { name: 'Install or replace' })).toBeEnabled();
  await expect(card(page, 'unavailable').getByRole('status')).toHaveCount(0);
});

test('refuses to submit an install when the refusal arrives after the dialog opened', async ({ page }) => {
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

  await page.goto('/assistants/');
  await card(page, 'refused').getByRole('button', { name: 'Install or replace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Install Staged refused?' });
  await expect(dialog).toBeVisible();
  releasePreview();
  await expect(card(page, 'refused').getByRole('status')).toHaveText(NEXT_ACTION);

  await dialog.getByRole('button', { name: 'Install or replace' }).click();
  await expect(dialog.getByText(NEXT_ACTION)).toBeVisible();
  expect(installs).toEqual([]);
});

test('keeps Uninstall for an installed Local Assistant whose staged preview is refused', async ({ page }) => {
  await routeStore(page, {
    snapshots: () => [snapshot('refused', REFUSED)],
    preview: () => refusal('local-assistant-preview-invalid', 409),
    installed: () => [{ assistant: 'refused', assistant_version: '0.1.0', status: 'running', provenance: 'local' }],
  });

  await page.goto('/assistants/');

  const refused = card(page, 'refused');
  await expect(refused.locator('.shimpz-assistant-icon')).toHaveAttribute('data-state', 'failed');
  await expect(refused.getByRole('status')).toHaveCount(0);
  await refused.getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(page.getByRole('dialog', { name: 'Uninstall Staged refused?' })).toBeVisible();
});

async function reloadInPortuguese(page) {
  const name = (code) => LOCALES.find((entry) => entry.code === code).name;
  await page.getByRole('button', { name: messages.en.shell.languageCurrent.replace('{name}', name('en')) }).click();
  await page.getByRole('menuitemradio', { name: name('pt') }).click();
}

for (const [scenario, nextImageId] of [['a restaged new image', RESTAGED], ['the same image', REFUSED]]) {
  test(`a refusal is validated again on the next load for ${scenario}`, async ({ page }) => {
    let imageId = REFUSED;
    let admitted = false;
    await routeStore(page, {
      snapshots: () => [snapshot('restaged', imageId)],
      preview: () => (admitted ? {} : refusal('local-assistant-preview-invalid', 409)),
    });

    await page.goto('/assistants/');
    await expect(card(page, 'restaged').getByRole('button', { name: 'Install or replace' })).toBeDisabled();

    imageId = nextImageId;
    admitted = true;
    await reloadInPortuguese(page);

    const restaged = card(page, 'restaged');
    await expect(restaged.locator('.shimpz-assistant-icon img')).toHaveAttribute('src', /^blob:/);
    await expect(restaged.getByRole('button', { name: messages.pt.store.localInstall })).toBeEnabled();
    await expect(restaged.getByRole('status')).toHaveCount(0);
  });
}
