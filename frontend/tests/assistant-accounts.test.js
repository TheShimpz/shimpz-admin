import assert from 'node:assert/strict';
import test from 'node:test';

import { assistantAccountProviderLabel } from '../src/lib/localChat.js';

test('names only an exact Account provider id', () => {
  assert.equal(assistantAccountProviderLabel('x'), 'X');
  assert.equal(assistantAccountProviderLabel('google-workspace'), 'Google Workspace');
  assert.equal(assistantAccountProviderLabel('Cloudflare'), '');
});
