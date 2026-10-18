import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserViewEndedError,
  fetchBrowserFrame,
  openBrowserView,
  watchBrowser,
} from '../src/lib/chat/browser/view.js';
import { recorder } from './socketStub.js';

// Watching a Browser task's screen (ADR-0117, M2 Watch): the view opened over the socket and its frames over HTTP.
const VIEW = 'a'.repeat(32);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

function frame(number, { type = 'image/png', body = PNG } = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': type, 'x-shimpz-browser-frame': String(number) } });
}

function refusal(status, code) {
  return new Response(JSON.stringify({ detail: 'browser view unavailable', code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

test('a frame is admitted only newer, numbered, and a bounded PNG', async () => {
  const asked = [];
  const fetcher = async (url, options) => {
    asked.push({ url, options });
    return frame(3);
  };
  const answer = await fetchBrowserFrame('team_1', VIEW, 2, undefined, fetcher);
  assert.equal(answer.number, 3);
  assert.equal(answer.blob.size, PNG.length);
  assert.deepEqual(asked, [{
    url: `/api/teams/team_1/browser/views/${VIEW}/frames/2`,
    options: { signal: undefined, cache: 'no-store', credentials: 'same-origin' },
  }]);
  assert.equal(await fetchBrowserFrame('team_1', VIEW, 0, undefined, async () => new Response(null, { status: 204 })), null);
  assert.equal(await fetchBrowserFrame('team_1', VIEW, 0, undefined, async () => refusal(503, 'browser-view-busy')), 'busy');
  await assert.rejects(
    fetchBrowserFrame('team_1', VIEW, 0, undefined, async () => refusal(404, 'browser-not-running')),
    BrowserViewEndedError,
  );
  for (const answered of [
    () => frame(2),
    () => frame('03'),
    () => frame(2 ** 31),
    () => frame(3, { type: 'image/jpeg' }),
    () => frame(3, { body: new Uint8Array() }),
    () => frame(3, { body: new Uint8Array(4 * 1024 * 1024 + 1) }),
    () => refusal(503, 'browser-view-unavailable'),
    () => refusal(404, 'team-not-found'),
    () => new Response('denied', { status: 403 }),
  ]) {
    await assert.rejects(fetchBrowserFrame('team_1', VIEW, 2, undefined, async () => answered()), (error) => (
      !(error instanceof BrowserViewEndedError)
    ));
  }
});

test('watching shows each newer frame, waits out a busy view, and ends with the task', async () => {
  const answers = [frame(1), new Response(null, { status: 204 }), refusal(503, 'browser-view-busy'), frame(2),
    refusal(404, 'browser-not-running')];
  const cursors = [];
  const shown = [];
  await assert.rejects(watchBrowser('team_1', {
    signal: new AbortController().signal,
    onframe: (blob) => shown.push(blob.size),
    call: recorder(200, { view_id: VIEW }).call,
    fetcher: async (url) => {
      cursors.push(Number(url.split('/').at(-1)));
      return answers.shift();
    },
  }), BrowserViewEndedError);
  assert.deepEqual(cursors, [0, 1, 1, 1, 2]);
  assert.deepEqual(shown, [PNG.length, PNG.length]);
});

test('closing the view stops watching at once, even during a pause', async () => {
  const controller = new AbortController();
  const watching = watchBrowser('team_1', {
    signal: controller.signal,
    onframe: () => assert.fail('no frame came'),
    call: recorder(200, { view_id: VIEW }).call,
    fetcher: async () => refusal(503, 'browser-view-busy'),
  });
  setTimeout(() => controller.abort(new Error('closed')), 10);
  await assert.rejects(watching, /closed/);
  const closed = new AbortController();
  closed.abort(new Error('closed before'));
  await assert.rejects(watchBrowser('team_1', {
    signal: closed.signal,
    onframe: () => assert.fail('no frame came'),
    call: recorder(200, { view_id: VIEW }).call,
    fetcher: async () => assert.fail('nothing is asked once closed'),
  }), /closed before/);
});
