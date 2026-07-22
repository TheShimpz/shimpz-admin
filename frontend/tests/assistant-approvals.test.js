import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_APPROVALS_COPY,
  assistantApprovalsCopy,
} from '../src/lib/assistantApprovalsCopy.js';

const LOCALES = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];

test('localizes every explicit Power approval surface', () => {
  const baseline = Object.keys(ASSISTANT_APPROVALS_COPY.en).sort();
  assert.deepEqual(Object.keys(ASSISTANT_APPROVALS_COPY).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) {
    const copy = assistantApprovalsCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(), baseline);
    assert.ok(Object.values(copy).every((value) => typeof value === 'string' && value.trim()));
  }
  assert.equal(assistantApprovalsCopy('unsupported'), ASSISTANT_APPROVALS_COPY.en);
});
