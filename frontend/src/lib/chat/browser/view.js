// Watching a Browser task's screen (ADR-0117, ADR-0126): the view of the task the Team runs now is opened over the
// session socket, and its screen is one binary WebSocket that Admin relays to the Browser's display, drawn by noVNC on a
// bare canvas in view-only mode. A sign-in session's Browser is driven instead, over the view's control stream (Sign-ins
// amendment). Only Admin's exact answers are admitted.

import { exactKeys, jsonObject, LocalApiError } from '../../api.js';
import { TEAM_ID_RE } from '../../ids.js';
import { socketReads } from '../../session/socket.js';

const VIEW_ID_RE = /^[0-9a-f]{32}$/;
const NOT_RUNNING = 'browser-not-running';
// The Browser step shows before Team has created the Browser (seconds, at most its egress restart and readiness): the
// view is asked for again until it opens or this long passed.
const OPEN_RETRY_MS = 500;
const OPEN_WAIT_MS = 60_000;
// How long the view is asked for once its stream ended, to tell a task that ended from a stream that failed.
const CHECK_WAIT_MS = 10_000;
// easi.run's viewer, as the installed release serves it through Team.
const VIEWER = '/api/browser/viewer.js';
// What each screen lets its person do, as easi.run names it. Whoever watches sends nothing.
const NOTHING = {
  keyboard_pointer: false, clipboard: false, uploads: false, downloads: false, sound: false, recording: false, replay: false,
};
const DRIVING = { ...NOTHING, keyboard_pointer: true, clipboard: true, uploads: true };

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

/** The screen's WebSocket address on this page's own origin: its `stream`, or its `control` for the person driving it. */
export function streamUrl(teamId, viewId, location = globalThis.location, kind = 'stream') {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/teams/${encodeURIComponent(teamId)}/browser/views/${viewId}/${kind}`;
}

/** easi.run's viewer module, loaded when a screen first opens. */
export function loadViewer() {
  return import(/* @vite-ignore */ VIEWER);
}

// easi.run's viewer of one screen on `target`, scaled to it. Its stream ending is the one fatal error it reports.
function screen(sdk, target, url, viewId, { control, onconnect, onended }) {
  let viewer = null;
  viewer = sdk.mountViewer(target, {
    url,
    session: viewId,
    features: control ? DRIVING : NOTHING,
    onLease(lease) {
      if (control) viewer?.setControl(lease.holder === sdk.LeaseHolder.You);
    },
    onPicture: onconnect,
    onError(_error, fatal) {
      if (fatal) onended();
    },
  });
  return viewer;
}

/**
 * Drive a sign-in session's Browser on `target` until `signal` aborts or the stream ends. Calls `onconnect` once the
 * screen shows; rejects with the abort reason when closed, or BrowserViewEndedError once the stream ended.
 */
export async function controlBrowser(
  teamId,
  viewId,
  { signal, target, onconnect = () => {}, load = loadViewer, location = globalThis.location },
) {
  if (!TEAM_ID_RE.test(teamId) || !VIEW_ID_RE.test(viewId)) throw new LocalApiError('The Browser view is invalid.');
  signal.throwIfAborted();
  const sdk = await load();
  signal.throwIfAborted();
  return new Promise((_resolve, reject) => {
    const viewer = screen(sdk, target, streamUrl(teamId, viewId, location, 'control'), viewId, {
      control: true,
      onconnect,
      onended() {
        signal.removeEventListener('abort', abort);
        viewer?.close();
        if (!signal.aborted) reject(new BrowserViewEndedError());
      },
    });
    const abort = () => {
      viewer.close();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Watch the Team's running Browser task on `target` until `signal` aborts or the stream ends: it shows the screen and
 * sends no input. Calls `onconnect` once the screen shows; rejects with BrowserViewEndedError when the task ended, the
 * abort reason when closed, or the failure that ended it.
 */
export async function watchBrowser(
  teamId,
  { signal, target, onconnect = () => {}, call = socketReads.call, load = loadViewer, location = globalThis.location },
) {
  const sdk = await load();
  const viewId = await openWhenRunning(teamId, signal, call);
  signal.throwIfAborted();
  return new Promise((_resolve, reject) => {
    const viewer = screen(sdk, target, streamUrl(teamId, viewId, location), viewId, {
      control: false,
      onconnect,
      onended() {
        if (signal.aborted) return;
        viewer?.close();
        // The stream ended: the task's view answering again means the stream failed, its absence that the task ended.
        // Closing the view still settles at once, and an answer that never comes is unavailable in time.
        bounded(openBrowserView(teamId, call), CHECK_WAIT_MS, signal)
          .then(() => reject(new LocalApiError('The Browser view is unavailable.')), reject)
          .finally(() => signal.removeEventListener('abort', abort));
      },
    });
    const abort = () => {
      viewer.close();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
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
