import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchPlatformRelease } from '../src/lib/platformRelease.js';

const release = `ghcr.io/theshimpz/shimpz-local-release@sha256:${'a'.repeat(64)}`;

function response(status, body) {
  return { ok: status >= 200 && status < 300, async json() { return body; } };
}

test('admits only the closed Local platform release status', async () => {
  const status = await fetchPlatformRelease(async (url, options) => {
    assert.equal(url, '/api/platform-release');
    assert.deepEqual(options, { cache: 'no-store' });
    return response(200, {
      release,
      ordinal: 42,
      checked_at: '2026-08-08T22:52:21Z',
      outcome: 'updated',
    });
  });
  assert.deepEqual(status, {
    release,
    ordinal: 42,
    checked_at: '2026-08-08T22:52:21Z',
    outcome: 'updated',
  });
});

test('hides unavailable, malformed, widened, or secret-bearing status', async () => {
  assert.equal(await fetchPlatformRelease(async () => response(503, {})), null);
  for (const body of [
    { release, ordinal: 42, checked_at: '2026-08-08T22:52:21Z', outcome: 'installing' },
    { release, ordinal: true, checked_at: '2026-08-08T22:52:21Z', outcome: 'current' },
    { release, ordinal: 42, checked_at: 'tomorrow', outcome: 'current' },
    { release, ordinal: 42, checked_at: '2026-08-08T22:52:21Z', outcome: 'current', token: 'secret' },
  ]) {
    assert.equal(await fetchPlatformRelease(async () => response(200, body)), null);
  }
});
