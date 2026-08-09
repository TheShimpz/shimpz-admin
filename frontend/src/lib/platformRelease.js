import { exactKeys, jsonObject } from './validate.js';

const RELEASE = /^ghcr\.io\/theshimpz\/shimpz-local-release@sha256:[0-9a-f]{64}$/;
const TIMESTAMP = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const OUTCOMES = new Set(['current', 'updated', 'rollback-needed']);

export async function fetchPlatformRelease(fetcher = fetch) {
  const response = await fetcher('/api/platform-release', { cache: 'no-store' });
  if (!response.ok) return null;
  const body = await jsonObject(response);
  if (
    !exactKeys(body, ['checked_at', 'ordinal', 'outcome', 'release'])
    || !RELEASE.test(body.release)
    || !Number.isSafeInteger(body.ordinal)
    || body.ordinal <= 0
    || typeof body.checked_at !== 'string'
    || !TIMESTAMP.test(body.checked_at)
    || Number.isNaN(Date.parse(body.checked_at))
    || !OUTCOMES.has(body.outcome)
  ) return null;
  return body;
}
