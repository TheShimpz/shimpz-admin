// Each Local Team's Routines and runs in progress for the sidebar tree (ADR-0086). Team is the authority; this is a
// refreshable projection of its closed Routine views, never a schedule of its own.
import { writable } from 'svelte/store';

import { listRoutines } from './routine.js';

/**
 * Team id -> the Team's listed Routines, runs, and unresolved incidents; a Map, so no Team id can resolve to an
 * inherited property.
 */
export const routineContext = writable(new Map());

// Only a Team's newest request may apply. Forgetting a Team (removal, session end) or applying a confirmed deletion
// replaces its ticket, so a response still in flight can never restore state that is already gone.
let sequence = 0;
const latest = new Map();

function issue(teamId) {
  sequence += 1;
  latest.set(teamId, sequence);
  return sequence;
}

/** Load one Team's Routines; a failure leaves that Team's last known state in place and is reported to the caller. */
export async function loadTeamRoutines(fetcher, teamId) {
  const ticket = issue(teamId);
  const listed = await listRoutines(fetcher, teamId);
  if (latest.get(teamId) === ticket) routineContext.update((current) => new Map(current).set(teamId, listed));
  return listed;
}

/** Keep only the Teams that still exist. */
export function retainTeamRoutines(teamIds) {
  const kept = new Set(teamIds);
  for (const id of [...latest.keys()]) if (!kept.has(id)) latest.delete(id);
  routineContext.update((current) => new Map([...current].filter(([id]) => kept.has(id))));
}

/** Apply a deletion Team confirmed, before any refresh, so a failed refresh cannot leave the Routine on screen. */
export function dropTeamRoutine(teamId, routineId) {
  issue(teamId);
  routineContext.update((current) => {
    const listed = current.get(teamId);
    if (!listed) return current;
    return new Map(current).set(teamId, {
      routines: listed.routines.filter((routine) => routine.routine_id !== routineId),
      runs: listed.runs.filter((run) => run.routine_id !== routineId),
      // Deleting a Routine sets its held runs aside, so none of its incidents waits for a card any more (ADR-0092).
      incidents: listed.incidents.filter((item) => item.routine_id !== routineId),
    });
  });
}

/** Forget every Team's Routines when the Supervisor session ends. */
export function clearTeamRoutines() {
  latest.clear();
  routineContext.set(new Map());
}
