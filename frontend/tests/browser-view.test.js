import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserViewEndedError,
  openBrowserView,
  streamUrl,
  watchBrowser,
} from '../src/lib/chat/browser/view.js';
import { recorder } from './socketStub.js';

// Watching a Browser task's screen (ADR-0117, over KasmVNC): the view opened over the socket and its display streamed
// to noVNC over one WebSocket.
const VIEW = 'a'.repeat(32);
const LOCATION = { protocol: 'https:', host: 'local.example' };

// noVNC's client as watchBrowser drives it: it records how it was made and set, and the test says when it connects or
// disconnects.
function fakeRFB() {
  const made = [];
  class RFB extends EventTarget {
    constructor(target, url, options) {
      super();
      this.target = target;
      this.url = url;
      this.options = options;
      this.disconnected = 0;
      made.push(this);
    }

    disconnect() {
      this.disconnected += 1;
      this.dispatchEvent(new Event('disconnect'));
    }
  }
  return { RFB, made };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a view opens only for the exact running task Admin names', async () => {
  const opened = recorder(200, { view_id: VIEW });
  assert.equal(await openBrowserView('team_1', opened.call), VIEW);
  assert.deepEqual(opened.calls, [{ method: 'browser.view', params: { team_id: 'team_1' } }]);
  await assert.rejects(
    openBrowserView('team_1', recorder(404, { detail: 'x', code: 'browser-not-running' }).call),
    BrowserViewEndedError,
  );
  for (const [status, body] of [
    [200, { view_id: VIEW.toUpperCase() }],
    [200, { view_id: VIEW, extra: 1 }],
    [404, { code: 'team-not-found' }],
    [503, { code: 'browser-view-busy' }],
  ]) {
    await assert.rejects(openBrowserView('team_1', recorder(status, body).call), (error) => (
      !(error instanceof BrowserViewEndedError) && /unavailable/.test(error.message)
    ));
  }
  const untouched = recorder(200, { view_id: VIEW });
  await assert.rejects(openBrowserView('', untouched.call), /invalid/);
  assert.deepEqual(untouched.calls, []);
});

test('the stream is on the page\'s own origin, secure when the page is', () => {
  assert.equal(streamUrl('team_1', VIEW, LOCATION), `wss://local.example/api/teams/team_1/browser/views/${VIEW}/stream`);
  assert.equal(
    streamUrl('team_1', VIEW, { protocol: 'http:', host: '127.0.0.1:5173' }),
    `ws://127.0.0.1:5173/api/teams/team_1/browser/views/${VIEW}/stream`,
  );
});

test('watching draws the display view-only on the target and ends with the task', async () => {
  const { RFB, made } = fakeRFB();
  const target = {};
  let connected = 0;
  const answers = [[200, { view_id: VIEW }], [404, { code: 'browser-not-running' }]];
  const asked = [];
  const call = async (method, params) => {
    asked.push(method);
    const [status, body] = answers.shift();
    return recorder(status, body).call(method, params);
  };
  const watching = watchBrowser('team_1', {
    signal: new AbortController().signal, target, RFB, call, location: LOCATION, onconnect: () => { connected += 1; },
  });
  await settled();
  assert.equal(made.length, 1);
  const [rfb] = made;
  assert.equal(rfb.target, target);
  assert.equal(rfb.url, streamUrl('team_1', VIEW, LOCATION));
  assert.deepEqual(rfb.options, { wsProtocols: ['binary'] });
  assert.equal(rfb.viewOnly, true);
  assert.equal(rfb.focusOnClick, false);
  assert.equal(rfb.resizeSession, false);
  assert.equal(rfb.scaleViewport, true);
  rfb.dispatchEvent(new Event('connect'));
  assert.equal(connected, 1);
  // The stream ended and the task's view is gone: the task ended.
  rfb.dispatchEvent(new Event('disconnect'));
  await assert.rejects(watching, BrowserViewEndedError);
  assert.deepEqual(asked, ['browser.view', 'browser.view']);
});

test('a stream that ends while the task still runs is unavailable, not a task that ended', async () => {
  const { RFB, made } = fakeRFB();
  const watching = watchBrowser('team_1', {
    signal: new AbortController().signal, target: {}, RFB, call: recorder(200, { view_id: VIEW }).call, location: LOCATION,
  });
  await settled();
  made[0].dispatchEvent(new Event('disconnect'));
  await assert.rejects(watching, (error) => !(error instanceof BrowserViewEndedError) && /unavailable/.test(error.message));
});

