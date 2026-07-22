import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_SECRET_MANAGEMENT_COPY,
  assistantSecretManagementCopy,
} from '../src/lib/assistantSecretManagementCopy.js';

const LOCALES = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];

test('localizes secret rotation and remembered approval controls', () => {
  const baseline = Object.keys(ASSISTANT_SECRET_MANAGEMENT_COPY.en).sort();
  assert.deepEqual(Object.keys(ASSISTANT_SECRET_MANAGEMENT_COPY).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) {
    const copy = assistantSecretManagementCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(), baseline);
    assert.ok(Object.values(copy).every((value) => typeof value === 'string' && value.trim()));
  }
});
