import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalHelpUrl,
  canonicalPurpose,
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
    request: {
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
    },
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
  const withoutStoredInput = storedInputChallenge({ help_url: 'https://dashboard.exa.ai/api-keys' });
  delete withoutStoredInput.request.stored_input;
  const nested = storedInputChallenge();
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
