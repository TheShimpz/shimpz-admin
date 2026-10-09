import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionGroups,
  AssistantPageError,
  canonicalLinks,
  canonicalPageCopy,
  continuingText,
  pageTarget,
} from '../src/lib/assistantPage.js';
import { loadAssistantDetails, loadLocalAssistantDetails } from '../src/lib/localAssistantIcons.js';
import { LocalApiError } from '../src/lib/validate.js';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const COPY = {
  description: 'Reads your zones and changes one only after your approval.',
  links: { x: 'https://x.com/shimpz', site: 'https://shimpz.com/', github: 'https://github.com/shimpz' },
  actions: [
    { id: 'delete-record', effect: 'mutating', description: 'Delete one record.' },
    { id: 'list-zones', effect: 'read_only', description: 'List your zones.' },
  ],
  integrations: [{ id: 'cloudflare', provider: 'cloudflare' }],
  stored_inputs: [{
    id: 'api-token',
    label: 'API token',
    description: 'Create an API token in the Cloudflare dashboard and copy it.',
    help_url: 'https://dash.cloudflare.com/profile/api-tokens',
  }],
};
const TOKEN = COPY.stored_inputs[0];
const DETAILS = {
  locale: 'pt',
  assistant_id: 'shimpz-cloudflare',
  assistant_version: '1.4.0',
  name: 'Shimpz Cloudflare',
  creators: ['@shimpz'],
  summary: 'Publica alterações de DNS com segurança.',
  ...COPY,
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('admits the page copy and lists the Creator links in their display order', () => {
  const copy = canonicalPageCopy(COPY);
  assert.deepEqual(copy.links.map((link) => link.kind), ['site', 'github', 'x']);
  assert.deepEqual(copy.storedInputs[0], {
    id: 'api-token',
    label: 'API token',
    help: TOKEN.description,
    helpUrl: TOKEN.help_url,
  });
  assert.deepEqual(actionGroups(copy.actions).read.map((action) => action.id), ['list-zones']);
  assert.deepEqual(actionGroups(copy.actions).write.map((action) => action.id), ['delete-record']);
});

test('admits a credential help text and help link up to their bounds', () => {
  const longest = { ...TOKEN, description: 'h'.repeat(500), help_url: `https://dash.cloudflare.com/${'a'.repeat(2020)}` };
  assert.equal(longest.help_url.length, 2048);
  assert.equal(canonicalPageCopy({ ...COPY, stored_inputs: [longest] }).storedInputs[0].helpUrl, longest.help_url);
});

test('refuses a link outside its kind, its host, its grammar, or its bound', () => {
  for (const links of [
    [],
    { facebook: 'https://facebook.com/shimpz' },
    { github: 'https://gitlab.com/shimpz' },
    { x: 'https://twitter.com/shimpz' },
    { youtube: 'https://youtube.com.example.org/watch' },
    { site: 'http://shimpz.com/' },
    { site: 'https://shimpz.com' },
    { site: 'https://user@shimpz.com/' },
    { site: 'https://shimpz.com:8443/' },
    { site: 'https://shimpz.com/#about' },
    { site: 'https://shimpz.internal/' },
    { site: `https://shimpz.com/${'a'.repeat(238)}` },
    { site: 42 },
  ]) {
    assert.throws(() => canonicalLinks(links), AssistantPageError, JSON.stringify(links));
  }
  assert.equal(canonicalLinks({ site: `https://shimpz.com/${'a'.repeat(237)}` }).length, 1);
  assert.equal(canonicalLinks({ youtube: 'https://www.youtube.com/@shimpz' })[0].kind, 'youtube');
});

test('refuses page copy outside its bounds, order, and closed shapes', () => {
  for (const changes of [
    { description: 'd'.repeat(501) },
    { description: 'Bidi‮override.' },
    { description: 'Line\nbreak.' },
    { description: 'Line\u2028separator.' },
    { description: 'No-break\u00a0space.' },
    { description: 'Decomposed e\u0301.' },
    { actions: [] },
    { actions: [...COPY.actions].reverse() },
    { actions: [{ ...COPY.actions[0], effect: 'deleting' }] },
    { actions: [{ ...COPY.actions[0], description: 'x'.repeat(121) }] },
    { integrations: [{ id: 'cloudflare' }] },
    { stored_inputs: [{ ...TOKEN, label: 'l'.repeat(121) }] },
    { stored_inputs: [{ ...TOKEN, id: 'b' }, { ...TOKEN, id: 'a' }] },
    { stored_inputs: [{ id: 'api-token', label: 'API token' }] },
    { stored_inputs: [{ ...TOKEN, description: 'h'.repeat(501) }] },
    { stored_inputs: [{ ...TOKEN, description: 'Line\nbreak.' }] },
    { stored_inputs: [{ ...TOKEN, help_url: 'http://dash.cloudflare.com/profile/api-tokens' }] },
    { stored_inputs: [{ ...TOKEN, help_url: 'https://dash.cloudflare.com/profile/api-tokens#new' }] },
    { stored_inputs: [{ ...TOKEN, help_url: `https://dash.cloudflare.com/${'a'.repeat(2025)}` }] },
    { stored_inputs: [{ ...TOKEN, help_url: 42 }] },
  ]) {
    assert.throws(() => canonicalPageCopy({ ...COPY, ...changes }), AssistantPageError, JSON.stringify(changes));
  }
});

test('a row description continues its slug in lowercase only where that keeps its meaning', () => {
  assert.equal(continuingText('List your zones.', 'en'), 'list your zones.');
  assert.equal(continuingText('Ver seus domínios.', 'pt'), 'ver seus domínios.');
  assert.equal(continuingText('Ändere einen Eintrag.', 'de'), 'Ändere einen Eintrag.');
  assert.equal(continuingText('API token', 'en'), 'API token');
  assert.equal(continuingText('WhatsApp token', 'pt'), 'WhatsApp token');
  assert.equal(continuingText('ゾーンを一覧表示します。', 'ja'), 'ゾーンを一覧表示します。');
});

test('an installed Assistant always shows its binding; a candidate needs every source that could name it', () => {
  const group = { assistant_id: 'whatsapp', primary: {}, alternatives: [] };
  const publication = { assistant_id: 'whatsapp' };
  const local = { assistant: 'whatsapp', provenance: 'local' };
  const published = { assistant: 'whatsapp', provenance: 'published' };
  assert.equal(pageTarget({ installed: local, localGroup: group, publication }).mode, 'installed');
  assert.equal(pageTarget({ installed: published, localGroup: group, publication }).mode, 'installed');
  assert.equal(pageTarget({ installed: published, localGroup: null, publication, localKnown: false }).mode, 'installed');
  assert.equal(pageTarget({ installed: null, localGroup: group, publication }).mode, 'local');
  assert.equal(pageTarget({ installed: null, localGroup: null, publication }).mode, 'public');
  assert.equal(pageTarget({ installed: null, localGroup: null, publication: null }).mode, 'missing');
  // A staged snapshot this machine could not enumerate may shadow the publication, so neither is offered.
  assert.equal(pageTarget({ installed: null, localGroup: null, publication, localKnown: false }).mode, 'unverified');
  assert.equal(pageTarget({ installed: null, localGroup: group, publication: null, publicKnown: false }).mode, 'local');
  assert.equal(pageTarget({ installed: null, localGroup: null, publication: null, publicKnown: false }).mode, 'unverified');
});

test('reads a staged page through the busy-retrying preview queue in exactly the asked language', async () => {
  const requests = [];
  const delays = [];
  const fetcher = async (url) => {
    requests.push(url);
    if (requests.length === 1) {
      return json(503, { code: 'local-assistant-preview-busy', retry_after_ms: 25 });
    }
    return json(200, DETAILS);
  };
  const page = await loadLocalAssistantDetails(fetcher, IMAGE_ID, 'shimpz-cloudflare', 'pt', {
    delay: async (delay) => delays.push(delay),
  });
  assert.equal(page.name, 'Shimpz Cloudflare');
  assert.equal(page.page.links[0].kind, 'site');
  assert.deepEqual(delays, [25]);
  assert.deepEqual(requests, Array(2).fill(`/api/local-assistants/${'a'.repeat(64)}/details?locale=pt`));
});

test('refuses a page for another Assistant, language, or shape, and too many staged Creators', async () => {
  const invalid = (error) => error instanceof LocalApiError && error.message === 'The Assistant details are invalid.';
  for (const body of [
    { ...DETAILS, locale: 'en' },
    { ...DETAILS, assistant_id: 'other' },
    { ...DETAILS, summary: 's'.repeat(81) },
    { ...DETAILS, trace_id: 'a'.repeat(32) },
    { ...DETAILS, links: { github: 'https://gitlab.com/shimpz' } },
    { ...DETAILS, creators: ['@a', '@b', '@c', '@d', '@e'] },
  ]) {
    await assert.rejects(
      loadLocalAssistantDetails(async () => json(200, body), IMAGE_ID, 'shimpz-cloudflare', 'pt'),
      invalid,
      JSON.stringify(body),
    );
  }
  // An installed binding names every one of its verified Creators.
  const creators = ['@a', '@b', '@c', '@d', '@e'];
  const installed = await loadAssistantDetails(
    async () => json(200, { ...DETAILS, creators }),
    'marketing',
    'shimpz-cloudflare',
    'pt',
  );
  assert.deepEqual(installed.creators, creators);
});

test('reports a refused or unavailable page with its code and refuses an invalid request before any fetch', async () => {
  await assert.rejects(
    loadAssistantDetails(
      async () => json(409, { error: 'Assistant needs replacement', code: 'assistant-manifest-invalid' }),
      'marketing',
      'shimpz-cloudflare',
      'pt',
    ),
    (error) => error instanceof LocalApiError && error.status === 409 && error.code === 'assistant-manifest-invalid',
  );
  let fetched = false;
  const fetcher = async () => { fetched = true; return json(200, DETAILS); };
  await assert.rejects(loadLocalAssistantDetails(fetcher, 'latest', 'shimpz-cloudflare', 'pt'), LocalApiError);
  await assert.rejects(loadLocalAssistantDetails(fetcher, IMAGE_ID, 'Bad', 'pt'), LocalApiError);
  await assert.rejects(loadAssistantDetails(fetcher, 'Team 1', 'shimpz-cloudflare', 'pt'), LocalApiError);
  await assert.rejects(loadAssistantDetails(fetcher, 'marketing', 'shimpz-cloudflare', 'it'), LocalApiError);
  assert.equal(fetched, false);
});