test('the check after a stream ended still settles when the view closes, and in time when unanswered', async (t) => {
  const { RFB, made } = fakeRFB();
  let first = true;
  const call = async (method, params) => {
    if (first) {
      first = false;
      return recorder(200, { view_id: VIEW }).call(method, params);
    }
    return new Promise(() => {});
  };
  const closing = new AbortController();
  const closed = watchBrowser('team_1', { signal: closing.signal, target: {}, RFB, call, location: LOCATION });
  await settled();
  made[0].dispatchEvent(new Event('disconnect'));
  closing.abort(new Error('closed during the check'));
  await assert.rejects(closed, /closed during the check/);
  assert.equal(made[0].disconnected, 0);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  first = true;
  const waiting = watchBrowser('team_1', {
    signal: new AbortController().signal, target: {}, RFB, call, location: LOCATION,
  });
  await settled();
  made[1].dispatchEvent(new Event('disconnect'));
  const outcome = assert.rejects(waiting, (error) => !(error instanceof BrowserViewEndedError));
  await settled();
  t.mock.timers.tick(10_000);
  await outcome;
});

test('closing the view disconnects the stream at once and asks for nothing more', async () => {
  const { RFB, made } = fakeRFB();
  const opened = recorder(200, { view_id: VIEW });
  const controller = new AbortController();
  const watching = watchBrowser('team_1', { signal: controller.signal, target: {}, RFB, call: opened.call, location: LOCATION });
  await settled();
  controller.abort(new Error('closed'));
  await assert.rejects(watching, /closed/);
  assert.equal(made[0].disconnected, 1);
  await settled();
  assert.equal(opened.calls.length, 1);
  const closed = new AbortController();
  closed.abort(new Error('closed before'));
  const untouched = recorder(200, { view_id: VIEW });
  await assert.rejects(
    watchBrowser('team_1', { signal: closed.signal, target: {}, RFB, call: untouched.call, location: LOCATION }),
    /closed before/,
  );
  assert.deepEqual(untouched.calls, []);
  assert.equal(made.length, 1);
});

test('a view asked for before Team holds the Browser is asked for again until it opens', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const answers = [[404, { code: 'browser-not-running' }], [404, { code: 'browser-not-running' }], [200, { view_id: VIEW }]];
  const asked = [];
  const call = async (method, params) => {
    asked.push(method);
    const [status, body] = answers.shift();
    return recorder(status, body).call(method, params);
  };
  const { RFB, made } = fakeRFB();
  const controller = new AbortController();
  const watching = watchBrowser('team_1', { signal: controller.signal, target: {}, RFB, call, location: LOCATION });
  const outcome = assert.rejects(watching, /seen/);
  for (let tick = 0; tick < 4; tick += 1) {
    await settled();
    t.mock.timers.tick(500);
  }
  assert.equal(made.length, 1);
  controller.abort(new Error('seen'));
  await outcome;
  assert.deepEqual(asked, ['browser.view', 'browser.view', 'browser.view']);
});

test('a view whose opening Admin never answers stops at once when closed, and is unavailable in time', async (t) => {
  const { RFB, made } = fakeRFB();
  const closing = new AbortController();
  const silent = async () => new Promise(() => {});
  const closed = watchBrowser('team_1', { signal: closing.signal, target: {}, RFB, call: silent, location: LOCATION });
  closing.abort(new Error('closed while opening'));
  await assert.rejects(closed, /closed while opening/);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const waiting = watchBrowser('team_1', {
    signal: new AbortController().signal, target: {}, RFB, call: silent, location: LOCATION,
  });
  const outcome = assert.rejects(waiting, (error) => !(error instanceof BrowserViewEndedError) && /did not open/.test(error.message));
  await settled();
  t.mock.timers.tick(60_000);
  await outcome;
  assert.equal(made.length, 0);
});

test('a view that never opens is unavailable, not a task that ended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { RFB, made } = fakeRFB();
  const watching = watchBrowser('team_1', {
    signal: new AbortController().signal, target: {}, RFB, call: recorder(404, { code: 'browser-not-running' }).call,
    location: LOCATION,
  });
  const outcome = assert.rejects(watching, (error) => !(error instanceof BrowserViewEndedError) && /did not open/.test(error.message));
  for (let tick = 0; tick < 130; tick += 1) {
    await settled();
    t.mock.timers.tick(500);
  }
  await outcome;
  assert.equal(made.length, 0);
});

test('closing the view during a pause between asks stops at once', async () => {
  const { RFB, made } = fakeRFB();
  const controller = new AbortController();
  const watching = watchBrowser('team_1', {
    signal: controller.signal, target: {}, RFB, call: recorder(404, { code: 'browser-not-running' }).call, location: LOCATION,
  });
  setTimeout(() => controller.abort(new Error('closed')), 10);
  await assert.rejects(watching, /closed/);
  assert.equal(made.length, 0);
});
