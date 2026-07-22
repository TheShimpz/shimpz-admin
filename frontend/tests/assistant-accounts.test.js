import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_ACCOUNTS_COPY,
  assistantAccountProviderLabel,
  assistantAccountsCopy,
} from '../src/lib/assistantAccountsCopy.js';

const LOCALES = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];

test('localizes every Assistant account surface without partial fallback', () => {
  const baseline = Object.keys(ASSISTANT_ACCOUNTS_COPY.en).sort();
  assert.deepEqual(Object.keys(ASSISTANT_ACCOUNTS_COPY).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) {
    const copy = assistantAccountsCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(), baseline);
    assert.ok(Object.values(copy).every((value) => typeof value === 'string' && value.trim()));
  }
  assert.equal(assistantAccountsCopy('unsupported'), ASSISTANT_ACCOUNTS_COPY.en);
});

test('names the exact Account provider across authorization copy', () => {
  const copy = assistantAccountsCopy('en', 'cloudflare');
  assert.equal(copy.authorize, 'Continue to Cloudflare');
  assert.equal(copy.authorizing, 'Opening Cloudflare…');
  assert.match(copy.dialogLead, /directly on Cloudflare\.$/);
  assert.equal(assistantAccountProviderLabel('x'), 'X');
  assert.equal(assistantAccountProviderLabel('google-workspace'), 'Google Workspace');
  assert.equal(assistantAccountProviderLabel('Cloudflare'), '');
});
