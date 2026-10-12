// The Admin session socket (ADR-0114): one connection per tab, owned by the Admin shell, carrying every bounded read,
// every invalidation, and each attached Team's chat channel. Admin re-checks the page's Origin and session before each
// frame; this client never queues a call while the socket is not open, keeps the last state readable while it
// reconnects, and re-reads every subscribed topic when it reopens.
import { writable } from 'svelte/store';

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
const TOPIC_RE = /^(?:teams|space\/resources|platform\/release|security\/summary|session|team\/[a-z0-9_]{1,40}\/(?:routines|history))$/;
const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
// The chat-channel frames a client sends; every one carries its Team's `team_id`.
const CHAT_CLIENT_TYPES = new Set(['chat', 'resume-task', 'stop', 'sync', 'human-response']);
// The `shimpz.chat.v7` server frames whose own shape names their Team; on every other frame `team_id` is the channel's.
const NATIVE_TEAM_FRAMES = new Set(['done', 'assistant-install-plan', 'assistant-guidance']);
const NATIVE_UNINSTALL_STATES = new Set(['proposed', 'uninstalled']);
// A Local release swap restarts Admin for about half a minute, so a dropped socket keeps reconnecting with a capped
// backoff for long enough to cover it; only a connection that stayed open restores the backoff.
export const RECONNECT_WINDOW_MS = 150_000;
const MAX_RECONNECT_DELAY_MS = 10_000;
const STABLE_CONNECTION_MS = 10_000;
const SESSION_PROBE_TIMEOUT_MS = 5_000;
const SIGNED_OUT = 4401;

/**
 * `phase` is `idle` (signed out or not started), `connecting` (the first open), `open`, `reconnecting` (the last
 * state stays on screen and commands wait), or `failed` (reconnecting gave up; a reload is needed).
 */
export const adminSocket = writable({ phase: 'idle' });

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

function setPhase(phase) {
  adminSocket.set({ phase });
  if (phase !== 'connecting') settleFirstOpen(phase === 'open');
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

// Calls a page makes while its socket opens for the first time wait for that open; nothing is shown yet to keep.
const firstOpen = new Set();

function settleFirstOpen(isOpen) {
  for (const waiter of firstOpen) waiter(isOpen);
  firstOpen.clear();
}

/**
 * Ask Admin for one operation over the open socket. It is never queued behind a reconnect: while the socket reconnects
 * the call fails at once, and a socket that closes meanwhile fails it too, so a page re-reads rather than replays. Only
 * the tab's first open, before anything is on screen, is awaited.
 */
export async function call(method, params = {}, { background = false } = {}) {
  if (snapshot.phase === 'connecting' && !opened) {
    const isOpen = await new Promise((resolve) => firstOpen.add(resolve));
    if (!isOpen) throw unavailable();
  }
  return send(method, params, background);
}

function send(method, params, background) {
  if (!connection || connection.readyState !== WebSocket.OPEN || !opened) return Promise.reject(unavailable());
  if (pending.size >= MAX_IN_FLIGHT) return Promise.reject(new LocalApiError('Too many Admin requests.', 429));
  nextCall += 1;
  const id = `c${nextCall}`;
  const frame = { type: 'call', id, method, params };
  if (background) frame.background = true;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      pending.delete(id);
      reject(unavailable());
    }
  });
}

/** Run one automatic read of a topic: an automatic read never renews the session's idle time. */
export function backgroundCall(method, params = {}) {
  return call(method, params, { background: true });
}

/** The reads screens make through the socket; a unit test may stand in for them. */
export const socketReads = { call, backgroundCall };

// Why a listener hears of its topic: `changed` (Admin raised it), `open` (the tab's first open, when every screen reads
// what it shows), or `reopen` (anything may have changed while the socket was closed).
function notify(topic, cause = 'changed') {
  const entry = watched.get(topic);
  if (!entry) return;
  for (const listener of entry.listeners) listener(topic, cause);
}

// Topics watched or forgotten in one turn of the page share one subscription change.
const queued = { subscribe: new Set(), unsubscribe: new Set(), scheduled: false };

function queueSubscription(method, topic) {
  const other = method === 'subscribe' ? 'unsubscribe' : 'subscribe';
  if (!queued[other].delete(topic)) queued[method].add(topic);
  if (queued.scheduled) return;
  queued.scheduled = true;
  queueMicrotask(() => {
    queued.scheduled = false;
    for (const change of ['unsubscribe', 'subscribe']) {
      sendSubscription(change, [...queued[change]]);
      queued[change].clear();
    }
  });
}

