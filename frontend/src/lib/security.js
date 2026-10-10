import { writable } from 'svelte/store';

import { backgroundFetch, LocalApiError, safeApiError } from './localApi.js';
import { exactKeys, jsonObject } from './validate.js';

// The Supervisor's own sign-in security (ADR-0051): the refused second-factor attempts a sign-in reported, kept until
// the Supervisor acknowledges them.
const SUMMARY = '/api/admin/security';
const FAILURES = '/api/admin/security/failures';
const MAX_COUNT = 1_000_000;

export const securitySummary = writable(null);

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function summary(response, body) {
  if (!exactKeys(body, ['failed_second_factor_attempts']) || !count(body.failed_second_factor_attempts)) {
    throw new LocalApiError('The sign-in security summary is invalid.', response.status);
  }
  return { failedAttempts: body.failed_second_factor_attempts };
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
