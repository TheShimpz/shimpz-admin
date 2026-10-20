import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancelSignIn,
  canonicalLabel,
  forgetSignIn,
  listSignIns,
  saveSignIn,
  startSignIn,
  startUrl,
  teamSignIns,
} from '../src/lib/chat/browser/signIns.js';
import { BrowserViewEndedError, controlBrowser, streamUrl } from '../src/lib/chat/browser/view.js';
import { socketReads } from '../src/lib/session/socket.js';
import { recorder, response } from './socketStub.js';

// A Team's Sign-ins (ADR-0117, Sign-ins amendment): the exact answers the page admits, the refusals it keeps the code
// of, and the driven Browser of a sign-in session.
const SESSION = 'a'.repeat(32);
const VIEW = 'b'.repeat(32);
const LOCATION = { protocol: 'https:', host: 'local.example' };
const SIGN_IN = {
  sign_in_id: 'c'.repeat(32),
  site: 'mail.example.com',
  label: 'Work',
  created_at: '2026-10-19T10:00:00Z',
  last_used_at: '2026-10-19T10:00:00Z',
  expires_at: '2026-11-18T10:00:00Z',
};

test('a typed address becomes the https URL Admin is asked for, and anything else is none', () => {
  assert.equal(startUrl('  mail.example.com '), 'https://mail.example.com');
  assert.equal(startUrl('https://mail.example.com/login?next=1'), 'https://mail.example.com/login?next=1');
  for (const typed of [
    '', 'http://mail.example.com', 'ftp://example.com', 'https://user:pw@example.com', 'https://localhost',
    'https://exa mple.com', 'https://', `https://example.com/${'a'.repeat(2048)}`, 42,
  ]) {
    assert.equal(startUrl(typed), '', String(typed).slice(0, 40));
  }
});

test('a label is kept trimmed, printable, and at most 64 characters', () => {
  assert.equal(canonicalLabel('  Work '), 'Work');
  for (const label of ['', '   ', 'a\nb', 'x'.repeat(65), null]) assert.equal(canonicalLabel(label), '');
});

test('the list admits only exact, unique Sign-ins', async () => {
  const listed = recorder(200, { sign_ins: [SIGN_IN] });
  assert.deepEqual(await listSignIns('team_1', listed.call), [SIGN_IN]);
  assert.deepEqual(listed.calls, [{ method: 'sign_ins.list', params: { team_id: 'team_1' } }]);
  for (const body of [
    { sign_ins: [SIGN_IN, SIGN_IN] },
    { sign_ins: [{ ...SIGN_IN, capsule: 'x' }] },
    { sign_ins: [{ ...SIGN_IN, site: 'Mail.Example.com' }] },
    { sign_ins: [{ ...SIGN_IN, label: ' Work' }] },
    { sign_ins: [{ ...SIGN_IN, expires_at: SIGN_IN.created_at }] },
    { sign_ins: [{ ...SIGN_IN, created_at: '2026-10-19 10:00:00' }] },
    { sign_ins: Array.from({ length: 17 }, (_, index) => ({ ...SIGN_IN, sign_in_id: index.toString(16).padStart(32, '0') })) },
    { sign_ins: [], trace_id: 'f'.repeat(32) },
    { sign_ins: {} },
  ]) {
    await assert.rejects(listSignIns('team_1', recorder(200, body).call), /invalid/);
  }
  await assert.rejects(listSignIns('team_1', recorder(503, { code: 'sign-ins-unavailable' }).call), (error) => (
    error.status === 503 && error.code === 'sign-ins-unavailable'
  ));
  assert.throws(() => teamSignIns('Team 1'), /invalid/);
});

