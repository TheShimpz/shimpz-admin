// Watching a Browser task's screen (ADR-0117, M2 Watch): the view of the task the Team runs now is opened over the
// session socket, and its frames, PNGs Team built itself, come over HTTP. Only Admin's exact answers are admitted.

import { exactKeys, jsonObject, LocalApiError } from '../../api.js';
import { TEAM_ID_RE } from '../../ids.js';
import { socketReads } from '../../session/socket.js';

const VIEW_ID_RE = /^[0-9a-f]{32}$/;
const FRAME_NUMBER_RE = /^[1-9][0-9]{0,9}$/;
const MAX_FRAME_NUMBER = 2 ** 31 - 1;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const FRAME_HEADER = 'x-shimpz-browser-frame';
const NOT_RUNNING = 'browser-not-running';
// How long a busy view waits before it asks again, and the pause after an answer that brought no newer frame.
const BUSY_RETRY_MS = 250;
const UNCHANGED_PAUSE_MS = 100;
// The Browser step shows before Team has created the Browser (seconds, at most its egress restart and readiness): the
// view is asked for again until it opens or this long passed.
const OPEN_RETRY_MS = 500;
const OPEN_WAIT_MS = 60_000;

/** The Browser task ended, or the Team runs none: there is nothing more to watch. */
export class BrowserViewEndedError extends Error {
  constructor() {
    super('The Browser task is not running.');
    this.name = 'BrowserViewEndedError';
  }
}

/** The id of the screen view of the Browser task the Team runs now. */
export async function openBrowserView(teamId, call = socketReads.call) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) throw new LocalApiError('The Browser view is invalid.');
  const response = await call('browser.view', { team_id: teamId });
  const body = await jsonObject(response);
  if (response.ok && exactKeys(body, ['view_id']) && typeof body.view_id === 'string' && VIEW_ID_RE.test(body.view_id)) {
    return body.view_id;
  }
  if (response.status === 404 && body.code === NOT_RUNNING) throw new BrowserViewEndedError();
  throw new LocalApiError('The Browser view is unavailable.', response.status);
}

/**
 * The view's next frame after `after`: `{ number, blob }`, `null` when none came in time, `'busy'` when the view is
 * busy, or BrowserViewEndedError once the task ended.
 */
export async function fetchBrowserFrame(teamId, viewId, after, signal, fetcher = globalThis.fetch) {
  const url = `/api/teams/${encodeURIComponent(teamId)}/browser/views/${viewId}/frames/${after}`;
  const response = await fetcher(url, { signal, cache: 'no-store', credentials: 'same-origin' });
  if (response.status === 204) return null;
  if (response.status === 200) {
    const raw = response.headers.get(FRAME_HEADER) ?? '';
    const number = FRAME_NUMBER_RE.test(raw) ? Number(raw) : 0;
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const blob = await response.blob();
    if (number > after && number <= MAX_FRAME_NUMBER && type === 'image/png' && blob.size > 0 &&
      blob.size <= MAX_FRAME_BYTES) {
      return { number, blob };
    }
    throw new LocalApiError('The Browser frame is invalid.');
  }
  const body = await jsonObject(response);
  if (response.status === 404 && body.code === NOT_RUNNING) throw new BrowserViewEndedError();
  if (response.status === 503 && body.code === 'browser-view-busy') return 'busy';
  throw new LocalApiError('The Browser frame is unavailable.', response.status);
}

/**
 * Watch the Team's running Browser task until `signal` aborts or the task ends: each newer frame is handed to `onframe`
 * as a PNG Blob. Team holds each request until a newer frame or its short wait passes, so the next is asked at once.
 * Rejects with BrowserViewEndedError when the task ended, or with the failure that stopped it.
 */
export async function watchBrowser(teamId, { signal, onframe, call = socketReads.call, fetcher = globalThis.fetch }) {
  const viewId = await openWhenRunning(teamId, signal, call);
  let after = 0;
  for (;;) {
    signal.throwIfAborted();
    const frame = await fetchBrowserFrame(teamId, viewId, after, signal, fetcher);
    // A view closed while the answer arrived shows nothing more.
    signal.throwIfAborted();
    if (frame === 'busy') {
      await pause(BUSY_RETRY_MS, signal);
    } else if (frame === null) {
      await pause(UNCHANGED_PAUSE_MS, signal);
    } else {
      after = frame.number;
      onframe(frame.blob);
    }
  }
}

// The task's view once Team holds its Browser; still not running after OPEN_WAIT_MS, the task has ended.
async function openWhenRunning(teamId, signal, call) {
  const until = Date.now() + OPEN_WAIT_MS;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await openBrowserView(teamId, call);
    } catch (error) {
      if (!(error instanceof BrowserViewEndedError) || Date.now() >= until) throw error;
    }
    await pause(OPEN_RETRY_MS, signal);
  }
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
