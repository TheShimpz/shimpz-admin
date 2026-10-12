// The Admin session socket (ADR-0114): one connection per tab, owned by the Admin shell, carrying every bounded read,
// every invalidation, and each attached Team's chat channel. Admin re-checks the page's Origin and session before each
// frame. While the socket reconnects, the last state stays readable, a read waits for the socket and runs once it is
// back, and a change is never queued: it stays disabled. Every subscribed topic is read again when the socket reopens,
// and the socket never stops reconnecting while the session lasts.
import { derived, writable } from 'svelte/store';

import { LocalApiError } from './validate.js';

// The protocol's own bounds (backend/protocol/socket/v1/frames.py), pinned by the Admin parity test.
export const ADMIN_SOCKET_PROTOCOL = 'shimpz.admin.v1';
export const ADMIN_SOCKET_PATH = '/api/session/ws';
const MAX_INBOUND_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 16;
const MAX_SUBSCRIPTIONS = 64;
const MAX_ATTACHED_TEAMS = 4;
const EPOCH_RE = /^[0-9a-f]{32}$/;
const CALL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOPIC_RE = /^(?:teams|space\/resources|platform\/release|security\/summary|session|assistants\/registry|local-assistants|team\/[a-z0-9_]{1,40}\/(?:routines|history|inventory|inference))$/;
const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
// The chat-channel frames a client sends; every one carries its Team's `team_id`.
const CHAT_CLIENT_TYPES = new Set(['chat', 'resume-task', 'stop', 'sync', 'human-response']);
// The `shimpz.chat.v7` server frames whose own shape names their Team; on every other frame `team_id` is the channel's.
const NATIVE_TEAM_FRAMES = new Set(['done', 'assistant-install-plan', 'assistant-guidance']);
const NATIVE_UNINSTALL_STATES = new Set(['proposed', 'uninstalled']);
// A dropped socket reconnects for as long as the session lasts, with a jittered exponential backoff from 0.4 s up to
// 30 s, and at once when the browser comes online or the tab becomes visible; only a connection that stayed open
// restores the backoff. Past the time a Local release swap takes, the shell says Admin cannot be reached (`failed`).
export const RECONNECT_WINDOW_MS = 150_000;
const FIRST_RECONNECT_DELAY_MS = 400;
const MAX_RECONNECT_DELAY_MS = 30_000;
const STABLE_CONNECTION_MS = 10_000;
const SESSION_PROBE_TIMEOUT_MS = 5_000;
const SIGNED_OUT = 4401;

/**
 * `phase` is `idle` (signed out or not started), `connecting` (the first open), `open`, `reconnecting` (the last
 * state stays on screen and changes are disabled), or `failed` (Admin has been unreachable for long; reconnecting
 * goes on). `offline` says the browser itself has no network.
 */
export const adminSocket = writable({ phase: 'idle', offline: false });

/** Whether a change may be offered now: only while the socket is open, since a change is never queued. */
export const commandsReady = derived(adminSocket, ($socket) => $socket.phase === 'open');

let connection = null;
let options = null;
let generation = 0;
let epoch = '';
let nextCall = 0;
const pending = new Map();
// topic -> { listeners: Set, revision: the newest announced, subscribed: whether Admin has it }
const watched = new Map();
const channels = new Map();
let reconnectTimer;
let stableTimer;
let reconnectAttempt = 0;
let reconnectSince = 0;
let opened = false;
let everOpened = false;

function browserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function setPhase(phase) {
  adminSocket.set({ phase, offline: browserOffline() });
  if (phase !== 'connecting') settleFirstOpen(phase === 'open');
  if (phase === 'open') settleReaders(true);
  if (phase === 'idle') settleReaders(false);
}

