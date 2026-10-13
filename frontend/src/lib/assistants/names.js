// Display names of the Local Assistant catalog, as the Team context last read it: Routine plans and notices name an
// Assistant by its title, and by its humanized id while the catalog is unread or unavailable. The context reads the
// catalog again with every Team load, selection, and inventory refresh, and clears it with the session. Display only;
// never authority.
import { derived } from 'svelte/store';

import { teamContext } from '../teams/context.js';

/** Assistant id -> display name; empty until the catalog is read. */
export const assistantNames = derived(
  teamContext,
  ($context) => Object.fromEntries($context.catalog.map((item) => [item.id, item.name])),
);
