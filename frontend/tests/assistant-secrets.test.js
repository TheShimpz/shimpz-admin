import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_SECRETS_COPY,
  assistantSecretsCopy,
} from '../src/lib/assistantSecretsCopy.js';

const LOCALES = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];

test('localizes every Assistant secret surface without partial fallback', () => {
  const baseline = Object.keys(ASSISTANT_SECRETS_COPY.en).sort();
  assert.deepEqual(Object.keys(ASSISTANT_SECRETS_COPY).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) {
    const copy = assistantSecretsCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(), baseline);
    for (const value of Object.values(copy)) {
      assert.equal(typeof value, 'string');
      assert.ok(value.trim());
    }
  }
  assert.equal(assistantSecretsCopy('unsupported'), ASSISTANT_SECRETS_COPY.en);
});
