import assert from 'node:assert/strict';
import test from 'node:test';

import { assistantIntegrationProviderLabel } from '../src/lib/localChat.js';

test('names only an exact Integration provider id', () => {
  assert.equal(assistantIntegrationProviderLabel('x'), 'X');
  assert.equal(assistantIntegrationProviderLabel('google-workspace'), 'Google Workspace');
  assert.equal(assistantIntegrationProviderLabel('Cloudflare'), '');
});