function socketUrl() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${ADMIN_SOCKET_PATH}`;
}

/** A call's answer as a fetch Response would give it, so every reader keeps its own validation unchanged. */
function answer(frame) {
  const body = frame.body;
  return {
    ok: frame.status >= 200 && frame.status < 300,
    status: frame.status,
    json: async () => structuredClone(body),
    revision: 'revision' in frame ? { topic: frame.topic, epoch: frame.epoch, revision: frame.revision } : null,
  };
}

function rejectPending(reason) {
  for (const { reject } of pending.values()) reject(reason);
  pending.clear();
}

function unavailable() {
  return new LocalApiError('Admin is reconnecting.', 0, 'socket-unavailable');
}

// A call Admin received and never answered before its socket closed: it may or may not have run, and is never replayed.
export const OUTCOME_UNKNOWN = 'outcome-unknown';

/** Whether a change failed because Admin disconnected before it answered: it may or may not have happened. */
export function outcomeUnknown(error) {
  return error instanceof LocalApiError && error.code === OUTCOME_UNKNOWN;
}

function lost() {
  return new LocalApiError('Admin disconnected before it answered.', 0, OUTCOME_UNKNOWN);
}

// Calls a page makes while its socket opens for the first time wait for that open; nothing is shown yet to keep.
const firstOpen = new Set();

function settleFirstOpen(isOpen) {
  for (const waiter of firstOpen) waiter(isOpen);
  firstOpen.clear();
}

// Reads waiting for the socket to open: each settles true once it is open, false once the session ended.
const readers = new Set();

function settleReaders(isOpen) {
  for (const reader of readers) reader(isOpen);
  readers.clear();
}

function socketIsOpen() {
  return opened && connection?.readyState === WebSocket.OPEN;
}

async function socketOpen() {
  if (!options) throw unavailable();
  if (!await new Promise((resolve) => readers.add(resolve))) throw unavailable();
}

// The operations that change state (ADR-0114 decision 5): never queued, never replayed. What the socket itself holds
// (subscriptions and attached chat channels) is restored by the socket when it reopens.
const CHANGES = new Set([
  'teams.create', 'teams.rename', 'teams.reorder', 'teams.delete', 'inference.save', 'action_confirmation.save',
  'assistants.install', 'assistants.install_local', 'assistants.uninstall', 'models.save', 'models.remove',
  'decision.save', 'decision.remove', 'integrations.authorize', 'integrations.complete', 'integrations.cancel',
  'integrations.disconnect', 'stored_inputs.clear', 'files.delete',
  'subscribe', 'unsubscribe', 'chat.attach', 'chat.detach',
]);

/**
 * Ask Admin for one operation. A read waits while the socket reconnects and runs once it is back; a read whose answer
 * the socket lost is asked again, since reading changes nothing. A change is never queued behind a reconnect: while
 * the socket reconnects it fails at once (`socket-unavailable`: it never reached Admin), and a socket that closes
 * meanwhile fails it with `outcome-unknown`, so a page re-reads rather than replays it. Only the tab's first open is
 * awaited for a change. Either fails once the session ended. A long call may report once, through `onProgress`, that
 * it started running.
 */
export async function call(method, params = {}, { onProgress } = {}) {
  if (!CHANGES.has(method)) return read(method, params);
  if (snapshot.phase === 'connecting' && !opened) {
    const isOpen = await new Promise((resolve) => firstOpen.add(resolve));
    if (!isOpen) throw unavailable();
  }
  return send(method, params, onProgress);
}

async function read(method, params) {
  for (;;) {
    // An open socket sends the read at once, in the caller's own turn.
    if (!socketIsOpen()) await socketOpen();
    try {
      return await send(method, params);
    } catch (error) {
      if (!(error instanceof LocalApiError) || ![OUTCOME_UNKNOWN, 'socket-unavailable'].includes(error.code)) throw error;
      if (!options) throw unavailable();
    }
  }
}

function send(method, params, onProgress) {
  if (!connection || connection.readyState !== WebSocket.OPEN || !opened) return Promise.reject(unavailable());
  if (pending.size >= MAX_IN_FLIGHT) return Promise.reject(new LocalApiError('Too many Admin requests.', 429));
  nextCall += 1;
  const id = `c${nextCall}`;
  const frame = { type: 'call', id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      pending.delete(id);
      reject(unavailable());
    }
  });
}

/** The reads screens make through the socket; a unit test may stand in for them. */
export const socketReads = { call };

// The person's own input is the only thing that keeps the session alive (ADR-0114): no call, chat frame, or HTTP
// request does. A content-free `activity` frame reports it, at most once a minute per tab, outside the call queue and
// only while the socket is open; input while it reconnects is never replayed.
export const ACTIVITY_INTERVAL_MS = 60_000;
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'click', 'touchstart', 'wheel', 'input', 'compositionend'];
let activityReported = -Infinity;
// Whether Admin has not yet answered the last report with a renewed deadline; a socket lost meanwhile may have dropped it.
// The deadline each socket opens with answers no report, so only a later one counts.
let reportUnacknowledged = false;
let openingDeadline = true;

function reportActivity(event) {
  if (!event.isTrusted) return;
  const now = performance.now();
  if (now - activityReported < ACTIVITY_INTERVAL_MS) return;
  if (!connection || connection.readyState !== WebSocket.OPEN || !opened) return;
  try {
    connection.send(JSON.stringify({ type: 'activity' }));
    activityReported = now;
    reportUnacknowledged = true;
  } catch {
    // A socket that closed meanwhile reports nothing; the next input after it reopens does.
  }
}

/** Report the person's own keyboard, pointer, touch, wheel, and text input; returns the function that stops it. */
export function trackActivity(target = document) {
  const options = { capture: true, passive: true };
  for (const type of ACTIVITY_EVENTS) target.addEventListener(type, reportActivity, options);
  return () => {
    for (const type of ACTIVITY_EVENTS) target.removeEventListener(type, reportActivity, options);
  };
}

/**
 * The session's deadlines as Admin last told them, on this page's clock: `idleAt` when it idles out unless the person
 * acts, and `absoluteAt` when it ends whatever they do (`performance.now()` milliseconds), or null before the first.
 */
export const sessionDeadlines = writable(null);

// Why a listener hears of its topic: `changed` (Admin raised it), `open` (the tab's first open, when every screen reads
// what it shows), or `reopen` (anything may have changed while the socket was closed).
function notify(topic, cause = 'changed') {
  const entry = watched.get(topic);
  if (!entry) return;
  for (const listener of entry.listeners) listener(topic, cause);
}

// Topics watched or forgotten in one turn of the page share one subscription change. A topic forgotten and watched
// again in the same turn keeps the subscription Admin already holds (`kept` says whether it was in place).
const queued = { subscribe: new Set(), unsubscribe: new Map(), scheduled: false };

function queueSubscription(method, topic, kept = false) {
  if (method === 'subscribe' && queued.unsubscribe.has(topic)) {
    const active = queued.unsubscribe.get(topic);
    queued.unsubscribe.delete(topic);
    if (active) return true;
  } else if (method === 'unsubscribe' && queued.subscribe.delete(topic)) {
    return false;
  }
  if (method === 'subscribe') queued.subscribe.add(topic);
  else queued.unsubscribe.set(topic, kept);
  if (queued.scheduled) return false;
  queued.scheduled = true;
  queueMicrotask(() => {
    queued.scheduled = false;
    for (const change of ['unsubscribe', 'subscribe']) {
      sendSubscription(change, [...queued[change].keys()]);
      queued[change].clear();
    }
  });
  return false;
}

// A topic subscribed while the socket is open is read once its subscription is in place (`subscribed`), never before:
// a change that lands between an earlier read and the subscription would otherwise never be heard of. A refused
// subscription (a spent session budget, for instance) is not in place: nothing is announced, and its topics are asked
// for again after a capped backoff, at most twice a minute once it is long, far inside the session's change budget. A
// refused unsubscription is asked for again the same way.
function sendSubscription(method, topics, { announce = true } = {}) {
  if (!topics.length || adminSnapshot().phase !== 'open') return;
  // One call names at most as many topics as a socket may hold; Admin closes the socket over a larger one.
  if (topics.length > MAX_SUBSCRIPTIONS) {
    for (let start = 0; start < topics.length; start += MAX_SUBSCRIPTIONS) {
      sendSubscription(method, topics.slice(start, start + MAX_SUBSCRIPTIONS), { announce });
    }
    return;
  }
  const socket = connection;
  const subscribing = method === 'subscribe';
  const entries = () => topics.map((topic) => [topic, watched.get(topic)]).filter(([, entry]) => entry);
  if (subscribing) for (const [, entry] of entries()) entry.subscribing = true;
  const refused = () => {
    if (socket !== connection) return;
    if (subscribing) {
      for (const [, entry] of entries()) {
        entry.subscribing = false;
        entry.active = false;
      }
    } else {
      // Admin still holds a topic it refused to drop: dropping it is asked for again, so it never keeps its place.
      for (const topic of topics) if (!watched.has(topic)) unsubscribing.add(topic);
    }
    retrySubscription();
  };
  call(method, { topics }).then(async (response) => {
    if (!response.ok) {
      refused();
      return;
    }
    if (!subscribing) return;
    const body = await response.json();
    if (EPOCH_RE.test(body?.epoch)) adoptEpoch(body.epoch);
    subscribeAttempt = 0;
    for (const [topic, entry] of entries()) {
      entry.subscribing = false;
      if (Number.isSafeInteger(body?.topics?.[topic])) entry.revision = Math.max(entry.revision, body.topics[topic]);
      entry.active = true;
      if (announce) notify(topic, 'subscribed');
    }
  }).catch(refused);
}

const SUBSCRIBE_RETRY_MS = 1_000;
const MAX_SUBSCRIBE_RETRY_MS = 30_000;
let subscribeRetry;
let subscribeAttempt = 0;
// Topics no screen watches any more that Admin refused to drop.
const unsubscribing = new Set();

function retrySubscription() {
  if (subscribeRetry) return;
  const delay = Math.min(SUBSCRIBE_RETRY_MS * (2 ** Math.min(subscribeAttempt, 5)), MAX_SUBSCRIBE_RETRY_MS);
  subscribeAttempt += 1;
  subscribeRetry = setTimeout(() => {
    subscribeRetry = undefined;
    const stale = [...unsubscribing].filter((topic) => !watched.has(topic));
    unsubscribing.clear();
    sendSubscription('unsubscribe', stale);
    const topics = [...watched].filter(([, entry]) => !entry.active && !entry.subscribing).map(([topic]) => topic);
    sendSubscription('subscribe', topics);
  }, delay);
}

// The socket closed: no subscription is in place or on its way, and a reopen asks for every topic at once.
function forgetSubscriptions() {
  clearTimeout(subscribeRetry);
  subscribeRetry = undefined;
  subscribeAttempt = 0;
  unsubscribing.clear();
  for (const entry of watched.values()) {
    entry.active = false;
    entry.subscribing = false;
  }
}

let snapshot = { phase: 'idle' };
adminSocket.subscribe((value) => {
  snapshot = value;
});

function adminSnapshot() {
  return snapshot;
}

/**
 * Hear every change of one topic, once its subscription is in place, and once when the socket opens and whenever it
 * reopens. The listener reads the topic again, `(topic, cause)` with the cause `changed`, `subscribed`, `open`, or
 * `reopen`; returns the function that stops listening.
 */
export function watchTopic(topic, listener) {
  if (!TOPIC_RE.test(topic)) throw new LocalApiError('Invalid Admin topic.');
  let entry = watched.get(topic);
  if (!entry) {
    if (watched.size >= MAX_SUBSCRIPTIONS) throw new LocalApiError('Too many Admin topics.');
    entry = { listeners: new Set(), revision: 0, active: false, subscribing: false };
    watched.set(topic, entry);
    // A subscription Admin still holds from a moment ago is in place already.
    entry.active = queueSubscription('subscribe', topic);
  }
  if (entry.active && adminSnapshot().phase === 'open') {
    // The topic is already subscribed: this listener reads at once, after any frame already on its way.
    queueMicrotask(() => {
      if (entry.listeners.has(listener)) listener(topic, 'subscribed');
    });
  }
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size || watched.get(topic) !== entry) return;
    watched.delete(topic);
    queueSubscription('unsubscribe', topic, entry.active);
  };
}

/**
 * A readable value of one topic: `read` runs once the topic is subscribed when the first screen shows it, at every
 * change, and after a reopen. A change that arrives while a read runs reads again once it ends, so the value is never
 * older than the last change. The last value stays while the socket reconnects or a read fails.
 */
export function topicValue(topic, read, initial = null) {
  const store = writable(initial, (set) => {
    let reading = false;
    let again = false;
    let stopped = false;
    async function refresh() {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          try {
            const value = await read();
            if (!stopped) set(value);
          } catch {
            // The last value stays; the next change or reopen reads again.
          }
        } while (again && !stopped);
      } finally {
        reading = false;
      }
    }
    const stop = watchTopic(topic, refresh);
    return () => {
      stopped = true;
      stop();
    };
  });
  return { subscribe: store.subscribe };
}

function chatEvent(frame) {
  const native = NATIVE_TEAM_FRAMES.has(frame.type) ||
    (frame.type === 'assistant-uninstall' && NATIVE_UNINSTALL_STATES.has(frame.state));
  if (native) return frame;
  const { team_id: _teamId, ...event } = frame;
  return event;
}

function exact(value, keys) {
  const present = Object.keys(value).sort();
  return present.length === keys.length && [...keys].sort().every((key, index) => key === present[index]);
}

function receive(text) {
  if (typeof text !== 'string' || text.length > MAX_INBOUND_BYTES) throw new Error('invalid frame');
  const frame = JSON.parse(text);
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('invalid frame');
  if (frame.type === 'result') {
    const revised = 'revision' in frame;
    if (
      !exact(frame, revised ? ['type', 'id', 'status', 'body', 'topic', 'epoch', 'revision'] : ['type', 'id', 'status', 'body']) ||
      !CALL_ID_RE.test(frame.id) ||
      !Number.isSafeInteger(frame.status) ||
      frame.status < 100 ||
      frame.status > 599 ||
      (revised && (!TOPIC_RE.test(frame.topic) || !EPOCH_RE.test(frame.epoch) || !Number.isSafeInteger(frame.revision)))
    ) throw new Error('invalid result');
    const waiting = pending.get(frame.id);
    if (!waiting) throw new Error('unexpected result');
    pending.delete(frame.id);
    waiting.resolve(answer(frame));
    return;
  }
  // A long call's own progress names its call; a chat channel's progress frame names its Team instead.
  if (frame.type === 'progress' && !('team_id' in frame)) {
    if (!exact(frame, ['type', 'id', 'state']) || !CALL_ID_RE.test(frame.id) || frame.state !== 'running') {
      throw new Error('invalid progress');
    }
    const waiting = pending.get(frame.id);
    if (!waiting) throw new Error('unexpected progress');
    waiting.onProgress?.(frame.state);
    return;
  }
  if (frame.type === 'session') {
    if (
      !exact(frame, ['type', 'idle_seconds', 'absolute_seconds']) ||
      !Number.isSafeInteger(frame.idle_seconds) ||
      !Number.isSafeInteger(frame.absolute_seconds) ||
      frame.idle_seconds < 0 ||
      frame.absolute_seconds < 0
    ) throw new Error('invalid session deadlines');
    const now = performance.now();
    if (openingDeadline) openingDeadline = false;
    else reportUnacknowledged = false;
    sessionDeadlines.set({ idleAt: now + frame.idle_seconds * 1000, absoluteAt: now + frame.absolute_seconds * 1000 });
    return;
  }
  if (frame.type === 'changed') {
    if (
      !exact(frame, ['type', 'topic', 'epoch', 'revision']) ||
      !TOPIC_RE.test(frame.topic) ||
      !EPOCH_RE.test(frame.epoch) ||
      !Number.isSafeInteger(frame.revision)
    ) throw new Error('invalid change');
    changed(frame);
    return;
  }
  if (typeof frame.type !== 'string' || typeof frame.team_id !== 'string' || !TEAM_ID_RE.test(frame.team_id)) {
    throw new Error('invalid chat frame');
  }
  // A frame Admin sent before it saw this page detach the Team (a Team switch) has no channel left to read it.
  const channel = channels.get(frame.team_id);
  if (channel?.attached || channel?.attaching) channel.deliver(chatEvent(frame));
}

// A new Admin process numbers every topic from the start again: each revision known from the last one is forgotten, so
// none of them hides a newer change. Says whether an earlier process's revisions were known.
function adoptEpoch(next) {
  if (next === epoch) return false;
  const restarted = epoch !== '';
  epoch = next;
  for (const entry of watched.values()) entry.revision = 0;
  return restarted;
}

function changed(frame) {
  const entry = watched.get(frame.topic);
  // A new Admin process may have changed anything: everything shown is re-read.
  if (adoptEpoch(frame.epoch)) {
    if (entry) entry.revision = frame.revision;
    for (const topic of watched.keys()) notify(topic);
    return;
  }
  if (!entry || frame.revision <= entry.revision) return;
  entry.revision = frame.revision;
  notify(frame.topic);
}

function scheduleReconnect() {
  if (!options || reconnectTimer) return;
  const now = performance.now();
  if (reconnectAttempt === 0) reconnectSince = now;
  setPhase(now - reconnectSince >= RECONNECT_WINDOW_MS ? 'failed' : 'reconnecting');
  // Jitter spreads the tabs of one browser, and of several, across each step of the backoff.
  const step = Math.min(FIRST_RECONNECT_DELAY_MS * (2 ** Math.min(reconnectAttempt, 7)), MAX_RECONNECT_DELAY_MS);
  const delay = step * (0.75 + Math.random() * 0.25);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    open();
  }, delay);
}

// The browser came online or the tab became visible: a socket waiting out its backoff tries again at once.
function reconnectNow() {
  if (!options) return;
  adminSocket.update((value) => ({ ...value, offline: browserOffline() }));
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  open();
}

function offlineChanged() {
  adminSocket.update((value) => ({ ...value, offline: browserOffline() }));
}

function visibilityChanged() {
  if (document.visibilityState === 'visible') reconnectNow();
}

function listenForConnectivity(listening) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const method = listening ? 'addEventListener' : 'removeEventListener';
  window[method]('online', reconnectNow);
  window[method]('offline', offlineChanged);
  globalThis.document?.[method]?.('visibilitychange', visibilityChanged);
}

// Only an answered session check that reports no authentication ends the session; an unreachable or failing Admin is
// the outage reconnecting exists to ride out.
async function signedOut() {
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(SESSION_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const session = await response.json();
    return session?.authenticated === false;
  } catch {
    return false;
  }
}

function endSession() {
  const ended = options?.onSignedOut;
  disconnectAdminSocket();
  ended?.();
}

async function closed(socket, code) {
  if (socket !== connection) return;
  const current = generation;
  connection = null;
  opened = false;
  clearTimeout(stableTimer);
  forgetSubscriptions();
  rejectPending(lost());
  // A channel hears of the drop once the shell already shows that it reconnects, so a page never says it twice.
  if (code !== SIGNED_OUT) setPhase('reconnecting');
  for (const channel of channels.values()) channel.dropped(code);
  // 4401 is Admin saying the session ended: every protected cache is cleared by the signed-out flow at once.
  if (code === SIGNED_OUT) {
    endSession();
    return;
  }
  // A refusal before the upgrade reaches the browser only as a failed connection, so every other close asks.
  const out = await signedOut();
  if (current !== generation || !options) return;
  if (out) endSession();
  else scheduleReconnect();
}

function open() {
  if (!options) return;
  let socket;
  try {
    socket = new WebSocket(socketUrl(), ADMIN_SOCKET_PROTOCOL);
  } catch {
    scheduleReconnect();
    return;
  }
  connection = socket;
  socket.onopen = () => {
    if (socket !== connection) return;
    if (socket.protocol !== ADMIN_SOCKET_PROTOCOL) {
      socket.close(1002, 'Protocol required');
      return;
    }
    opened = true;
    // A report the last socket took and Admin never answered may never have reached it: the person's next input on this
    // one reports at once. One Admin answered keeps the tab's minute.
    if (reportUnacknowledged) activityReported = -Infinity;
    reportUnacknowledged = false;
    openingDeadline = true;
    const cause = everOpened ? 'reopen' : 'open';
    everOpened = true;
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (socket === connection) reconnectAttempt = 0;
    }, STABLE_CONNECTION_MS);
    setPhase('open');
    const topics = [...watched.keys()];
    // The whole subscription goes first, so each read below follows it: a later change is always heard of.
    if (topics.length) sendSubscription('subscribe', topics, { announce: false });
    for (const topic of topics) watched.get(topic).active = true;
    for (const channel of channels.values()) channel.attach();
    // Every topic shown is read now: for the first time, or again since anything may have changed while it was closed.
    for (const topic of topics) notify(topic, cause);
  };
  socket.onmessage = (event) => {
    if (socket !== connection) return;
    try {
      receive(event.data);
    } catch {
      socket.close(1002, 'Invalid Admin frame');
    }
  };
  socket.onclose = (event) => {
    void closed(socket, event.code);
  };
}

/** Open the tab's one session socket for a signed-in Admin; `onSignedOut` runs when Admin says the session ended. */
export function connectAdminSocket({ onSignedOut }) {
  disconnectAdminSocket();
  options = { onSignedOut };
  generation += 1;
  everOpened = false;
  reconnectAttempt = 0;
  listenForConnectivity(true);
  setPhase('connecting');
  open();
  return disconnectAdminSocket;
}

/** Close the socket and forget what it held: every pending call fails and every channel closes. */
export function disconnectAdminSocket() {
  generation += 1;
  options = null;
  listenForConnectivity(false);
  clearTimeout(reconnectTimer);
  clearTimeout(stableTimer);
  reconnectTimer = undefined;
  const socket = connection;
  connection = null;
  opened = false;
  forgetSubscriptions();
  rejectPending(lost());
  for (const channel of [...channels.values()]) channel.dropped(1000);
  channels.clear();
  epoch = '';
  for (const entry of watched.values()) entry.revision = 0;
  activityReported = -Infinity;
  reportUnacknowledged = false;
  sessionDeadlines.set(null);
  setPhase('idle');
  socket?.close(1000, 'Signed out');
}

/**
 * One Team's chat channel with the surface of the WebSocket the chat page used: `onopen` after each attach (Admin then
 * synchronizes the Team), `onmessage` with each `shimpz.chat.v7` frame, `onclose` when the socket drops, and `send` and
 * `close`. The channel attaches again on its own whenever the socket reopens; closing it detaches the Team. It is a
 * class, as a WebSocket is, so a page can keep it in its own state and still compare it by identity.
 */
class ChatChannel {
  readyState = WebSocket.CONNECTING;
  attached = false;
  attaching = false;
  waiting = [];
  closedByPage = false;
  onopen = null;
  onmessage = null;
  onclose = null;

  constructor(teamId, locale) {
    this.teamId = teamId;
    this.locale = locale;
  }

  attach() {
    if (this.closedByPage) return;
    // Admin synchronizes the Team right after it answers: frames that arrive before this page has read the answer
    // wait for it, so the page always sees the channel open before its first frame.
    this.attaching = true;
    this.waiting = [];
    call('chat.attach', { team_id: this.teamId, locale: this.locale }).then((response) => {
      this.attaching = false;
      if (this.closedByPage || channels.get(this.teamId) !== this) {
        // The page closed the channel while it attached: the Team is detached again at once.
        if (response.ok) call('chat.detach', { team_id: this.teamId }).catch(() => {});
        return;
      }
      if (!response.ok) {
        this.dropped(1011);
        return;
      }
      this.attached = true;
      this.readyState = WebSocket.OPEN;
      this.onopen?.({});
      for (const event of this.waiting.splice(0)) this.deliver(event);
    }).catch(() => {
      this.attaching = false;
    });
  }

  deliver(event) {
    if (!this.attached) {
      if (this.attaching) this.waiting.push(event);
      return;
    }
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  dropped(code) {
    const wasAttached = this.attached;
    this.attached = false;
    this.attaching = false;
    this.waiting = [];
    this.readyState = WebSocket.CONNECTING;
    if (wasAttached || code !== 1000) this.onclose?.({ code });
  }

  send(text) {
    if (!this.attached || !connection) throw new LocalApiError('Admin is reconnecting.');
    const frame = JSON.parse(text);
    if (!CHAT_CLIENT_TYPES.has(frame?.type)) throw new LocalApiError('Invalid local chat request.');
    connection.send(JSON.stringify({ ...frame, team_id: this.teamId }));
  }

  close() {
    if (this.closedByPage) return;
    this.closedByPage = true;
    this.readyState = WebSocket.CLOSED;
    if (channels.get(this.teamId) === this) channels.delete(this.teamId);
    if (this.attached) call('chat.detach', { team_id: this.teamId }).catch(() => {});
    this.attached = false;
  }
}

/** Open one Team's chat channel on the session socket; it attaches now when the socket is open, or when it opens. */
export function openChatChannel(teamId, locale) {
  if (!TEAM_ID_RE.test(teamId)) throw new LocalApiError('Invalid local chat request.');
  if (channels.has(teamId) || channels.size >= MAX_ATTACHED_TEAMS) throw new LocalApiError('Invalid local chat request.');
  const channel = new ChatChannel(teamId, locale);
  channels.set(teamId, channel);
  if (adminSnapshot().phase === 'open') channel.attach();
  return channel;
}
