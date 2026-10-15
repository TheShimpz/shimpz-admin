import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalApiError } from '../src/lib/api.js';
import { secondFactorRefusal } from '../src/lib/auth/refusal.js';
import { OUTCOME_UNKNOWN } from '../src/lib/session/socket.js';

const WORDS = {
  passwordIncorrect: 'password',
  codeIncorrect: 'code',
  locked: 'locked {seconds}',
  codeLocked: 'code locked',
  expired: 'expired',
  passkeyFailed: 'passkey failed',
  passkeyCanceled: 'passkey canceled',
  unavailable: 'unavailable',
  outcomeUnknown: 'unknown',
};

class OwnError extends Error {}

const operation = (failure) => (failure instanceof OwnError ? 'own' : null);
// A passkey ceremony the person dismissed reads as canceled, as passkey.js reads a NotAllowedError.
const ceremony = (failure) => (failure?.name === 'NotAllowedError' ? 'canceled' : 'failed');
const shown = (failure, reason = '') => secondFactorRefusal(failure, { reason, words: WORDS, operation, ceremony });

test('an authentication refusal clears and focuses the field that fixes it, or says why at the form', () => {
  const failure = new OwnError();
  assert.deepEqual(shown(failure, 'password-incorrect'), {
    clear: 'password', focus: 'password', passwordError: 'password',
  });
  assert.deepEqual(shown(failure, 'code-incorrect'), { clear: 'code', focus: 'code', codeError: 'code' });
  assert.deepEqual(shown(Object.assign(failure, { retryAfter: 9 }), 'authentication-locked'), { error: 'locked 9' });
  assert.deepEqual(shown(new OwnError(), 'authentication-locked'), { error: 'locked 60' });
  assert.deepEqual(shown(failure, 'code-locked'), { clear: 'code', error: 'code locked' });
  assert.deepEqual(shown(failure, 'authentication-expired'), { error: 'expired' });
  for (const reason of ['passkey-failed', 'passkey-suspended']) {
    assert.deepEqual(shown(failure, reason), { error: 'passkey failed' });
  }
  for (const reason of ['authentication-unavailable', 'authentication-origin-refused']) {
    assert.deepEqual(shown(failure, reason), { error: 'unavailable' });
  }
});

test("any other failure is the operation's own, a lost answer, a request that never left, or the passkey's", () => {
  assert.deepEqual(shown(new OwnError(), 'routine-busy'), { error: 'own' });
  assert.deepEqual(shown(new LocalApiError('lost', 0, OUTCOME_UNKNOWN)), { error: 'unknown' });
  assert.deepEqual(shown(new LocalApiError('closed', 0, 'socket-closed')), { error: 'unavailable' });
  assert.deepEqual(shown(new DOMException('no', 'NotAllowedError')), { error: 'passkey canceled' });
  assert.deepEqual(shown(new Error('x')), { error: 'passkey failed' });
});
