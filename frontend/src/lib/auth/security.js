import { derived } from 'svelte/store';

import { socketReads } from '../session/socket.js';
import { synced } from '../session/synced.js';
import { exactKeys, jsonObject, LocalApiError, safeApiError } from '../api.js';
import { ERROR_CODE_RE, isInstant } from '../grammar.js';
import { factorOffer, isFactorProof } from './factor.js';

// The Supervisor's own sign-in security (ADR-0051): the refused second-factor attempts a sign-in reported, kept until
// the Supervisor acknowledges them, and the single-use recovery codes left. Every read and change goes over the Admin
// session socket (ADR-0114); a change it lost before Admin answered rejects with `outcome-unknown`, never replayed.
const MAX_COUNT = 1_000_000;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_RE = /^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/;


function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
}

const ORIGIN_RE = /^https?:\/\/[a-z0-9.[\]:-]{1,253}$/;

// The sign-in before this one and the refused attempts since, read back from Admin's journal; null while unreadable.
function history(value) {
  if (value === null) return { valid: true, history: null };
  if (!exactKeys(value, ['previous', 'failures_since']) || !count(value.failures_since)) return { valid: false };
  const previous = value.previous;
  if (previous === null) return { valid: true, history: { previous: null, failuresSince: value.failures_since } };
  if (
    !exactKeys(previous, ['at', 'origin']) ||
    !isInstant(previous.at) ||
    (previous.origin !== null && (typeof previous.origin !== 'string' || !ORIGIN_RE.test(previous.origin)))
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    history: { previous: { at: previous.at, origin: previous.origin }, failuresSince: value.failures_since },
  };
}

function summary(response, body) {
  const signIns = history(body?.sign_in_history);
  if (
    !exactKeys(body, ['failed_second_factor_attempts', 'recovery_codes_remaining', 'sign_in_history']) ||
    !count(body.failed_second_factor_attempts) ||
    !count(body.recovery_codes_remaining) ||
    body.recovery_codes_remaining > RECOVERY_CODE_COUNT ||
    !signIns.valid
  ) {
    throw new LocalApiError('The sign-in security summary is invalid.', response.status);
  }
  return {
    failedAttempts: body.failed_second_factor_attempts,
    recoveryCodesRemaining: body.recovery_codes_remaining,
    signIns: signIns.history,
  };
}

async function validated(answer, fallback) {
  const response = await answer;
  const body = await jsonObject(response);
  if (!response.ok) throw new LocalApiError(safeApiError(body, fallback), response.status);
  return summary(response, body);
}

/** Read the summary over the session socket with `read`, as Admin answers it. */
export function loadSecuritySummary(read) {
  if (typeof read !== 'function') return Promise.reject(new LocalApiError('Invalid sign-in security request.'));
  return validated(read('security.summary', {}), 'The sign-in security summary is unavailable.');
}

// The summary as every screen shows it: read over the session socket and again whenever Admin says it changed (a
// sign-in, a refusal, an acknowledgment, new recovery codes); a change never writes it itself.
const summaryValue = synced('security/summary', loadSecuritySummary);
export const securitySummary = derived(summaryValue, (state) => state.value);

/** Acknowledge exactly the failed attempts the Supervisor saw; any reported since stay. */
export function acknowledgeFailedAttempts(seen) {
  if (!Number.isSafeInteger(seen) || seen < 1 || seen > MAX_COUNT) {
    return Promise.reject(new LocalApiError('Invalid sign-in security request.'));
  }
  const answer = socketReads.call('security.acknowledge', { body: { acknowledged: seen } });
  // The summary shown is the one read after Admin announces the acknowledgment.
  return validated(answer, 'The acknowledgment could not be saved.').then(() => summaryValue.refresh());
}

export function clearSecuritySummary() {
  summaryValue.reset();
}

/** A fresh set exactly as Admin shows it once: ten distinct codes written xxxx-xxxx-xxxx, or null. */
export function recoveryCodes(value) {
  if (
    !Array.isArray(value) ||
    value.length !== RECOVERY_CODE_COUNT ||
    !value.every((code) => typeof code === 'string' && RECOVERY_CODE_RE.test(code)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value];
}

/** The plain text a Supervisor copies or downloads: the heading, then one code per line. */
export function recoveryCodesText(codes, heading) {
  return `${heading}\n\n${codes.join('\n')}\n`;
}

/** A refused confirmation: its closed code and, for a lockout, how many seconds to wait. */
export class SecurityError extends Error {
  constructor(code, status = 0, retryAfter = 0) {
    super(code);
    this.name = 'SecurityError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function confirmation(method, payload) {
  const response = await socketReads.call(method, { body: payload });
  const body = await jsonObject(response);
  if (!response.ok) {
    const code = typeof body.code === 'string' && ERROR_CODE_RE.test(body.code) ? body.code : 'request-failed';
    const retryAfter = Number.isInteger(body.retry_after) && body.retry_after > 0 && body.retry_after <= 86_400
      ? body.retry_after : 0;
    throw new SecurityError(code, response.status, retryAfter);
  }
  return body;
}

// A confirmed operation starts with the Supervisor password; Admin offers the second factor that confirms it.
async function beginOperation(method, password) {
  if (typeof password !== 'string' || password.length < 1) throw new SecurityError('request-invalid');
  const body = await confirmation(method, { password });
  const offer = factorOffer(body);
  if (offer === null) throw new SecurityError('response-invalid');
  return offer;
}

/** Start replacing the recovery codes with the Supervisor password. */
export function beginRecoveryCodes(password) {
  return beginOperation('recovery_codes.confirmation', password);
}

// Spend a started confirmation on one second factor, `{ code }` or `{ credential }`.
function completeOperation(method, proof) {
  if (!isFactorProof(proof)) return Promise.reject(new SecurityError('request-invalid'));
  return confirmation(method, proof);
}

/** Spend the started confirmation on one second factor and receive the new set once. */
export async function replaceRecoveryCodes(proof) {
  const body = await completeOperation('recovery_codes.replace', proof);
  const codes = exactKeys(body, ['recovery_codes']) ? recoveryCodes(body.recovery_codes) : null;
  if (!codes) throw new SecurityError('response-invalid');
  void summaryValue.refresh();
  return codes;
}

// The Supervisor's signing key (ADR-0051): Team verifies every Supervisor request under the key it pins, and replaces
// that pin only when the current key signs the change. Replacing it is a confirmed operation.

/** Start replacing the Supervisor signing key with the Supervisor password. */
export function beginSupervisorKeyRotation(password) {
  return beginOperation('supervisor_key.confirmation', password);
}

/**
 * Spend the started confirmation on one second factor; resolves once Team pins the new key. A refusal names why:
 * `supervisor-key-rotation-refused` (Team kept the current key), `supervisor-key-rotation-pending` (the new key is
 * saved and Admin keeps asking Team), or `supervisor-key-rotation-busy` (another replacement is in progress).
 */
export async function rotateSupervisorKey(proof) {
  const body = await completeOperation('supervisor_key.rotate', proof);
  if (!exactKeys(body, ['rotated']) || body.rotated !== true) throw new SecurityError('response-invalid');
  return true;
}
