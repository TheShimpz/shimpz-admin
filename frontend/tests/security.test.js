import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';

import { OUTCOME_UNKNOWN, socketReads } from '../src/lib/session/socket.js';
import { LocalApiError } from '../src/lib/api.js';

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

// One answer of the session socket: `fetcher` answers a read handed to it, and it answers every change, which goes
// over the socket, as `socketReads.call` from now on. `calls` records each `{ method, params }`.
function answer(status, body) {
  const calls = [];
  const fetcher = async (method, params) => {
    calls.push({ method, params });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  socketReads.call = fetcher;
  return { calls, fetcher };
}

// The session socket as the shown summary sees it: its topic's listeners, and each `security.summary` read answered.
function socketWith(body) {
  const listeners = new Set();
  socketReads.watch = (_topic, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const reads = [];
  socketReads.call = async (method, params) => {
    reads.push({ method, params });
    return new Response(JSON.stringify(body()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const announce = (cause, revision) => {
    for (const listener of [...listeners]) listener('security/summary', cause, { epoch: 'a'.repeat(32), revision });
  };
  return { reads, announce };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the summary shown is read over the session socket and read again when Admin says it changed', async () => {
  let failed = 3;
  const socket = socketWith(() => ({
    failed_second_factor_attempts: failed, recovery_codes_remaining: 9, sign_in_history: HISTORY,
  }));
  const seen = [];
  const stop = securitySummary.subscribe((value) => seen.push(value));
  socket.announce('open', 1);
  await flush();
  assert.deepEqual(get(securitySummary), {
    failedAttempts: 3,
    recoveryCodesRemaining: 9,
    signIns: { previous: { at: '2026-10-08T21:14:00Z', origin: 'http://127.0.0.1:7777' }, failuresSince: 2 },
  });
  assert.deepEqual(socket.reads, [{ method: 'security.summary', params: {} }]);
  failed = 4;
  socket.announce('changed', 2);
  await flush();
  assert.equal(get(securitySummary).failedAttempts, 4);
  stop();
  // The session's end forgets it.
  clearSecuritySummary();
  assert.equal(get(securitySummary), null);
});

test('an acknowledgment names exactly the attempts the Supervisor saw, and the summary is read again after it', async () => {
  const socket = socketWith(() => ({
    failed_second_factor_attempts: 0, recovery_codes_remaining: 10, sign_in_history: null,
  }));
  const stop = securitySummary.subscribe(() => {});
  socket.announce('open', 1);
  await flush();
  const reads = socketReads.call;
  const acknowledged = [];
  socketReads.call = async (method, params) => {
    if (method !== 'security.acknowledge') return reads(method, params);
    acknowledged.push(params);
    return new Response(JSON.stringify({
      failed_second_factor_attempts: 1, recovery_codes_remaining: 10, sign_in_history: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await acknowledgeFailedAttempts(3);
  assert.deepEqual(acknowledged, [{ body: { acknowledged: 3 } }]);
  // What shows is the summary read afterwards, never the acknowledgment's own answer.
  assert.equal(socket.reads.length, 2);
  assert.equal(get(securitySummary).failedAttempts, 0);
  for (const seen of [0, -1, 1.5, '3', 1_000_001]) {
    await assert.rejects(acknowledgeFailedAttempts(seen), /Invalid sign-in security request/);
  }
  assert.equal(acknowledged.length, 1);
  stop();
  clearSecuritySummary();
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
  assert.deepEqual(await beginRecoveryCodes('a password'), { passkey: null });
  assert.deepEqual(offer.calls, [{ method: 'recovery_codes.confirmation', params: { body: { password: 'a password' } } }]);
  answer(202, { methods: ['totp', 'passkey'], passkey_options: { challenge: 'c' } });
  assert.deepEqual(await beginRecoveryCodes('a password'), { passkey: { challenge: 'c' } });

  const replaced = answer(200, { recovery_codes: CODES });
  assert.deepEqual(await replaceRecoveryCodes({ code: '123456' }), CODES);
  assert.deepEqual(replaced.calls, [{ method: 'recovery_codes.replace', params: { body: { code: '123456' } } }]);
  answer(200, { recovery_codes: CODES });
  assert.deepEqual(await replaceRecoveryCodes({ credential: {} }), CODES);
});

test('a refused or malformed confirmation is a closed error and nothing invalid is sent', async () => {
  answer(429, { code: 'authentication-locked', retry_after: 60 });
  await assert.rejects(beginRecoveryCodes('a password'), (error) => (
    error instanceof SecurityError && error.code === 'authentication-locked' && error.status === 429 && error.retryAfter === 60
  ));
  answer(500, { code: 'Not A Code', retry_after: 1e9 });
  await assert.rejects(beginRecoveryCodes('p'), (error) => error.code === 'request-failed' && error.retryAfter === 0);
  for (const body of [{ methods: ['passkey'] }, { methods: ['totp'], extra: 1 }, { methods: ['totp', 'passkey'] }]) {
    answer(202, body);
    await assert.rejects(beginRecoveryCodes('p'), /response-invalid/);
  }
  const nothing = answer(202, {});
  await assert.rejects(beginRecoveryCodes(''), /request-invalid/);
  for (const proof of [{}, { code: '12345' }, { code: '123456', credential: {} }, { credential: null }]) {
    await assert.rejects(replaceRecoveryCodes(proof), /request-invalid/);
  }
  assert.deepEqual(nothing.calls, []);
  answer(200, { recovery_codes: CODES.slice(1) });
  await assert.rejects(replaceRecoveryCodes({ code: '123456' }), /response-invalid/);
  answer(200, { recovery_codes: CODES, x: 1 });
  await assert.rejects(replaceRecoveryCodes({ code: '123456' }), /response-invalid/);
});

test('replacing the signing key starts with the password and resolves only when Team pins the new key', async () => {
  const offer = answer(202, { methods: ['totp'] });
  assert.deepEqual(await beginSupervisorKeyRotation('a password'), { passkey: null });
  assert.deepEqual(offer.calls, [{ method: 'supervisor_key.confirmation', params: { body: { password: 'a password' } } }]);
  const rotated = answer(200, { rotated: true });
  assert.equal(await rotateSupervisorKey({ code: '123456' }), true);
  assert.deepEqual(rotated.calls, [{ method: 'supervisor_key.rotate', params: { body: { code: '123456' } } }]);
  for (const [status, code] of [
    [503, 'supervisor-key-rotation-pending'],
    [409, 'supervisor-key-rotation-refused'],
    [409, 'supervisor-key-rotation-busy'],
  ]) {
    answer(status, { code });
    await assert.rejects(rotateSupervisorKey({ code: '123456' }), (error) => (
      error instanceof SecurityError && error.code === code && error.status === status
    ));
  }
  for (const body of [{}, { rotated: false }, { rotated: true, key_sha256: 'a' }]) {
    answer(200, body);
    await assert.rejects(rotateSupervisorKey({ code: '123456' }), /response-invalid/);
  }
  await assert.rejects(rotateSupervisorKey({ code: '12' }), /request-invalid/);
});

test('a confirmation the socket lost before Admin answered is never replayed', async () => {
  const lost = new LocalApiError('Admin disconnected before it answered.', 0, OUTCOME_UNKNOWN);
  let sent = 0;
  socketReads.call = async () => {
    sent += 1;
    throw lost;
  };
  await assert.rejects(rotateSupervisorKey({ code: '123456' }), (error) => error === lost);
  await assert.rejects(beginRecoveryCodes('a password'), (error) => error === lost);
  assert.equal(sent, 2);
});