test('a Team\'s Sign-ins are read once its topic is watched, and again when Admin says they changed', async () => {
  const listeners = new Set();
  socketReads.watch = (topic, listener) => {
    assert.equal(topic, 'team/team_1/sign-ins');
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let reads = 0;
  socketReads.call = async (method, params) => {
    reads += 1;
    assert.deepEqual([method, params], ['sign_ins.list', { team_id: 'team_1' }]);
    return response(200, { sign_ins: reads === 1 ? [] : [SIGN_IN] });
  };
  const seen = [];
  const stop = teamSignIns('team_1').subscribe((state) => seen.push(state));
  const announce = (cause, revision) => {
    for (const listener of [...listeners]) listener('team/team_1/sign-ins', cause, { epoch: 'a'.repeat(32), revision });
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  announce('open', 1);
  await flush();
  assert.deepEqual(seen.at(-1).value, []);
  announce('changed', 2);
  await flush();
  assert.deepEqual(seen.at(-1).value, [SIGN_IN]);
  stop();
});

test('a session starts at the typed address and answers its id, view, and site', async () => {
  const started = recorder(200, { sign_in_session_id: SESSION, view_id: VIEW, site: 'mail.example.com' });
  assert.deepEqual(await startSignIn('team_1', 'mail.example.com', 'pt', started.call), {
    sessionId: SESSION, viewId: VIEW, site: 'mail.example.com',
  });
  assert.deepEqual(started.calls, [{
    method: 'sign_in.start', params: { team_id: 'team_1', body: { url: 'https://mail.example.com', locale: 'pt' } },
  }]);
  const untouched = recorder(200, {});
  await assert.rejects(startSignIn('team_1', 'http://x.example', 'en', untouched.call), (error) => (
    error.code === 'sign-in-url-invalid'
  ));
  assert.deepEqual(untouched.calls, []);
  await assert.rejects(startSignIn('team_1', 'x.example', 'en', recorder(409, { code: 'browser-busy' }).call), (error) => (
    error.status === 409 && error.code === 'browser-busy'
  ));
  await assert.rejects(startSignIn('team_1', 'x.example', 'en', recorder(200, { view_id: VIEW }).call), /invalid/);
});

test('save sends the kept label, cancel and forget their exact bodies', async () => {
  const saved = recorder(200, SIGN_IN);
  assert.deepEqual(await saveSignIn('team_1', SESSION, ' Work ', saved.call), SIGN_IN);
  assert.deepEqual(saved.calls[0].params, { team_id: 'team_1', body: { sign_in_session_id: SESSION, label: 'Work' } });
  await assert.rejects(saveSignIn('team_1', SESSION, ' ', recorder(200, SIGN_IN).call), (error) => (
    error.code === 'sign-in-label-invalid'
  ));
  await assert.rejects(
    saveSignIn('team_1', SESSION, 'Work', recorder(409, { detail: 'x', code: 'sign-in-identity-provider' }).call),
    (error) => error.status === 409 && error.code === 'sign-in-identity-provider',
  );
  const cancelled = recorder(200, { cancelled: true });
  assert.equal(await cancelSignIn('team_1', SESSION, cancelled.call), true);
  assert.deepEqual(cancelled.calls[0].params, { team_id: 'team_1', body: { sign_in_session_id: SESSION } });
  await assert.rejects(cancelSignIn('team_1', SESSION, recorder(200, { cancelled: false }).call), /invalid/);
  const forgotten = recorder(200, { forgotten: false });
  assert.equal(await forgetSignIn('team_1', SIGN_IN.sign_in_id, forgotten.call), false);
  assert.deepEqual(forgotten.calls[0].params, { team_id: 'team_1', body: { sign_in_id: SIGN_IN.sign_in_id } });
  await assert.rejects(forgetSignIn('team_1', SIGN_IN.sign_in_id, recorder(200, { forgotten: 1 }).call), /invalid/);
  await assert.rejects(forgetSignIn('team_1', SIGN_IN.sign_in_id, recorder(503, {}).call), (error) => error.status === 503);
});

// noVNC's client as controlBrowser drives it.
class RFB extends EventTarget {
  static made = [];

  constructor(target, url, options) {
    super();
    Object.assign(this, { target, url, options, focused: 0, disconnected: 0 });
    RFB.made.push(this);
  }

  focus() {
    this.focused += 1;
  }

  disconnect() {
    this.disconnected += 1;
    this.dispatchEvent(new Event('disconnect'));
  }
}

test('a sign-in session\'s Browser is driven over its control stream until it ends', async () => {
  let connected = 0;
  const driving = controlBrowser('team_1', VIEW, {
    signal: new AbortController().signal, target: {}, RFB, location: LOCATION, onconnect: () => { connected += 1; },
  });
  const rfb = RFB.made.at(-1);
  assert.equal(rfb.url, streamUrl('team_1', VIEW, LOCATION, 'control'));
  assert.match(rfb.url, /\/browser\/views\/b{32}\/control$/);
  assert.equal(rfb.viewOnly, false);
  assert.equal(rfb.focusOnClick, true);
  rfb.dispatchEvent(new Event('connect'));
  assert.deepEqual([connected, rfb.focused], [1, 1]);
  rfb.dispatchEvent(new Event('disconnect'));
  await assert.rejects(driving, BrowserViewEndedError);
  // Without an `onconnect`, the screen still shows and takes the person's keys.
  const quiet = controlBrowser('team_1', VIEW, { signal: new AbortController().signal, target: {}, RFB, location: LOCATION });
  await Promise.resolve();
  RFB.made.at(-1).dispatchEvent(new Event('connect'));
  assert.equal(RFB.made.at(-1).focused, 1);
  RFB.made.at(-1).dispatchEvent(new Event('disconnect'));
  await assert.rejects(quiet, BrowserViewEndedError);

  const closing = new AbortController();
  const closed = controlBrowser('team_1', VIEW, { signal: closing.signal, target: {}, RFB, location: LOCATION });
  closing.abort(new Error('closed'));
  await assert.rejects(closed, /closed/);
  assert.equal(RFB.made.at(-1).disconnected, 1);
  await assert.rejects(controlBrowser('team_1', 'x', { signal: closing.signal, target: {}, RFB }), /invalid/);
});
