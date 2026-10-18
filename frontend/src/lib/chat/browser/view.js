// Watching a Browser task's screen (ADR-0117, over KasmVNC): the view of the task the Team runs now is opened over the
// session socket, and its screen is one binary WebSocket that Admin relays to the Browser's display, drawn by noVNC on a
// bare canvas in view-only mode. Only Admin's exact answers are admitted.

import { exactKeys, jsonObject, LocalApiError } from '../../api.js';
import { TEAM_ID_RE } from '../../ids.js';
import { socketReads } from '../../session/socket.js';

const VIEW_ID_RE = /^[0-9a-f]{32}$/;
const NOT_RUNNING = 'browser-not-running';
// The Browser step shows before Team has created the Browser (seconds, at most its egress restart and readiness): the
// view is asked for again until it opens or this long passed.
const OPEN_RETRY_MS = 500;
const OPEN_WAIT_MS = 60_000;
// The display sends JPEG at this quality and compresses its other encodings at this level (noVNC's 0-9 scales).
const QUALITY = 8;
const COMPRESSION = 2;

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

/** The screen's WebSocket address on this page's own origin. */
export function streamUrl(teamId, viewId, location = globalThis.location) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/teams/${encodeURIComponent(teamId)}/browser/views/${viewId}/stream`;
}

/**
 * Watch the Team's running Browser task on `target` until `signal` aborts or the stream ends. `RFB` is noVNC's client,
 * which shows the screen and sends no input. Calls `onconnect` once the screen shows; rejects with
 * BrowserViewEndedError when the task ended, the abort reason when closed, or the failure that ended it.
 */
export async function watchBrowser(
  teamId,
  { signal, target, RFB, onconnect = () => {}, call = socketReads.call, location = globalThis.location },
) {
  const viewId = await openWhenRunning(teamId, signal, call);
  signal.throwIfAborted();
  return new Promise((_resolve, reject) => {
    const rfb = new RFB(target, streamUrl(teamId, viewId, location), { wsProtocols: ['binary'] });
    rfb.viewOnly = true;
    rfb.focusOnClick = false;
    rfb.scaleViewport = true;
    rfb.clipViewport = false;
    rfb.resizeSession = false;
    rfb.showDotCursor = false;
    rfb.qualityLevel = QUALITY;
    rfb.compressionLevel = COMPRESSION;
    const abort = () => {
      rfb.disconnect();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    rfb.addEventListener('connect', () => onconnect());
    rfb.addEventListener('disconnect', () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return;
      // The stream ended: the task's view answering again means the stream failed, its absence that the task ended.
      openBrowserView(teamId, call).then(
        () => reject(new LocalApiError('The Browser view is unavailable.')),
        reject,
      );
    });
  });
}

// The task's view once Team holds its Browser. Each ask is bounded by the time left and by closing the view, whose
// late answer is discarded; a view still not open after OPEN_WAIT_MS is unavailable, never a task that ended.
async function openWhenRunning(teamId, signal, call) {
  const until = Date.now() + OPEN_WAIT_MS;
  for (;;) {
    signal.throwIfAborted();
    const left = until - Date.now();
    if (left <= 0) throw new LocalApiError('The Browser view did not open.');
    try {
      return await bounded(openBrowserView(teamId, call), left, signal);
    } catch (error) {
      if (!(error instanceof BrowserViewEndedError)) throw error;
    }
    await pause(OPEN_RETRY_MS, signal);
  }
}

// `promise`'s answer, unless `ms` pass or `signal` aborts first.
function bounded(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const settle = (finish) => (value) => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      finish(value);
    };
    const abort = () => settle(reject)(signal.reason);
    const timer = globalThis.setTimeout(() => settle(reject)(new LocalApiError('The Browser view did not open.')), ms);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(settle(resolve), settle(reject));
  });
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
