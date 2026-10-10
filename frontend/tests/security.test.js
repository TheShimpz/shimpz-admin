import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';

import {
  acknowledgeFailedAttempts,
  beginRecoveryCodes,
  beginSupervisorKeyRotation,
  clearSecuritySummary,
  loadSecuritySummary,
  recoveryCodes,
  recoveryCodesText,
  replaceRecoveryCodes,
  rotateSupervisorKey,
  SecurityError,
  securitySummary,
} from '../src/lib/security.js';

const HISTORY = { previous: { at: '2026-10-08T21:14:00Z', origin: 'http://127.0.0.1:7777' }, failures_since: 2 };
const CODES = Array.from({ length: 10 }, (_, index) => `abcd-efgh-jk${String(index).padStart(2, '0')}`);

function answer(status, body) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetcher };
}

test('the summary reads the failed attempts a sign-in reported', async () => {
  const { calls, fetcher } = answer(200, {
    failed_second_factor_attempts: 3, recovery_codes_remaining: 9, sign_in_history: HISTORY,
  });
  const expected = {
    failedAttempts: 3,
    recoveryCodesRemaining: 9,
    signIns: { previous: { at: '2026-10-08T21:14:00Z', origin: 'http://127.0.0.1:7777' }, failuresSince: 2 },
  };

  assert.deepEqual(await loadSecuritySummary(fetcher), expected);
  assert.deepEqual(get(securitySummary), expected);
  assert.equal(calls[0].url, '/api/admin/security');
  assert.equal(calls[0].init.cache, 'no-store');
  clearSecuritySummary();
  assert.equal(get(securitySummary), null);
});

test('an acknowledgment names exactly the attempts the Supervisor saw', async () => {
  const { calls, fetcher } = answer(200, {
    failed_second_factor_attempts: 1, recovery_codes_remaining: 10, sign_in_history: null,
  });

  assert.deepEqual(await acknowledgeFailedAttempts(fetcher, 3), {
    failedAttempts: 1, recoveryCodesRemaining: 10, signIns: null,
  });
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
  const valid = { failed_second_factor_attempts: 1, recovery_codes_remaining: 1, sign_in_history: null };
  for (const body of [
    {},
    { ...valid, failed_second_factor_attempts: -1 },
    { ...valid, recovery_codes_remaining: 11 },
    { ...valid, extra: 1 },
    { failed_second_factor_attempts: 1, recovery_codes_remaining: 1 },
    { ...valid, sign_in_history: { previous: null } },
    { ...valid, sign_in_history: { previous: null, failures_since: -1 } },
    { ...valid, sign_in_history: { ...HISTORY, previous: { at: 'yesterday', origin: null } } },
    { ...valid, sign_in_history: { ...HISTORY, previous: { at: HISTORY.previous.at, origin: 'javascript:alert(1)' } } },
    { ...valid, sign_in_history: { ...HISTORY, previous: { at: HISTORY.previous.at, origin: 7 } } },
    { ...valid, sign_in_history: { ...HISTORY, previous: { at: HISTORY.previous.at } } },
  ]) {
    await assert.rejects(loadSecuritySummary(answer(200, body).fetcher), /invalid/);
  }
  await assert.rejects(loadSecuritySummary(null), /Invalid sign-in security request/);
});

test('a sign-in history may name no earlier sign-in or an unknown origin', async () => {
  const none = { failed_second_factor_attempts: 0, recovery_codes_remaining: 10,
    sign_in_history: { previous: null, failures_since: 0 } };
  assert.deepEqual((await loadSecuritySummary(answer(200, none).fetcher)).signIns, { previous: null, failuresSince: 0 });
  const unknown = { ...none, sign_in_history: { previous: { at: HISTORY.previous.at, origin: null }, failures_since: 1 } };
  assert.deepEqual((await loadSecuritySummary(answer(200, unknown).fetcher)).signIns.previous, {
    at: HISTORY.previous.at, origin: null,
  });
  clearSecuritySummary();
});

test('a recovery set is exactly ten distinct codes in their written form', () => {
  assert.deepEqual(recoveryCodes(CODES), CODES);
  for (const value of [null, CODES.slice(1), [...CODES.slice(1), CODES[0].toUpperCase()], [...CODES.slice(1), CODES[1]],
    [...CODES.slice(1), 'abcd-efgh-jkil']]) {
    assert.equal(recoveryCodes(value), null);
  }
  assert.equal(recoveryCodesText(CODES.slice(0, 2), 'Codes'), `Codes\n\n${CODES[0]}\n${CODES[1]}\n`);
});

