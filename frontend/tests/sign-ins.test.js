import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginSignInDeletion,
  cancelSignIn,
  deleteSignIn,
  readSignIn,
  saveSignIn,
  startSignIn,
  startUrl,
  teamSignIn,
} from '../src/lib/chat/browser/signIns.js';
import { BrowserViewEndedError, controlBrowser, streamUrl } from '../src/lib/chat/browser/view.js';
import { socketReads } from '../src/lib/session/socket.js';
import { recorder, response } from './socketStub.js';

// A Team's browser session (ADR-0117, 2026-10-20 amendment): the exact answers the page admits, the refusals it keeps
// the code of, its confirmed deletion, and the driven Browser of a sign-in session.
const SESSION = 'a'.repeat(32);
const VIEW = 'b'.repeat(32);
const LOCATION = { protocol: 'https:', host: 'local.example' };
const SIGN_IN = {
  sign_in_id: 'c'.repeat(32),
  state: 'ready',
  generation: 2,
  team_incarnation: 'd'.repeat(64),
  sites: ['example.org', 'mail.example.com'],
  sites_truncated: false,
  created_at: '2026-10-19T10:00:00Z',
  saved_at: '2026-10-19T10:00:00Z',
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

test('the session read admits only its exact form, or none', async () => {
  const read = recorder(200, { sign_in: SIGN_IN });
  assert.deepEqual(await readSignIn('team_1', read.call), SIGN_IN);
  assert.deepEqual(read.calls, [{ method: 'sign_in.read', params: { team_id: 'team_1' } }]);
  assert.equal(await readSignIn('team_1', recorder(200, { sign_in: null }).call), null);
  for (const body of [
    {},
    { sign_in: { ...SIGN_IN, capsule: 'x' } },
    { sign_in: { ...SIGN_IN, state: 'checked-out' } },
    { sign_in: { ...SIGN_IN, generation: 0 } },
    { sign_in: { ...SIGN_IN, sites: ['mail.example.com', 'example.org'] } },
    { sign_in: { ...SIGN_IN, sites: ['Example.org'] } },
    { sign_in: { ...SIGN_IN, team_incarnation: 'd'.repeat(63) } },
    { sign_in: { ...SIGN_IN, expires_at: SIGN_IN.saved_at } },
    { sign_in: { ...SIGN_IN, last_used_at: '2026-10-18T10:00:00Z' } },
    { sign_in: { ...SIGN_IN, sites_truncated: 0 } },
    { sign_in: SIGN_IN, trace_id: 'f'.repeat(32) },
  ]) {
    await assert.rejects(readSignIn('team_1', recorder(200, body).call), /invalid/);
  }
  await assert.rejects(readSignIn('team_1', recorder(503, { code: 'sign-ins-unavailable' }).call), (error) => (
    error.status === 503 && error.code === 'sign-ins-unavailable'
  ));
  assert.throws(() => teamSignIn('Team 1'), /invalid/);
});

test('the session is read once its topic is watched, and again when Admin says it changed', async () => {
  const listeners = new Set();
  socketReads.watch = (topic, listener) => {
    assert.equal(topic, 'team/team_1/sign-in');
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let reads = 0;
  socketReads.call = async (method, params) => {
    reads += 1;
    assert.deepEqual([method, params], ['sign_in.read', { team_id: 'team_1' }]);
    return response(200, { sign_in: reads === 1 ? null : SIGN_IN });
  };
  const seen = [];
  const stop = teamSignIn('team_1').subscribe((state) => seen.push(state));
  const announce = (cause, revision) => {
    for (const listener of [...listeners]) listener('team/team_1/sign-in', cause, { epoch: 'a'.repeat(32), revision });
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  announce('open', 1);
  await flush();
  assert.equal(seen.at(-1).value, null);
  announce('changed', 2);
  await flush();
  assert.deepEqual(seen.at(-1).value, SIGN_IN);
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
  await assert.rejects(startSignIn('team_1', 'x.example', 'en', recorder(409, { code: 'sign-in-busy' }).call), (error) => (
    error.status === 409 && error.code === 'sign-in-busy'
  ));
  await assert.rejects(startSignIn('team_1', 'x.example', 'en', recorder(200, { view_id: VIEW }).call), /invalid/);
});

test('save and cancel send the session alone, and answer exactly', async () => {
  const saved = recorder(200, { sign_in: SIGN_IN, recorded: false });
  assert.deepEqual(await saveSignIn('team_1', SESSION, saved.call), { signIn: SIGN_IN, recorded: false });
  assert.deepEqual(saved.calls[0].params, { team_id: 'team_1', body: { sign_in_session_id: SESSION } });
  await assert.rejects(saveSignIn('team_1', SESSION, recorder(200, { sign_in: SIGN_IN }).call), /invalid/);
  await assert.rejects(saveSignIn('team_1', SESSION, recorder(200, { sign_in: { ...SIGN_IN, state: 'x' }, recorded: true }).call), /invalid/);
  await assert.rejects(
    saveSignIn('team_1', SESSION, recorder(409, { detail: 'x', code: 'sign-in-identity-provider' }).call),
    (error) => error.status === 409 && error.code === 'sign-in-identity-provider',
  );
  const cancelled = recorder(200, { cancelled: true });
  assert.equal(await cancelSignIn('team_1', SESSION, cancelled.call), true);
  assert.deepEqual(cancelled.calls[0].params, { team_id: 'team_1', body: { sign_in_session_id: SESSION } });
  await assert.rejects(cancelSignIn('team_1', SESSION, recorder(200, { cancelled: false }).call), /invalid/);
});

test('deleting starts with the password and spends one second factor on exactly the session shown', async () => {
  const begun = recorder(202, { methods: ['totp'] });
  assert.deepEqual(await beginSignInDeletion('team_1', 'secret words', begun.call), { passkey: null });
  assert.deepEqual(begun.calls[0], { method: 'sign_in.deletion', params: { team_id: 'team_1', body: { password: 'secret words' } } });
  await assert.rejects(beginSignInDeletion('team_1', '', recorder(202, {}).call), /required/);
  await assert.rejects(beginSignInDeletion('team_1', 'x', recorder(202, { methods: ['sms'] }).call), /invalid/);
  await assert.rejects(beginSignInDeletion('team_1', 'x', recorder(401, { code: 'password-incorrect' }).call), (error) => (
    error.code === 'password-incorrect'
  ));
  const deleted = recorder(200, { deletion: 'pending' });
  assert.equal(await deleteSignIn('team_1', SIGN_IN, { code: '123456' }, deleted.call), 'pending');
  assert.deepEqual(deleted.calls[0], {
    method: 'sign_in.delete',
    params: {
      team_id: 'team_1', sign_in_id: SIGN_IN.sign_in_id, generation: '2', team_incarnation: SIGN_IN.team_incarnation,
      body: { code: '123456' },
    },
  });
  await assert.rejects(deleteSignIn('team_1', SIGN_IN, { code: '12' }, recorder(200, {}).call), /invalid/);
  await assert.rejects(deleteSignIn('team_1', { ...SIGN_IN, generation: 0 }, { code: '123456' }, recorder(200, {}).call), /invalid/);
  await assert.rejects(deleteSignIn('team_1', SIGN_IN, { code: '123456' }, recorder(200, { deletion: 'gone' }).call), /invalid/);
  await assert.rejects(deleteSignIn('team_1', SIGN_IN, { code: '123456' }, recorder(409, { code: 'sign-in-changed' }).call), (error) => (
    error.code === 'sign-in-changed'
  ));
});

// noVNC's client as controlBrowser drives it.
class RFB extends EventTarget {
  static made = [];

  static messages = {};

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
  // The person's pointer reaches KasmVNC in its own 11-byte form: type, 16-bit mask, position, and two scroll deltas.
  const pushed = [];
  const sock = {
    sQpush8: (value) => pushed.push(['8', value]),
    sQpush16: (value) => pushed.push(['16', value]),
    flush: () => pushed.push(['flush']),
  };
  RFB.messages.pointerEvent(sock, 640, 400, 0x101);
  assert.deepEqual(pushed, [['8', 5], ['16', 0x101], ['16', 640], ['16', 400], ['16', 0], ['16', 0], ['flush']]);
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
