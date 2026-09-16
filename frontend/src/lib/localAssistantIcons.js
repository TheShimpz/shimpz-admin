import { LocalApiError, safeApiError } from './localApi.js';

const MAX_CONCURRENT_ICONS = 2;
const MAX_ICON_BYTES = 1024 * 1024;
const MAX_BUSY_RETRIES = 2;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

let active = 0;
const pending = [];

function drain() {
  while (active < MAX_CONCURRENT_ICONS && pending.length > 0) {
    const item = pending.shift();
    active += 1;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        active -= 1;
        drain();
      });
  }
}

function schedule(task) {
  return new Promise((resolve, reject) => {
    pending.push({ task, resolve, reject });
    drain();
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function busyRetry(response) {
  if (response.status !== 503) return null;
  try {
    const body = await response.json();
    if (
      body?.code === 'local-assistant-preview-busy' &&
      Number.isInteger(body.retry_after_ms) &&
      body.retry_after_ms >= 1 &&
      body.retry_after_ms <= 2000
    ) {
      return body.retry_after_ms;
    }
  } catch {
    // The bounded error below is authoritative for an invalid retry response.
  }
  return null;
}

async function fetchIcon(fetcher, imageId, delay) {
  const imageHash = imageId.slice('sha256:'.length);
  for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt += 1) {
    const response = await fetcher(`/api/local-assistants/${imageHash}/icon`, {
      cache: 'no-store',
      headers: { Accept: 'image/png' },
    });
    if (!response.ok) {
      const retryAfter = await busyRetry(response);
      if (retryAfter !== null && attempt < MAX_BUSY_RETRIES) {
        await delay(retryAfter);
        continue;
      }
      let body = {};
      try { body = await response.json(); } catch { /* Use the bounded fallback. */ }
      throw new LocalApiError(
        safeApiError(body, 'The Local Assistant icon is unavailable.'),
        response.status,
      );
    }
    const mediaType = response.headers?.get?.('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const icon = await response.blob();
    if (mediaType !== 'image/png' || icon.type !== 'image/png' || icon.size < 1 || icon.size > MAX_ICON_BYTES) {
      throw new LocalApiError('The Local Assistant icon is invalid.', response.status);
    }
    return icon;
  }
  throw new LocalApiError('The Local Assistant icon is unavailable.');
}

/** Fetch one admitted Local icon through a global, non-caching two-slot queue. */
export function loadLocalAssistantIcon(fetcher, imageId, delay = sleep) {
  if (typeof fetcher !== 'function' || !SHA256_RE.test(imageId) || typeof delay !== 'function') {
    return Promise.reject(new LocalApiError('Invalid Local Assistant icon request.'));
  }
  return schedule(() => fetchIcon(fetcher, imageId, delay));
}
