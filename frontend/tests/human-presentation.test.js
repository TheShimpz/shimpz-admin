import assert from 'node:assert/strict';
import test from 'node:test';

import { localizedChallenge, messageReference } from '../e2e/localizedRequest.js';
import {
  canonicalHelpUrl,
  canonicalPurpose,
  displayedHumanRequest,
  HELP_URL_PATTERN,
  parseChatEvent,
} from '../src/lib/localChat.js';

const CHALLENGE_ID = 'b'.repeat(32);

test('a key page is one canonical public https URL', () => {
  const accepted = [
    'https://dashboard.exa.ai/api-keys',
    'https://dashboard.exa.ai/',
    'https://developers.facebook.com/apps/?show_reminder=true',
    'https://a.co/~user/(x)',
    'https://a.com/%2F',
    `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`,
  ];
  for (const value of accepted) assert.equal(canonicalHelpUrl(value), value, value);
  const refused = [
    'https://dashboard.exa.ai',
    'http://dashboard.exa.ai/api-keys',
    'https://Dashboard.exa.ai/api-keys',
    'https://dashboard.exa.ai:443/api-keys',
    'https://user@dashboard.exa.ai/api-keys',
    'https://user:secret@dashboard.exa.ai/api-keys',
    'https://dashboard.exa.ai/api-keys#token',
    'https://dashboard.exa.ai/a/../api-keys',
    'https://dashboard.exa.ai/./api-keys',
    'https://dashboard.exa.ai/%2E/api-keys',
    'https://dashboard.exa.ai/%2f',
    'https://dashboard.exa.ai/a b',
    'https://xn--nxasmq6b.com/',
    'https://keys.local/',
    'https://keys.internal/settings',
    'https://192.168.0.10/settings',
    'https://dashboard.exa.ai/api-keys\n',
    'https://dashboard.exa.ai/api-keys\r\n',
    ' https://dashboard.exa.ai/api-keys',
    `https://example.com/${'a'.repeat(2049 - 'https://example.com/'.length)}`,
    null,
    42,
  ];
  for (const value of refused) assert.throws(() => canonicalHelpUrl(value), /invalid/i, String(value));
});

test('a purpose is one plain sentence that never points somewhere', () => {
  for (const value of [
    'Para trazer as notícias de IA de hoje, preciso pesquisar na web com o Exa.',
    'To check your e-mail I need Gmail.',
    'x'.repeat(280),
  ]) assert.equal(canonicalPurpose(value), value);
  for (const value of [
    '',
    ' leading space',
    'x'.repeat(281),
    'a — b',
    'a – b',
    'a - b',
    'trailing -',
    'Open https://example.com now',
    'Visit WWW.example.com',
    'line\nbreak',
    'zero​width',
    'line separator',
    'Café',
    null,
  ]) assert.throws(() => canonicalPurpose(value), /invalid/i, String(value));
});

function storedInputChallenge(extra = {}) {
  return {
    type: 'human-required',
    challenge_id: CHALLENGE_ID,
    expires_in: 180,
    assistant: { id: 'shimpz-exa', name: 'Exa', version: '0.1.1' },
    action: { id: 'search-web', summary: 'Search the web with Exa.' },
    ...localizedChallenge({
      kind: 'input:password',
      ordinal: 0,
      title: 'Exa API key',
      description: 'Exa search uses your API key.',
      fingerprint: 'c'.repeat(64),
      label: 'Exa API key',
      required: true,
      placeholder: null,
      min_length: 1,
      max_length: 128,
      stored_input: 'exa-api-key',
    }),
    ...extra,
  };
}

test('a human request carries the purpose and key page beside its fingerprinted request', () => {
  const presented = storedInputChallenge({
    purpose: 'To bring today’s AI news I need to search the web with Exa.',
    help_url: 'https://dashboard.exa.ai/api-keys',
  });
  assert.deepEqual(parseChatEvent(presented, 'team_1', 'Marketing'), presented);
  assert.deepEqual(parseChatEvent(storedInputChallenge(), 'team_1', 'Marketing'), storedInputChallenge());

  // The key page belongs only to a Stored Input request and never rides inside the Assistant's request.
  const withoutStoredInput = structuredClone(storedInputChallenge({ help_url: 'https://dashboard.exa.ai/api-keys' }));
  delete withoutStoredInput.request.stored_input;
  const nested = structuredClone(storedInputChallenge());
  nested.request.help_url = 'https://dashboard.exa.ai/api-keys';
  for (const event of [
    withoutStoredInput,
    nested,
    storedInputChallenge({ help_url: 'http://dashboard.exa.ai/api-keys' }),
    storedInputChallenge({ purpose: 'Open https://example.com' }),
    storedInputChallenge({ purpose: null }),
    storedInputChallenge({ unexpected: true }),
  ]) assert.throws(() => parseChatEvent(event, 'team_1', 'Marketing'), /invalid/i);
});

// A Portuguese approval with a parameterized title and a choice whose second option has no description (ADR-0091).
function portugueseChoice(extra = {}) {
  return {
    type: 'human-required',
    challenge_id: CHALLENGE_ID,
    expires_in: 180,
    assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
    action: { id: 'publish-dns', summary: 'Publish DNS changes.' },
    ...localizedChallenge({
      kind: 'input:choice',
      ordinal: 0,
      title: 'Choose mode',
      description: 'Select how the record should be published.',
      fingerprint: 'c'.repeat(64),
      label: 'Mode',
      required: true,
      options: [
        { value: 'proxied', label: 'Proxied', description: 'Route traffic through Cloudflare.' },
        { value: 'dns-only', label: 'DNS only', description: null },
      ],
    }, {
      locale: 'pt',
      shown: {
        title: 'Escolha o modo',
        description: 'Selecione como o registro deve ser publicado.',
        label: 'Modo',
        options: [
          { label: 'Com proxy', description: 'Encaminhar o tráfego pela Cloudflare.' },
          { label: 'Somente DNS', description: null },
        ],
      },
    }),
    ...extra,
  };
}

