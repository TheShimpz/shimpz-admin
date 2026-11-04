import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserViewEndedError,
  controlBrowser,
  openBrowserView,
  streamUrl,
  watchBrowser,
} from '../src/lib/chat/browser/view.js';
import { recorder } from './socketStub.js';

// Watching a Browser task's screen (ADR-0117, ADR-0126): the view opened over the socket and its stream handed to
// easi.run's viewer.
const VIEW = 'a'.repeat(32);
const LOCATION = { protocol: 'https:', host: 'local.example' };

// easi.run's viewer as watchBrowser drives it: it records how it was mounted, and the test says when its stream ends.
function fakeViewer() {
  const made = [];
  const sdk = {
    LeaseHolder: { You: 2 },
    mountViewer(target, options) {
      const viewer = {
        target,
        options,
        closed: 0,
        controls: [],
        setControl(enabled) { viewer.controls.push(enabled); },
        close() { viewer.closed += 1; },
      };
      made.push(viewer);
      return viewer;
    },
  };
  return { load: async () => sdk, made };
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

test('watching draws the screen with no control on the target and ends with the task', async () => {
  const { load, made } = fakeViewer();
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
    signal: new AbortController().signal, target, load, call, location: LOCATION, onconnect: () => { connected += 1; },
  });
  await settled();
  assert.equal(made.length, 1);
  const [viewer] = made;
  assert.equal(viewer.target, target);
  assert.equal(viewer.options.url, streamUrl('team_1', VIEW, LOCATION));
  assert.equal(viewer.options.features.keyboard_pointer, false);
  // Whoever watches never asks for control, even when it is offered.
  viewer.options.onLease({ holder: 2 });
  assert.deepEqual(viewer.controls, []);
  viewer.options.onPicture();
  assert.equal(connected, 1);
  // An error the viewer recovered from ends nothing.
  viewer.options.onError(new Error('recovered'), false);
  // The stream ended and the task's view is gone: the task ended.
  viewer.options.onError(new Error('ended'), true);
  await assert.rejects(watching, BrowserViewEndedError);
  assert.deepEqual(asked, ['browser.view', 'browser.view']);
});

test('a stream that ends while the task still runs is unavailable, not a task that ended', async () => {
  const { load, made } = fakeViewer();
  const watching = watchBrowser('team_1', {
    signal: new AbortController().signal, target: {}, load, call: recorder(200, { view_id: VIEW }).call, location: LOCATION,
  });
  await settled();
  made[0].options.onError(new Error('ended'), true);
  await assert.rejects(watching, (error) => !(error instanceof BrowserViewEndedError) && /unavailable/.test(error.message));
});

test('the check after a stream ended still settles when the view closes, and in time when unanswered', async (t) => {
  const { load, made } = fakeViewer();
  let first = true;
  const call = async (method, params) => {
    if (first) {
      first = false;
      return recorder(200, { view_id: VIEW }).call(method, params);
    }
    return new Promise(() => {});
  };
  const closing = new AbortController();
  const closed = watchBrowser('team_1', { signal: closing.signal, target: {}, load, call, location: LOCATION });
  await settled();
  made[0].options.onError(new Error('ended'), true);
  closing.abort(new Error('closed during the check'));
  await assert.rejects(closed, /closed during the check/);
  assert.equal(made[0].closed, 1);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  first = true;
  const waiting = watchBrowser('team_1', {
    signal: new AbortController().signal, target: {}, load, call, location: LOCATION,
  });
  await settled();
  made[1].options.onError(new Error('ended'), true);
  const outcome = assert.rejects(waiting, (error) => !(error instanceof BrowserViewEndedError));
  await settled();
  t.mock.timers.tick(10_000);
  await outcome;
});

test('closing the view closes the stream at once and asks for nothing more', async () => {
  const { load, made } = fakeViewer();
  const opened = recorder(200, { view_id: VIEW });
  const controller = new AbortController();
  const watching = watchBrowser('team_1', { signal: controller.signal, target: {}, load, call: opened.call, location: LOCATION });
  await settled();
  controller.abort(new Error('closed'));
  await assert.rejects(watching, /closed/);
  assert.equal(made[0].closed, 1);
  await settled();
  assert.equal(opened.calls.length, 1);
  const closed = new AbortController();
  closed.abort(new Error('closed before'));
  const untouched = recorder(200, { view_id: VIEW });
  await assert.rejects(
    watchBrowser('team_1', { signal: closed.signal, target: {}, load, call: untouched.call, location: LOCATION }),
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
  const { load, made } = fakeViewer();
  const controller = new AbortController();
  const watching = watchBrowser('team_1', { signal: controller.signal, target: {}, load, call, location: LOCATION });
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
  const { load, made } = fakeViewer();
  const closing = new AbortController();
  const silent = async () => new Promise(() => {});
  const closed = watchBrowser('team_1', { signal: closing.signal, target: {}, load, call: silent, location: LOCATION });
  closing.abort(new Error('closed while opening'));
  await assert.rejects(closed, /closed while opening/);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const waiting = watchBrowser('team_1', {
    signal: new AbortController().signal, target: {}, load, call: silent, location: LOCATION,
  });
  const outcome = assert.rejects(waiting, (error) => !(error instanceof BrowserViewEndedError) && /did not open/.test(error.message));
  await settled();
  t.mock.timers.tick(60_000);
  await outcome;
  assert.equal(made.length, 0);
});

test('a view that never opens is unavailable, not a task that ended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { load, made } = fakeViewer();
  const watching = watchBrowser('team_1', {
    signal: new AbortController().signal, target: {}, load, call: recorder(404, { code: 'browser-not-running' }).call,
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
  const { load, made } = fakeViewer();
  const controller = new AbortController();
  const watching = watchBrowser('team_1', {
    signal: controller.signal, target: {}, load, call: recorder(404, { code: 'browser-not-running' }).call, location: LOCATION,
  });
  setTimeout(() => controller.abort(new Error('closed')), 10);
  await assert.rejects(watching, /closed/);
  assert.equal(made.length, 0);
});

test('driving asks for control only while the far end grants it, and ends with the stream', async () => {
  const { load, made } = fakeViewer();
  const closing = new AbortController();
  const driving = controlBrowser('team_1', VIEW, { signal: closing.signal, target: {}, load, location: LOCATION });
  await settled();
  const [viewer] = made;
  assert.equal(viewer.options.url, streamUrl('team_1', VIEW, LOCATION, 'control'));
  assert.equal(viewer.options.features.keyboard_pointer, true);
  assert.equal(viewer.options.features.downloads, false);
  viewer.options.onLease({ holder: 2 });
  viewer.options.onLease({ holder: 1 });
  assert.deepEqual(viewer.controls, [true, false]);
  viewer.options.onError(new Error('ended'), true);
  await assert.rejects(driving, BrowserViewEndedError);
  await assert.rejects(controlBrowser('bad id', VIEW, { signal: closing.signal, target: {}, load }), /invalid/);
});
