import { LocalApiError, safeApiError } from './localApi.js';
import { ASSISTANT_ID_RE } from './validate.js';

const MAX_CONCURRENT_ICONS = 2;
const MAX_ICON_BYTES = 1024 * 1024;
const MAX_BUSY_RETRIES = 2;
const PUBLIC_BUSY_RETRY_MS = 50;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function createQueue() {
  return { active: 0, pending: [] };
}

const localQueue = createQueue();
const publicQueue = createQueue();

function abortError() {
  return new DOMException('The Assistant icon request was aborted.', 'AbortError');
}

function drain(queue) {
  while (queue.active < MAX_CONCURRENT_ICONS && queue.pending.length > 0) {
    const item = queue.pending.shift();
    if (item.signal?.aborted) {
      item.reject(abortError());
      continue;
    }
    item.started = true;
    if (item.signal) item.signal.removeEventListener('abort', item.abort);
    queue.active += 1;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        queue.active -= 1;
        drain(queue);
      });
  }
}

function schedule(queue, task, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const item = {
      abort: null,
      reject,
      resolve,
      signal,
      started: false,
      task,
    };
    item.abort = () => {
      if (item.started) return;
      const index = queue.pending.indexOf(item);
      if (index >= 0) queue.pending.splice(index, 1);
      reject(abortError());
    };
    if (signal) signal.addEventListener('abort', item.abort, { once: true });
    queue.pending.push(item);
    drain(queue);
  });
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function localBusyRetry(response) {
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

async function responseError(response, fallback) {
  let body = {};
  try { body = await response.json(); } catch { /* Use the bounded fallback. */ }
  return new LocalApiError(safeApiError(body, fallback), response.status);
}

async function acceptedPng(response) {
  const mediaType = response.headers?.get?.('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const icon = await response.blob();
  if (mediaType !== 'image/png' || icon.type !== 'image/png' || icon.size < 1 || icon.size > MAX_ICON_BYTES) {
    throw new LocalApiError('The Assistant icon is invalid.', response.status);
  }
  return icon;
}

async function fetchLocalIcon(fetcher, imageId, delay, signal) {
  const imageHash = imageId.slice('sha256:'.length);
  for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt += 1) {
    const response = await fetcher(`/api/local-assistants/${imageHash}/icon`, {
      cache: 'no-store',
      headers: { Accept: 'image/png' },
      signal,
    });
    if (!response.ok) {
      const retryAfter = await localBusyRetry(response);
      if (retryAfter !== null && attempt < MAX_BUSY_RETRIES) {
        await delay(retryAfter, signal);
        continue;
      }
      throw await responseError(response, 'The Local Assistant icon is unavailable.');
    }
    return acceptedPng(response);
  }
  throw new LocalApiError('The Local Assistant icon is unavailable.');
}

async function fetchPublicIcon(fetcher, assistantId, delay, signal) {
  for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt += 1) {
    const response = await fetcher(`/api/assistants/${encodeURIComponent(assistantId)}/catalog-icon`, {
      cache: 'no-store',
      headers: { Accept: 'image/png' },
      signal,
    });
    if (!response.ok) {
      if (response.status === 503 && attempt < MAX_BUSY_RETRIES) {
        await delay(PUBLIC_BUSY_RETRY_MS * (attempt + 1), signal);
        continue;
      }
      throw await responseError(response, 'The Assistant icon is unavailable.');
    }
    return acceptedPng(response);
  }
  throw new LocalApiError('The Assistant icon is unavailable.');
}

/** Fetch one admitted Local icon through the preview boundary's two-slot queue. */
export function loadLocalAssistantIcon(fetcher, imageId, options = {}) {
  const { delay = sleep, signal } = options;
  if (
    typeof fetcher !== 'function' ||
    !SHA256_RE.test(imageId) ||
    typeof delay !== 'function' ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  ) {
    return Promise.reject(new LocalApiError('Invalid Local Assistant icon request.'));
  }
  return schedule(localQueue, () => fetchLocalIcon(fetcher, imageId, delay, signal), signal);
}

/** Fetch one public catalog icon through a queue matching Admin's bounded backend executor. */
export function loadPublicAssistantIcon(fetcher, assistantId, options = {}) {
  const { delay = sleep, signal } = options;
  if (
    typeof fetcher !== 'function' ||
    typeof assistantId !== 'string' ||
    !ASSISTANT_ID_RE.test(assistantId) ||
    typeof delay !== 'function' ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  ) {
    return Promise.reject(new LocalApiError('Invalid Assistant icon request.'));
  }
  return schedule(publicQueue, () => fetchPublicIcon(fetcher, assistantId, delay, signal), signal);
}
