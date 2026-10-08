import { expect, test } from '@playwright/test';
import { LOCALES } from '../src/lib/locales.js';
import { messages } from '../src/lib/messages.js';

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
  es: 'Publica cambios de DNS revisados.',
};
const STAGED = {
  en: 'Inspects staged Cloudflare zones.',
  pt: 'Inspeciona zonas Cloudflare preparadas.',
  es: 'Inspecciona zonas de Cloudflare preparadas.',
};

// Answers each catalog read only once `catalogGate(locale)` settles, so a test can hold one language's reply.
async function routeAssistants(page, { catalogLocale = (locale) => locale, catalogGate = async () => {} } = {}) {
  const requests = { catalog: [], summaries: [] };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const locale = url.searchParams.get('locale');
    if (url.pathname === '/api/assistant-catalog') {
      requests.catalog.push(locale);
      await catalogGate(locale);
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

function held() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function switchLanguage(page, from, to) {
  const name = (code) => LOCALES.find((entry) => entry.code === code).name;
  await page.getByRole('button', { name: messages[from].shell.languageCurrent.replace('{name}', name(from)) }).click();
  await page.getByRole('menuitemradio', { name: name(to) }).click();
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
  await expect.poll(() => requests.catalog).toEqual(['en', 'pt']);
  await expect.poll(() => requests.summaries).toEqual(['pt']);
});

test('a staged summary opens directly in the stored interface language', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  const requests = await routeAssistants(page);
  await page.goto('/assistants/');
  await expect(page.getByRole('article', { name: /^zone-inspector/ })).toContainText(STAGED.pt);
  await expect(page.getByRole('article', { name: 'dns-publisher' })).toContainText(PUBLISHED.pt);
  await expect.poll(() => requests.catalog).toEqual(['pt']);
  await expect.poll(() => requests.summaries).toEqual(['pt']);
});

test('a public catalog answered in another language is refused instead of shown', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  await routeAssistants(page, { catalogLocale: () => 'en' });
  await page.goto('/assistants/');
  await expect(page.getByRole('article', { name: /^zone-inspector/ })).toBeVisible();
  await expect(page.getByRole('article', { name: 'dns-publisher' })).toHaveCount(0);
});

test("rapid language switches present only the selected language's published summary", async ({ page }) => {
  const gates = { pt: held(), es: held() };
  const requests = await routeAssistants(page, { catalogGate: (locale) => gates[locale]?.promise });
  await page.goto('/assistants/');
  const published = page.getByRole('article', { name: 'dns-publisher' });
  await expect(published).toContainText(PUBLISHED.en);

  await switchLanguage(page, 'en', 'pt');
  // The Portuguese request reaches the server before the next switch supersedes it; a switch made sooner can cancel it
  // in the page before it is ever sent, and then there is no superseded reply to prove.
  await expect.poll(() => requests.catalog).toEqual(['en', 'pt']);
  await switchLanguage(page, 'pt', 'es');
  await expect.poll(() => requests.catalog).toEqual(['en', 'pt', 'es']);
  await expect(published).toBeVisible();
  for (const summary of Object.values(PUBLISHED)) await expect(published).not.toContainText(summary);

  // The superseded Portuguese reply is never presented, even when it is the first to arrive.
  gates.pt.release();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const summary of Object.values(PUBLISHED)) await expect(published).not.toContainText(summary);
  gates.es.release();
  await expect(published).toContainText(PUBLISHED.es);
  // The staged Local summary is shown in the selected language once its catalog is presented.
  await expect(page.getByRole('article', { name: /^zone-inspector/ })).toContainText(STAGED.es);

  // Returning to English hides the Spanish summary until the English catalog is presented again.
  const en = held();
  gates.en = en;
  await switchLanguage(page, 'es', 'en');
  await expect.poll(() => requests.catalog).toEqual(['en', 'pt', 'es', 'en']);
  for (const summary of Object.values(PUBLISHED)) await expect(published).not.toContainText(summary);
  en.release();
  await expect(published).toContainText(PUBLISHED.en);
  await expect(published).not.toContainText(PUBLISHED.es);
});
