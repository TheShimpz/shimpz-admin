import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';

import {
  acknowledgeFailedAttempts,
  clearSecuritySummary,
  loadSecuritySummary,
  securitySummary,
} from '../src/lib/security.js';

function answer(status, body) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetcher };
}

test('the summary reads the failed attempts a sign-in reported', async () => {
  const { calls, fetcher } = answer(200, { failed_second_factor_attempts: 3 });

  assert.deepEqual(await loadSecuritySummary(fetcher), { failedAttempts: 3 });
  assert.deepEqual(get(securitySummary), { failedAttempts: 3 });
  assert.equal(calls[0].url, '/api/admin/security');
  assert.equal(calls[0].init.cache, 'no-store');
  clearSecuritySummary();
  assert.equal(get(securitySummary), null);
});

test('an acknowledgment names exactly the attempts the Supervisor saw', async () => {
  const { calls, fetcher } = answer(200, { failed_second_factor_attempts: 1 });

  assert.deepEqual(await acknowledgeFailedAttempts(fetcher, 3), { failedAttempts: 1 });
  assert.equal(calls[0].url, '/api/admin/security/failures');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { acknowledged: 3 });
  for (const seen of [0, -1, 1.5, '3', 1_000_001]) {
    await assert.rejects(acknowledgeFailedAttempts(fetcher, seen), /Invalid sign-in security request/);
  }
  assert.equal(calls.length, 1);
});

test('a refused or malformed answer fails closed', async () => {
  await assert.rejects(loadSecuritySummary(answer(503, { detail: 'unavailable' }).fetcher), /unavailable/);
  for (const body of [{}, { failed_second_factor_attempts: -1 }, { failed_second_factor_attempts: 1, extra: 1 }]) {
    await assert.rejects(loadSecuritySummary(answer(200, body).fetcher), /invalid/);
  }
  await assert.rejects(loadSecuritySummary(null), /Invalid sign-in security request/);
});
