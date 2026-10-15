import { expect, test } from '@playwright/test';
import { messages } from '../src/lib/i18n/catalogs.js';
import { assistantDetails } from './assistantPages.js';
import { switchLanguage } from './interaction.js';
import { routeRead } from './scenarioRoutes.js';
import { authenticatedLocalSession } from './scenarios.js';

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
    platform: 'linux/amd64', provenance: 'local', unpublished: true, admission: 'admissible', reason: null,
  };
}

function refusal(code, status) {
  return { status, json: { detail: 'Local Assistant preview failed admission', code } };
}

// `preview(imageId)` answers one image's icon, summary, and page: `{ status, json }` for a refusal, or a promise of one.
// `bindings(assistantId)` answers an installed Assistant's page the same way.
async function routeStore(page, { snapshots, preview, installed = () => [], installs = [], bindings = () => ({}) }) {
  const ok = (json, status = 200) => ({ status, json });
  await routeRead(page, 'teams.list', () => ok({ teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] }));
  await routeRead(page, 'assistants.registry', () => ok({ assistants: [] }));
  await routeRead(page, 'assistants.list', () => ok({ assistants: installed() }));
  await routeRead(page, 'store.catalog', ({ locale }) => ok({ version: 1, locale, assistants: [], next: null }));
  await routeRead(page, 'snapshots.list', () => ok({ assistants: snapshots(), trace_id: 'c'.repeat(32) }));
  await routeRead(page, 'snapshots.summary', async ({ image_id: imageId, locale }) => {
    const answer = await preview(imageId);
    return answer.status ? answer : ok({ locale, summary: 'Exercises Local snapshot admission.' });
  });
  await routeRead(page, 'snapshots.details', async ({ image_id: imageId, locale }) => {
    const answer = await preview(imageId);
    if (answer.status) return answer;
    return ok(stagedDetails(snapshots().find((entry) => entry.image_id === imageId), locale));
  });
  await routeRead(page, 'assistants.details', ({ assistant_id: assistantId }) => {
    const answer = bindings(assistantId);
    return { status: answer.status ?? 200, json: answer.json };
  });
  await routeRead(page, 'assistants.install_local', ({ body }) => {
    installs.push(body);
    return ok({ detail: 'Local Assistant snapshot failed admission' }, 409);
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const icon = /^\/api\/local-assistants\/([0-9a-f]{64})\/icon$/.exec(url.pathname);
    if (icon) {
      const answer = await preview(`sha256:${icon[1]}`);
      return route.fulfill(answer.status ? answer : { contentType: 'image/png', body: ICON });
    }
    const body = {
      '/api/session': authenticatedLocalSession(),
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
  await switchLanguage(page, 'en', 'pt');

  await expect(sheet.locator('.icon-frame img')).toHaveAttribute('src', /^blob:/);
  await expect(sheet.getByRole('button', { name: messages.pt.assistantPage.install, exact: true })).toBeEnabled();
  await expect(sheet.getByText(NEXT_ACTION)).toHaveCount(0);
});