function sendSubscription(method, topics) {
  if (!topics.length || adminSnapshot().phase !== 'open') return;
  backgroundCall(method, { topics }).then(async (response) => {
    if (!response.ok || method !== 'subscribe') return;
    const body = await response.json();
    if (!epoch && EPOCH_RE.test(body?.epoch)) epoch = body.epoch;
    for (const topic of topics) {
      const entry = watched.get(topic);
      if (entry && Number.isSafeInteger(body?.topics?.[topic])) entry.revision = Math.max(entry.revision, body.topics[topic]);
    }
  }).catch(() => {});
}

let snapshot = { phase: 'idle' };
adminSocket.subscribe((value) => {
  snapshot = value;
});

function adminSnapshot() {
  return snapshot;
}

/**
 * Hear every change of one topic, and once when the socket opens and whenever it reopens. The listener reads the topic
 * again, `(topic, cause)` with the cause `changed`, `open`, or `reopen`; returns the function that stops listening.
 */
export function watchTopic(topic, listener) {
  if (!TOPIC_RE.test(topic)) throw new LocalApiError('Invalid Admin topic.');
  let entry = watched.get(topic);
  if (!entry) {
    if (watched.size >= MAX_SUBSCRIPTIONS) throw new LocalApiError('Too many Admin topics.');
    entry = { listeners: new Set(), revision: 0 };
    watched.set(topic, entry);
    queueSubscription('subscribe', topic);
  }
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size || watched.get(topic) !== entry) return;
    watched.delete(topic);
    queueSubscription('unsubscribe', topic);
  };
}

/**
 * A readable value of one topic: `read` runs when the first screen shows it, at every change, and after a reopen. A
 * change that arrives while a read runs reads again once it ends, so the value is never older than the last change.
 * The last value stays while the socket reconnects or a read fails.
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
    if (adminSnapshot().phase === 'open') void refresh();
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

function changed(frame) {
  // A new Admin process starts every topic again: everything shown is re-read.
  if (epoch && frame.epoch !== epoch) {
    epoch = frame.epoch;
    for (const topic of watched.keys()) notify(topic);
    return;
  }
  const entry = watched.get(frame.topic);
  epoch = frame.epoch;
  if (!entry || frame.revision <= entry.revision) return;
  entry.revision = frame.revision;
  notify(frame.topic);
}

function scheduleReconnect() {
  if (!options || reconnectTimer) return;
  const now = performance.now();
  if (reconnectAttempt === 0) reconnectSince = now;
  if (now - reconnectSince >= RECONNECT_WINDOW_MS) {
    setPhase('failed');
    return;
  }
  setPhase('reconnecting');
  const delay = Math.min(400 * (2 ** Math.min(reconnectAttempt, 5)), MAX_RECONNECT_DELAY_MS);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    open();
  }, delay);
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
  rejectPending(unavailable());
  for (const channel of channels.values()) channel.dropped(code);
  // 4401 is Admin saying the session ended: every protected cache is cleared by the signed-out flow at once.
  if (code === SIGNED_OUT) {
    endSession();
    return;
  }
  setPhase('reconnecting');
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
    const cause = everOpened ? 'reopen' : 'open';
    everOpened = true;
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (socket === connection) reconnectAttempt = 0;
    }, STABLE_CONNECTION_MS);
    setPhase('open');
    const topics = [...watched.keys()];
    if (topics.length) sendSubscription('subscribe', topics);
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
  setPhase('connecting');
  open();
  return disconnectAdminSocket;
}

/** Close the socket and forget what it held: every pending call fails and every channel closes. */
export function disconnectAdminSocket() {
  generation += 1;
  options = null;
  clearTimeout(reconnectTimer);
  clearTimeout(stableTimer);
  reconnectTimer = undefined;
  const socket = connection;
  connection = null;
  opened = false;
  rejectPending(unavailable());
  for (const channel of [...channels.values()]) channel.dropped(1000);
  channels.clear();
  epoch = '';
  for (const entry of watched.values()) entry.revision = 0;
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
    backgroundCall('chat.attach', { team_id: this.teamId, locale: this.locale }).then((response) => {
      this.attaching = false;
      if (this.closedByPage || channels.get(this.teamId) !== this) {
        // The page closed the channel while it attached: the Team is detached again at once.
        if (response.ok) backgroundCall('chat.detach', { team_id: this.teamId }).catch(() => {});
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
    if (this.attached) backgroundCall('chat.detach', { team_id: this.teamId }).catch(() => {});
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
