import { writable } from 'svelte/store';

import { backgroundFetch, LocalApiError, safeApiError } from './localApi.js';
import { exactKeys, jsonObject } from './validate.js';

// The Supervisor's own sign-in security (ADR-0051): the refused second-factor attempts a sign-in reported, kept until
// the Supervisor acknowledges them, and the single-use recovery codes left.
const SUMMARY = '/api/admin/security';
const FAILURES = '/api/admin/security/failures';
const RECOVERY_CODES = '/api/admin/recovery-codes';
const MAX_COUNT = 1_000_000;
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_RE = /^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/;
const REFUSAL_RE = /^[a-z][a-z0-9-]{0,63}$/;

export const securitySummary = writable(null);

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function summary(response, body) {
  if (
    !exactKeys(body, ['failed_second_factor_attempts', 'recovery_codes_remaining']) ||
    !count(body.failed_second_factor_attempts) ||
    !count(body.recovery_codes_remaining) ||
    body.recovery_codes_remaining > RECOVERY_CODE_COUNT
  ) {
    throw new LocalApiError('The sign-in security summary is invalid.', response.status);
  }
  return { failedAttempts: body.failed_second_factor_attempts, recoveryCodesRemaining: body.recovery_codes_remaining };
}

async function send(fetcher, url, init, fallback) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid sign-in security request.');
  const response = await fetcher(url, { cache: 'no-store', ...init });
  const body = await jsonObject(response);
  if (!response.ok) throw new LocalApiError(safeApiError(body, fallback), response.status);
  const result = summary(response, body);
  securitySummary.set(result);
  return result;
}

/** Read the summary when the signed-in page opens; the page asks on its own, so it is no Supervisor activity. */
export function loadSecuritySummary(fetcher = backgroundFetch) {
  return send(fetcher, SUMMARY, { headers: { Accept: 'application/json' } }, 'The sign-in security summary is unavailable.');
}

/** Acknowledge exactly the failed attempts the Supervisor saw; any reported since stay. */
export function acknowledgeFailedAttempts(fetcher, seen) {
  if (!Number.isSafeInteger(seen) || seen < 1 || seen > MAX_COUNT) {
    return Promise.reject(new LocalApiError('Invalid sign-in security request.'));
  }
  return send(
    fetcher,
    FAILURES,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledged: seen }),
    },
    'The acknowledgment could not be saved.',
  );
}

export function clearSecuritySummary() {
  securitySummary.set(null);
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

async function confirmation(fetcher, url, payload) {
  if (typeof fetcher !== 'function') throw new SecurityError('request-invalid');
  const response = await fetcher(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    const code = typeof body.code === 'string' && REFUSAL_RE.test(body.code) ? body.code : 'request-failed';
    const retryAfter = Number.isInteger(body.retry_after) && body.retry_after > 0 && body.retry_after <= 86_400
      ? body.retry_after : 0;
    throw new SecurityError(code, response.status, retryAfter);
  }
  return body;
}

/** Start replacing the recovery codes with the Supervisor password; Admin offers the second factor that confirms it. */
export async function beginRecoveryCodes(fetcher, password) {
  if (typeof password !== 'string' || password.length < 1) throw new SecurityError('request-invalid');
  const body = await confirmation(fetcher, `${RECOVERY_CODES}/confirmation`, { password });
  const methods = JSON.stringify(body.methods);
  if (methods === '["totp"]' && exactKeys(body, ['methods'])) return { passkey: null };
  if (methods === '["totp","passkey"]' && exactKeys(body, ['methods', 'passkey_options']) && body.passkey_options
    && typeof body.passkey_options === 'object') {
    return { passkey: body.passkey_options };
  }
  throw new SecurityError('response-invalid');
}

/** Spend the started confirmation on one second factor, `{ code }` or `{ credential }`, and receive the new set once. */
export async function replaceRecoveryCodes(fetcher, proof) {
  const byCode = exactKeys(proof, ['code']) && /^[0-9]{6}$/.test(proof.code);
  const byPasskey = exactKeys(proof, ['credential']) && proof.credential && typeof proof.credential === 'object';
  if (!byCode && !byPasskey) throw new SecurityError('request-invalid');
  const body = await confirmation(fetcher, RECOVERY_CODES, proof);
  const codes = exactKeys(body, ['recovery_codes']) ? recoveryCodes(body.recovery_codes) : null;
  if (!codes) throw new SecurityError('response-invalid');
  securitySummary.update((current) => current && { ...current, recoveryCodesRemaining: RECOVERY_CODE_COUNT });
  return codes;
}
