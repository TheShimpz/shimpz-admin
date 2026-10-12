// What the Assistants pages show, each a synced value of its own read (ADR-0114): the staged snapshots, the public
// Store catalog, and each Assistant's summary or page in one interface language. Each read kind and key is its own
// synced value, so it knows only the revision its own reads reflected. Each also says when its last read failed in a
// way that clears by itself (Team's preview busy or unavailable, the Store unreachable): the page may say so while
// the value keeps reading again on its own.
import { derived, readable } from 'svelte/store';

import { listLocalAssistantSnapshots, listPublicAssistantCatalog } from './localApi.js';
import {
  loadAssistantDetails,
  loadAssistantSummary,
  loadLocalAssistantDetails,
  loadLocalAssistantSummary,
} from './localAssistantIcons.js';
import { synced } from './synced.js';

const SNAPSHOTS = 'local-assistants';
const inventory = (teamId) => `team/${teamId}/inventory`;

/** This machine's staged snapshots, read again whenever one is staged or removed (the CLI). */
export function stagedSnapshots() {
  return synced(SNAPSHOTS, (call) => listLocalAssistantSnapshots(call));
}

/** The public Store catalog in one interface language: no topic announces it, so it is read when shown. */
export function publicCatalog(locale) {
  return synced(null, (call) => listPublicAssistantCatalog(locale, call));
}

/** One staged snapshot's summary in one interface language, from its own pack. */
export function snapshotSummary(imageId, locale) {
  return synced(SNAPSHOTS, (call) => loadLocalAssistantSummary(imageId, locale, { call }));
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
