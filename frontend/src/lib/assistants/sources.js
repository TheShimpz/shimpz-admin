// What the Assistants pages show, each a synced value of its own read (ADR-0114): the staged snapshots, the public
// Store catalog, and each Assistant's summary or page in one interface language. Each read kind and key is its own
// synced value, so it knows only the revision its own reads reflected. Each also says when its last read failed in a
// way that clears by itself (Team's preview busy or unavailable, the Store unreachable): the page may say so while
// the value keeps reading again on its own.
//
// The catalog, the staged snapshots, and their summaries belong to the Supervisor session, not to one visit of a page:
// each screen that shows them shares one value, which keeps what it read after the screen leaves, so the Store shows at
// once when the person returns, and reads again when it may be stale. They are bounded, and `clearAssistantSources()`
// forgets every one of them, with the session's icons, when the session ends.
import { derived, readable } from 'svelte/store';

import { clearIconCache, localIcon, MAX_CACHED_ICONS, preloadIcons, publicIcon } from './iconCache.js';
import { listLocalAssistantSnapshots, listPublicAssistantCatalog } from './api.js';
import {
  loadAssistantDetails,
  loadAssistantSummary,
  loadLocalAssistantDetails,
  loadLocalAssistantSummary,
} from './preview.js';
import { groupLocalAssistantSnapshots, projectPublishedAssistants } from './snapshots.js';
import { sessionFamily } from '../session/family.js';
import { synced } from '../session/synced.js';

const SNAPSHOTS = 'local-assistants';
const inventory = (teamId) => `team/${teamId}/inventory`;
// Admin keeps a Store catalog for 60 s (CATALOG_TTL_SECONDS): reading it again sooner reads the same catalog.
const CATALOG_MAX_AGE_MS = 60_000;
// The CLI stages and removes snapshots without Admin, whose watcher samples them only while a screen watches them: a
// screen showing them again always reads them again.
const SNAPSHOTS_MAX_AGE_MS = 0;
const MAX_CATALOGS = 2;
const MAX_SUMMARIES = 64;
// The UTF-8 size of the answers the catalogs and summaries no screen shows may hold.
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;

const snapshots = synced(SNAPSHOTS, (call) => listLocalAssistantSnapshots(call), {
  retain: { maxAgeMs: SNAPSHOTS_MAX_AGE_MS },
});
const catalogs = sessionFamily(
  (locale) => synced(null, (call) => listPublicAssistantCatalog(locale, call), {
    retain: { maxAgeMs: CATALOG_MAX_AGE_MS },
  }),
  { maxEntries: MAX_CATALOGS, maxBytes: MAX_RETAINED_BYTES },
);
// A summary of one exact image in one language never changes, since the image id is its content's digest: staging or
// removing another snapshot reads no summary again, and a removed one leaves with its key.
const summaries = sessionFamily((key) => {
  const [locale, imageId] = key.split('|');
  return synced(null, (call) => loadLocalAssistantSummary(imageId, locale, { call }), {
    retain: { maxAgeMs: Infinity },
  });
}, { maxEntries: MAX_SUMMARIES, maxBytes: MAX_RETAINED_BYTES });

/** This machine's staged snapshots, read again whenever one is staged or removed (the CLI). */
export function stagedSnapshots() {
  return snapshots;
}

/** The public Store catalog in one interface language: no topic announces it, so it is read when shown. */
export function publicCatalog(locale) {
  return catalogs.get(locale);
}

/** One staged snapshot's summary in one interface language, from its own pack. */
export function snapshotSummary(imageId, locale) {
  return summaries.get(`${locale}|${imageId}`);
}

// The warm-up under way, if any: it ends when what it reads is in, or when the session ends.
let warming = null;

/**
 * Read what the Store shows before the person opens it, the same values its page shows: the staged snapshots, the
 * catalog in the interface language, the summaries the page shows in that language, and every row's icon. Its reads end
 * once they are in; the values and icons stay for the session.
 */
export function warmAssistantSources(locale) {
  warming?.();
  const stops = [];
  const stop = () => {
    for (const end of stops.splice(0)) end();
    if (warming === stop) warming = null;
  };
  warming = stop;
  let local = null;
  let published = null;
  let pending = null;
  const settle = () => {
    if (warming !== stop || !local || !published) return;
    if (!pending) {
      const groups = groupLocalAssistantSnapshots(local);
      // The rows the Store shows first, as many as the session's icon budget holds.
      preloadIcons([
        ...groups.map((group) => localIcon(group.primary)),
        ...projectPublishedAssistants(published, groups, true).map((assistant) => publicIcon(assistant)),
      ].slice(0, MAX_CACHED_ICONS));
      // English shows each snapshot's own catalog summary; another language shows its pack's translation.
      pending = new Set(locale === 'en' ? [] : groups.map((group) => group.primary.image_id));
      for (const imageId of [...pending]) {
        stops.push(snapshotSummary(imageId, locale).subscribe((state) => {
          if (state.status === 'loading') return;
          pending.delete(imageId);
          settle();
        }));
      }
    }
    // Every value is in: the warm-up lets go of them, and they stay for the session.
    if (!pending.size) queueMicrotask(stop);
  };
  stops.push(snapshots.subscribe((state) => {
    if (state.status === 'ready') local = state.value;
    settle();
  }));
  stops.push(publicCatalog(locale).subscribe((state) => {
    if (state.status === 'ready') published = state.value;
    settle();
  }));
  // The summaries' reads need no more than a moment once the lists are in; an unanswered warm-up gives up after a while.
  const timer = globalThis.setTimeout(stop, 30_000);
  stops.push(() => globalThis.clearTimeout(timer));
  return stop;
}

/** The session ended: forget every catalog, snapshot list, and summary kept for it, and every icon. */
export function clearAssistantSources() {
  warming?.();
  snapshots.reset();
  catalogs.clear();
  summaries.clear();
  clearIconCache();
}

/** One staged snapshot's page in one interface language. */
export function snapshotDetails(imageId, assistantId, locale) {
  return synced(SNAPSHOTS, (call) => loadLocalAssistantDetails(imageId, assistantId, locale, { call }));
}

/** One installed Assistant's summary in one interface language, from its binding's pack. */
export function installedSummary(teamId, assistantId, locale) {
  return synced(inventory(teamId), (call) => loadAssistantSummary(teamId, assistantId, locale, { call }));
}

/** One installed Assistant's page in one interface language, from the exact binding Team runs. */
export function installedDetails(teamId, assistantId, locale) {
  return synced(inventory(teamId), (call) => loadAssistantDetails(teamId, assistantId, locale, { call }));
}

/**
 * Synced values by key, kept while their key is asked for: a key asked for again reuses its value, so a list that
 * changes never reads again what it still shows. `make(key)` creates the value of a new key.
 */
export function syncedFamily(make) {
  const values = new Map();
  return {
    /** One store of every key's state, `{ key: { status, value, error } }`. */
    of(keys) {
      for (const key of [...values.keys()]) if (!keys.includes(key)) values.delete(key);
      for (const key of keys) if (!values.has(key)) values.set(key, make(key));
      if (!keys.length) return readable({});
      const stores = keys.map((key) => values.get(key));
      return derived(stores, (states) => Object.fromEntries(keys.map((key, index) => [key, states[index]])));
    },
  };
}
