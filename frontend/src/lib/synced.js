// The one way a screen holds data Admin serves (ADR-0114): a synced value of one read of one topic. It subscribes to
// the topic while a screen shows it, reads once the subscription is in place, and reads again whenever its value may be
// older than what Admin holds: on a change Admin announces, on a subscription (or reopen) at a newer revision, after a
// change announced while a read ran, and after a transient failure (with a capped backoff, never a terminal error). It
// runs one read at a time, so an older answer can never overwrite a newer one, and it knows the revision its value
// reflects from the read's own results, never from another read of the same topic. A change a screen makes never sets
// the value: its own read after Admin announces the change does (`refresh()` waits for that read).
import { derived, writable } from 'svelte/store';

import { socketReads } from './adminSocket.js';
import { LocalApiError } from './validate.js';

export const RETRY_FIRST_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

// The shown synced values whose reads keep failing in a way that clears by itself: the shell says so once, for all.
const failingValues = writable(new Set());

/** Whether some data a screen shows cannot be read right now, while it is read again on its own. */
export const dataUnavailable = derived(failingValues, (values) => values.size > 0);

function markFailing(token, on) {
  failingValues.update((values) => {
    if (on === values.has(token)) return values;
    const next = new Set(values);
    if (on) next.add(token);
    else next.delete(token);
    return next;
  });
}

