import { exactKeys, jsonObject } from '../api.js';
import { isInstant } from '../grammar.js';

// A published release set, or a developer release built on this host (ADR-0099).
const RELEASE = /^(?:ghcr\.io\/theshimpz|localhost)\/shimpz-local-release@sha256:[0-9a-f]{64}$/;
const OUTCOMES = new Set(['current', 'updated', 'rollback-needed']);

export async function fetchPlatformRelease(read) {
  const response = await read('platform.release', {});
  if (!response.ok) return null;
  const body = await jsonObject(response);
  if (
    !exactKeys(body, ['checked_at', 'ordinal', 'outcome', 'release'])
    || !RELEASE.test(body.release)
    || !Number.isSafeInteger(body.ordinal)
    || body.ordinal <= 0
    || !isInstant(body.checked_at)
    || !OUTCOMES.has(body.outcome)
  ) return null;
  return body;
}

export function isDeveloperRelease(status) {
  return status?.release.startsWith('localhost/') === true;
}
