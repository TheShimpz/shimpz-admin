// Values a session keeps by key (ADR-0114, values a session keeps): each key's synced value is shared by every screen
// that asks for it, and the values no screen shows are bounded and evicted, the least recently shown first.

/**
 * Session values by key: a key asked for again shares its value, and the values no screen shows are evicted, least
 * recently shown first, beyond `maxEntries` or `maxBytes` (the sum of their `size()`). `make(key)` creates the value
 * of a new key; it is a synced value read for the session, with `size()` and `reset()`.
 */
export function sessionFamily(make, { maxEntries, maxBytes }) {
  const entries = new Map();
  const strays = new Set();
  let evicting = false;
  // A screen that changes what it shows lets go of its old values before it takes the new ones, so eviction waits
  // until that handoff is over: a value about to be shown is never taken for one no screen shows.
  function evictSoon() {
    if (evicting) return;
    evicting = true;
    queueMicrotask(() => {
      evicting = false;
      evict();
    });
  }
  function evict() {
    const idle = [...entries].filter(([, entry]) => entry.users === 0).sort(([, a], [, b]) => a.used - b.used);
    let bytes = idle.reduce((total, [, entry]) => total + entry.value.size(), 0);
    for (const [key, entry] of idle) {
      if (entries.size <= maxEntries && bytes <= maxBytes) break;
      bytes -= entry.value.size();
      entries.delete(key);
      entry.value.reset();
    }
  }
  return {
    get(key) {
      let entry = entries.get(key);
      if (!entry) {
        const value = make(key);
        entry = { value, users: 0, used: performance.now(), shared: null };
        const current = entry;
        current.shared = {
          ...value,
          subscribe(run, invalidate) {
            // A value evicted while a screen still held it is the session's again once shown, so clearing reaches it.
            if (entries.get(key) !== current) {
              if (entries.has(key)) strays.add(current);
              else entries.set(key, current);
            }
            current.users += 1;
            current.used = performance.now();
            const stop = value.subscribe(run, invalidate);
            return () => {
              stop();
              current.users -= 1;
              current.used = performance.now();
              // A stray value no screen shows any more is forgotten at once: it is outside the family's bounds.
              if (current.users === 0 && strays.delete(current)) current.value.reset();
              evictSoon();
            };
          },
        };
        entries.set(key, entry);
        evictSoon();
      }
      return entry.shared;
    },
    /**
     * Forget the value of every key but `keys`: a screen still showing one reads it again from the start, and it is
     * forgotten once more when its last screen leaves.
     */
    forgetExcept(keys) {
      const kept = new Set(keys);
      for (const [key, entry] of [...entries]) {
        if (kept.has(key)) continue;
        entries.delete(key);
        if (entry.users > 0) strays.add(entry);
        entry.value.reset();
      }
    },
    clear() {
      for (const entry of [...entries.values(), ...strays]) entry.value.reset();
      entries.clear();
      strays.clear();
    },
  };
}
