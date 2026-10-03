// Display names of the Local Assistant catalog, read once and shared: Routine plans and notices name an Assistant by
// its title, and by its humanized id while the catalog is unread or unavailable. Display only; never authority.
import { writable } from 'svelte/store';

import { listAssistantCatalog } from './localApi.js';

/** Assistant id -> display name; empty until the catalog is read. */
export const assistantNames = writable({});

let loading = null;

/** Read the catalog once per page; a failure leaves the names empty and lets a later call try again. */
export function loadAssistantNames(fetcher) {
  loading ??= listAssistantCatalog(fetcher)
    .then((catalog) => assistantNames.set(Object.fromEntries(catalog.map((item) => [item.id, item.name]))))
    .catch(() => { loading = null; });
  return loading;
}
