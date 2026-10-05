import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchPlatformRelease, isDeveloperRelease } from '../src/lib/platformRelease.js';

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

test('admits the whole range of release check times the backend projects', async () => {
  for (const checked_at of ['1970-01-01T00:00:01Z', '9999-12-31T23:59:59Z']) {
    const body = { release, ordinal: 42, checked_at, outcome: 'current' };
    assert.deepEqual(await fetchPlatformRelease(async () => response(200, body)), body);
  }
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

test('admits a developer release built on this host and names it as one', async () => {
  const developer = `localhost/shimpz-local-release@sha256:${'b'.repeat(64)}`;
  const body = { release: developer, ordinal: 42, checked_at: '2026-08-08T22:52:21Z', outcome: 'current' };
  const status = await fetchPlatformRelease(async () => response(200, body));
  assert.deepEqual(status, body);
  assert.equal(isDeveloperRelease(status), true);
  assert.equal(isDeveloperRelease({ ...body, release }), false);
  assert.equal(isDeveloperRelease(null), false);
  for (const widened of [
    `localhost:5000/shimpz-local-release@sha256:${'b'.repeat(64)}`,
    `127.0.0.1/shimpz-local-release@sha256:${'b'.repeat(64)}`,
    `localhost/shimpz-admin@sha256:${'b'.repeat(64)}`,
  ]) {
    assert.equal(await fetchPlatformRelease(async () => response(200, { ...body, release: widened })), null);
  }
});