test('a person reads only the rendered copy while the request keeps its canonical option values', () => {
  const challenge = portugueseChoice();
  const parsed = parseChatEvent(challenge, 'team_1', 'Marketing');
  assert.deepEqual(parsed, challenge);
  assert.equal(parsed.locale, 'pt');
  const shown = displayedHumanRequest(parsed);
  assert.equal(shown.title, 'Escolha o modo');
  assert.equal(shown.description, 'Selecione como o registro deve ser publicado.');
  assert.equal(shown.label, 'Modo');
  assert.deepEqual(shown.options, [
    { value: 'proxied', label: 'Com proxy', description: 'Encaminhar o tráfego pela Cloudflare.' },
    { value: 'dns-only', label: 'Somente DNS', description: null },
  ]);
  assert.equal(shown.kind, 'input:choice');
  assert.equal(shown.fingerprint, challenge.request.fingerprint);
  // The canonical request is never rewritten by its display copy.
  assert.deepEqual(parsed.request.title, messageReference('Choose mode'));

  const password = parseChatEvent(storedInputChallenge(), 'team_1', 'Marketing');
  const field = displayedHumanRequest(password);
  assert.equal(field.placeholder, null);
  assert.equal(field.stored_input, 'exa-api-key');
  assert.equal(Object.hasOwn(field, 'options'), false);
});

test('a parameterized reference admits only its closed shape and bounded parameter grammar', () => {
  const titled = (title) => {
    const challenge = structuredClone(portugueseChoice());
    challenge.request.title = title;
    return challenge;
  };
  for (const title of [
    messageReference('Delete {count} records in {zone}.', { count: 0, zone: 'example.com' }),
    messageReference('Rotate {key}.', { key: 'Key_1.a:b-c' }),
    messageReference('Publish {count}.', { count: 10 ** 15 - 1 }),
    messageReference('Authorize {name}.', { name: '_acme-challenge.example.com' }),
    messageReference('Authorize {name}.', { name: `${'a'.repeat(63)}.`.repeat(3) + 'b'.repeat(61) }),
    messageReference('Eight', Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`p${index}`, index]))),
  ]) assert.deepEqual(parseChatEvent(titled(title), 'team_1', 'Marketing').request.title, title);
  for (const title of [
    'Choose mode',
    null,
    { message: messageReference('x').message },
    { ...messageReference('x'), text: 'x' },
    { message: 'A'.repeat(64), params: {} },
    { message: 'a'.repeat(63), params: {} },
    { message: messageReference('x').message, params: [] },
    messageReference('Nine', Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, index]))),
    messageReference('Name', { Zone: 'example.com' }),
    messageReference('Count', { count: true }),
    messageReference('Count', { count: -1 }),
    messageReference('Count', { count: 10 ** 15 }),
    messageReference('Prose', { value: 'two words' }),
    messageReference('Long', { value: 'a'.repeat(129) }),
    messageReference('Wildcard', { name: '*.example.com' }),
    messageReference('Trailing dot', { name: '_dmarc.example.com.' }),
    messageReference('Empty label', { name: '_dmarc..example.com' }),
    messageReference('Uppercase', { name: '_DMARC.example.com' }),
    messageReference('Overlong', { name: `${'a'.repeat(63)}.`.repeat(3) + 'b'.repeat(62) }),
    messageReference('Nested', { value: { a: 1 } }),
  ]) assert.throws(() => parseChatEvent(titled(title), 'team_1', 'Marketing'), /invalid/i, JSON.stringify(title));
});

test('a challenge without exactly its rendered copy, locale, and pack fails closed', () => {
  const base = portugueseChoice();
  const without = (key) => Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
  const rendered = (change) => ({ ...base, rendered: { ...base.rendered, ...change } });
  const [first, second] = base.rendered.options;
  for (const invalid of [
    without('rendered'),
    without('locale'),
    without('pack_digest'),
    { ...base, locale: null },
    { ...base, locale: 'pt-BR' },
    { ...base, pack_digest: `sha256:${'A'.repeat(64)}` },
    { ...base, pack_digest: '5'.repeat(64) },
    rendered({ placeholder: null }),
    rendered({ title: 'x'.repeat(81) }),
    rendered({ title: ' Escolha' }),
    rendered({ title: 'Escolha\u0000' }),
    rendered({ description: 'Cafe\u0301' }),
    rendered({ label: 7 }),
    rendered({ options: [first] }),
    rendered({ options: [first, { label: 'Somente DNS', description: 'x' }] }),
    rendered({ options: [{ ...first, value: 'proxied' }, second] }),
    rendered({ options: [first, { label: '', description: null }] }),
    rendered({ options: [first, null] }),
    rendered({ options: 'Com proxy' }),
    { ...base, rendered: null },
    { ...base, rendered: { title: 'Escolha o modo' } },
  ]) assert.throws(() => parseChatEvent(invalid, 'team_1', 'Marketing'), /invalid/i, JSON.stringify(invalid.rendered));
  // A null placeholder renders to null, and only a null placeholder may.
  const password = storedInputChallenge();
  assert.throws(
    () => parseChatEvent({ ...password, rendered: { ...password.rendered, placeholder: 'Cole a chave' } }, 'team_1', 'Marketing'),
    /invalid/i,
  );
});