/** A failure worth reading again on its own: Admin or Team briefly unavailable, busy, or the socket reconnecting. */
export function transientFailure(error) {
  if (!(error instanceof LocalApiError)) return true;
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

/**
 * A synced value: `read(call)` reads it with `call(method, params)`, which answers as the session socket does and
 * records the revisions of `topic` its results reflect. `topic` may be null for data no topic announces (the public
 * Store catalog): it is read when shown and retried on failure. The store holds `{ status, value, error, failing }`:
 * `loading` until the first read ends, `ready` with the newest value, or `error` with the last value kept and the
 * failure of a read that will not succeed by itself (a refusal). A transient failure keeps the status and retries;
 * `failing` names it meanwhile (an outage of Admin's own connection is the shell's to say, so it never does).
 *
 * A value read for the session (`retain: { maxAgeMs }`) keeps what it read when the last screen leaves, so the next
 * screen shows it at once: it drops only the reads under way and its retry, and stops watching its topic. Shown again,
 * it reads again only when it may be older than Admin's: its topic's revision moved since its read (Admin's revision is
 * in the subscription's acknowledgment), or it is older than `maxAgeMs`. `reset()` forgets it, as a session that ended
 * must; `size()` is the UTF-8 size of the answers its value was read from.
 */
export function synced(topic, read, { initial = null, retain = null } = {}) {
  let value = initial;
  let has = false;
  // When the value was read (the page's clock) and the size of the answers it was read from.
  let readAt = 0;
  let size = 0;
  // The revision the value reflects, and the newest one Admin announced for the topic: the value is stale while older.
  let reflects = { epoch: '', revision: -1 };
  let known = { epoch: '', revision: -1 };
  // The reads under way belong to one era: a reset or the last screen leaving starts a new one, and a read of an older
  // era neither publishes nor ends the reads of the current one.
  let era = 0;
  let reading = null;
  let again = false;
  let stopped = true;
  // Whether the topic's subscription is in place, so a read made now misses no later change; and what waits for it.
  let subscribed = false;
  let waiting = null;
  let retryTimer;
  let retryAttempt = 0;
  let publish = () => {};
  let failing = null;
  // The last refusal, shown until a read succeeds: a transient failure since says nothing about whether it still holds.
  let refusal = null;
  const empty = () => ({ status: 'loading', value: initial, error: null, failing: null });
  const token = {};
  // Every state published says whether this value is failing, so the shell's one message follows it.
  function show(state) {
    markFailing(token, Boolean(state.failing) && !stopped);
    publish(state);
  }

  function stale() {
    if (!has) return true;
    if (!known.epoch) return false;
    return reflects.epoch !== known.epoch || reflects.revision < known.revision;
  }

  function hear(knownNow) {
    if (!knownNow?.epoch) return;
    if (knownNow.epoch !== known.epoch || knownNow.revision > known.revision) known = { ...knownNow };
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const delay = Math.min(RETRY_FIRST_MS * (2 ** Math.min(retryAttempt, 5)), RETRY_MAX_MS);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!stopped) void refresh();
    }, delay);
  }

  async function once(owner) {
    again = false;
    const before = { ...known };
    const seen = [];
    let bytes = 0;
    const call = async (method, params) => {
      const response = await socketReads.call(method, params);
      const revision = response?.revision;
      if (topic && revision?.topic === topic) seen.push({ epoch: revision.epoch, revision: revision.revision });
      bytes += response?.bytes ?? 0;
      return response;
    };
    try {
      const next = await read(call);
      if (owner !== era) return;
      value = next;
      has = true;
      readAt = performance.now();
      size = bytes;
      // The oldest revision any of its results reflects; a read whose results carry none reflects what was known as
      // it started, since Admin announces every later change.
      reflects = seen.length
        ? seen.reduce((oldest, item) => (item.revision < oldest.revision ? item : oldest))
        : before;
      retryAttempt = 0;
      clearTimeout(retryTimer);
      failing = null;
      refusal = null;
      show({ status: 'ready', value, error: null, failing });
      if (stale()) again = true;
    } catch (error) {
      if (owner !== era) return;
      if (transientFailure(error)) {
        failing = error instanceof LocalApiError && error.status === 0 ? failing : error;
        show({ status: refusal ? 'error' : has ? 'ready' : 'loading', value, error: refusal, failing });
        scheduleRetry();
        return;
      }
      failing = null;
      refusal = error;
      show({ status: 'error', value, error, failing });
    }
  }

  function run() {
    const owner = era;
    const current = (async () => {
      try {
        do await once(owner); while (again && owner === era);
      } finally {
        if (reading === current) reading = null;
      }
    })();
    reading = current;
    return current;
  }

  /**
   * Read again now, or once the read under way ends, and never before the subscription is in place; settles when a
   * read started after this call has ended (at once when no screen shows the value).
   */
  function refresh() {
    if (stopped) return Promise.resolve();
    if (topic && !subscribed) {
      waiting ??= Promise.withResolvers();
      return waiting.promise;
    }
    if (reading) {
      again = true;
      return reading;
    }
    return run();
  }

  // Older than a value read for the session may be shown without reading it again.
  function aged() {
    return Boolean(retain) && performance.now() - readAt >= retain.maxAgeMs;
  }

  // Drop the reads under way and the retry: an older era neither publishes nor reads again.
  function drop() {
    era += 1;
    again = false;
    reading = null;
    retryAttempt = 0;
    clearTimeout(retryTimer);
    failing = null;
    subscribed = false;
    waiting?.resolve();
    waiting = null;
    markFailing(token, false);
  }

  // Forget everything read: the value, what it reflects, the reads under way, and the retry.
  function forget() {
    era += 1;
    value = initial;
    has = false;
    readAt = 0;
    size = 0;
    reflects = { epoch: '', revision: -1 };
    known = { epoch: '', revision: -1 };
    again = false;
    reading = null;
    retryAttempt = 0;
    clearTimeout(retryTimer);
    failing = null;
    refusal = null;
    subscribed = false;
    waiting?.resolve();
    waiting = null;
    markFailing(token, false);
  }

  // The last screen left: what it showed is protected data no other screen may see later without reading it again,
  // unless it is read for the session and was read cleanly, which it then keeps.
  function leave(set) {
    stopped = true;
    if (retain && has && !refusal) {
      drop();
      set({ status: 'ready', value, error: null, failing: null });
      return;
    }
    forget();
    set(empty());
  }

  const store = writable(empty(), (set) => {
    stopped = false;
    publish = set;
    if (!topic) {
      if (!has || aged()) void refresh();
      return () => leave(set);
    }
    let first = true;
    const stop = socketReads.watch(topic, (_topic, cause, knownNow) => {
      hear(knownNow);
      subscribed = true;
      const asked = waiting;
      waiting = null;
      // A change always reads, and so does the first subscription (unless it shows a value kept for the session that is
      // neither stale nor too old) and anything asked for before it; a later subscription or reopen reads only what
      // may be older than Admin's revision.
      const opening = first;
      first = false;
      if (cause === 'changed' || (opening && (!has || aged())) || asked || stale()) {
        const done = refresh();
        if (asked) void done.then(asked.resolve, asked.resolve);
      }
    });
    return () => {
      stop();
      leave(set);
    };
  });

  /** Forget the value and what it reflects, as a session that ended must: the next screen reads it from the start. */
  function reset() {
    const inPlace = subscribed;
    forget();
    store.set(empty());
    // A screen still showing it reads it again at once, under the subscription it still holds, or once that is in place.
    subscribed = inPlace;
    if (!stopped) void refresh();
  }

  return { subscribe: store.subscribe, refresh, reset, size: () => size };
}
