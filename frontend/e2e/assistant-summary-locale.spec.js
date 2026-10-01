import { expect, test } from '@playwright/test';

// ADR-0091: published and staged Assistant summaries follow the interface language. Published summaries come from
// the locale-keyed public catalog; a staged snapshot's comes from its own language pack through Team. English is the
// catalog itself, so an English interface never asks Team for a translation.
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlN7eIAAAAASUVORK5CYII=',
  'base64',
);
const PUBLISHED = {
  en: 'Publishes reviewed DNS changes.',
  pt: 'Publica alterações de DNS revisadas.',
};
const STAGED = {
  en: 'Inspects staged Cloudflare zones.',
  pt: 'Inspeciona zonas Cloudflare preparadas.',
};

async function routeAssistants(page, { catalogLocale = (locale) => locale } = {}) {
  const requests = { catalog: [], summaries: [] };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const locale = url.searchParams.get('locale');
    if (url.pathname === '/api/assistant-catalog') {
      requests.catalog.push(locale);
      return route.fulfill({ json: { version: 1, locale: catalogLocale(locale), assistants: [{
        assistant_id: 'dns-publisher', assistant_version: '1.0.0', creators: ['@creator'],
        icon_digest: `sha256:${'d'.repeat(64)}`, name: 'DNS Publisher',
        source_digest: `sha256:${'c'.repeat(64)}`, summary: PUBLISHED[locale] ?? PUBLISHED.en,
      }] } });
    }
    if (url.pathname === `/api/local-assistants/${IMAGE_ID.slice(7)}/summary`) {
      requests.summaries.push(locale);
      return route.fulfill({ json: { locale, summary: STAGED[locale] } });
    }
    if (url.pathname.endsWith('/icon') || url.pathname.endsWith('/catalog-icon')) {
      return route.fulfill({ contentType: 'image/png', body: ICON });
    }
    const body = {
      '/api/session': {
        profile: 'local', authenticated: true, initialized: true, authentication_state: 'configured',
        authentication_method: 'webauthn', origin_admitted: true, oauth_completion_mode: 'automatic',
        passkey_enrollment_available: true, passkey_registered: true,
      },
      '/api/teams': { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] },
      '/api/assistants': { assistants: [] },
      '/api/teams/marketing/assistants': { assistants: [] },
      '/api/local-assistants': {
        assistants: [{
          assistant_id: 'zone-inspector', assistant_version: '0.1.0', name: 'Zone Inspector',
          summary: STAGED.en, actions: ['list-zones'], integrations: ['cloudflare'],
          declared_creators: ['@shimpz'], created_at: '2026-09-17T07:00:00Z', image_id: IMAGE_ID,
          platform: 'linux/amd64', provenance: 'local', unpublished: true,
        }],
        trace_id: 'c'.repeat(32),
      },
    }[url.pathname];
    return route.fulfill({ status: body ? 200 : 503, json: body ?? {} });
  });
  return requests;
}

test('shows published and staged summaries in the interface language and reloads them on a language change', async ({ page }) => {
  const requests = await routeAssistants(page);
  await page.goto('/assistants/');
  const published = page.getByRole('article', { name: 'dns-publisher' });
  const staged = page.getByRole('article', { name: /^zone-inspector/ });
  await expect(published).toContainText(PUBLISHED.en);
  await expect(staged).toContainText(STAGED.en);
  expect(requests.summaries).toEqual([]);

  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: /Português/ }).click();

  await expect(published).toContainText(PUBLISHED.pt);
  await expect(staged).toContainText(STAGED.pt);
  await expect(published).not.toContainText(PUBLISHED.en);
  await expect(staged).not.toContainText(STAGED.en);
  expect(requests.catalog).toEqual(['en', 'pt']);
  expect(requests.summaries).toEqual(['pt']);
});

test('a staged summary opens directly in the stored interface language', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  const requests = await routeAssistants(page);
  await page.goto('/assistants/');
  await expect(page.getByRole('article', { name: /^zone-inspector/ })).toContainText(STAGED.pt);
  await expect(page.getByRole('article', { name: 'dns-publisher' })).toContainText(PUBLISHED.pt);
  expect(requests.catalog).toEqual(['pt']);
  expect(requests.summaries).toEqual(['pt']);
});

test('a public catalog answered in another language is refused instead of shown', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  await routeAssistants(page, { catalogLocale: () => 'en' });
  await page.goto('/assistants/');
  await expect(page.getByRole('article', { name: /^zone-inspector/ })).toBeVisible();
  await expect(page.getByRole('article', { name: 'dns-publisher' })).toHaveCount(0);
});