test('replacing the codes starts with the password and spends one second factor for the new set', async () => {
  const offer = answer(202, { methods: ['totp'] });
  assert.deepEqual(await beginRecoveryCodes(offer.fetcher, 'a password'), { passkey: null });
  assert.equal(offer.calls[0].url, '/api/admin/recovery-codes/confirmation');
  assert.deepEqual(JSON.parse(offer.calls[0].init.body), { password: 'a password' });
  const passkey = answer(202, { methods: ['totp', 'passkey'], passkey_options: { challenge: 'c' } });
  assert.deepEqual(await beginRecoveryCodes(passkey.fetcher, 'a password'), { passkey: { challenge: 'c' } });

  securitySummary.set({ failedAttempts: 0, recoveryCodesRemaining: 2 });
  const replaced = answer(200, { recovery_codes: CODES });
  assert.deepEqual(await replaceRecoveryCodes(replaced.fetcher, { code: '123456' }), CODES);
  assert.equal(replaced.calls[0].url, '/api/admin/recovery-codes');
  assert.deepEqual(JSON.parse(replaced.calls[0].init.body), { code: '123456' });
  assert.equal(get(securitySummary).recoveryCodesRemaining, 10);
  clearSecuritySummary();
  assert.deepEqual(await replaceRecoveryCodes(answer(200, { recovery_codes: CODES }).fetcher, { credential: {} }), CODES);
  assert.equal(get(securitySummary), null);
});

test('a refused or malformed confirmation is a closed error and nothing invalid is sent', async () => {
  const refused = answer(429, { code: 'authentication-locked', retry_after: 60 });
  await assert.rejects(beginRecoveryCodes(refused.fetcher, 'a password'), (error) => (
    error instanceof SecurityError && error.code === 'authentication-locked' && error.status === 429 && error.retryAfter === 60
  ));
  await assert.rejects(beginRecoveryCodes(answer(500, { code: 'Not A Code', retry_after: 1e9 }).fetcher, 'p'), (error) => (
    error.code === 'request-failed' && error.retryAfter === 0
  ));
  for (const body of [{ methods: ['passkey'] }, { methods: ['totp'], extra: 1 }, { methods: ['totp', 'passkey'] }]) {
    await assert.rejects(beginRecoveryCodes(answer(202, body).fetcher, 'p'), /response-invalid/);
  }
  await assert.rejects(beginRecoveryCodes(answer(202, {}).fetcher, ''), /request-invalid/);
  await assert.rejects(beginRecoveryCodes(null, 'p'), /request-invalid/);
  for (const proof of [{}, { code: '12345' }, { code: '123456', credential: {} }, { credential: null }]) {
    await assert.rejects(replaceRecoveryCodes(answer(200, {}).fetcher, proof), /request-invalid/);
  }
  await assert.rejects(replaceRecoveryCodes(answer(200, { recovery_codes: CODES.slice(1) }).fetcher, { code: '123456' }),
    /response-invalid/);
  await assert.rejects(replaceRecoveryCodes(answer(200, { recovery_codes: CODES, x: 1 }).fetcher, { code: '123456' }),
    /response-invalid/);
});

test('replacing the signing key starts with the password and resolves only when Team pins the new key', async () => {
  const offer = answer(202, { methods: ['totp'] });
  assert.deepEqual(await beginSupervisorKeyRotation(offer.fetcher, 'a password'), { passkey: null });
  assert.equal(offer.calls[0].url, '/api/admin/supervisor-key/confirmation');
  const rotated = answer(200, { rotated: true });
  assert.equal(await rotateSupervisorKey(rotated.fetcher, { code: '123456' }), true);
  assert.equal(rotated.calls[0].url, '/api/admin/supervisor-key');
  assert.deepEqual(JSON.parse(rotated.calls[0].init.body), { code: '123456' });
  for (const [status, code] of [
    [503, 'supervisor-key-rotation-pending'],
    [409, 'supervisor-key-rotation-refused'],
    [409, 'supervisor-key-rotation-busy'],
  ]) {
    await assert.rejects(rotateSupervisorKey(answer(status, { code }).fetcher, { code: '123456' }), (error) => (
      error instanceof SecurityError && error.code === code && error.status === status
    ));
  }
  for (const body of [{}, { rotated: false }, { rotated: true, key_sha256: 'a' }]) {
    await assert.rejects(rotateSupervisorKey(answer(200, body).fetcher, { code: '123456' }), /response-invalid/);
  }
  await assert.rejects(rotateSupervisorKey(answer(200, {}).fetcher, { code: '12' }), /request-invalid/);
});
