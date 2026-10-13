// Each Local Team's Routines and runs in progress for the sidebar tree (ADR-0086). Team is the authority; this is a
// synced projection of its closed Routine views (`synced.js`), never a schedule of its own: each listed Team's Routines
// are read over the session socket and read again whenever Admin says they changed, after a reconnect, and after a
// transient failure. A change made to a Routine never writes the list: the read after Admin announces it does.
import { writable } from 'svelte/store';

import { listRoutines, RoutineError } from './routine.js';
import { synced } from './synced.js';
import { LocalApiError } from './api.js';

/**
 * Team id -> the Team's listed Routines, runs, and unresolved incidents, and whether its newest listing was refused; a
 * Map, so no Team id can resolve to an inherited property. A Team not read yet has no entry, so it never reads as a
 * Team without Routines; a refused listing keeps the last known lists beside its failure.
 */
export const routineContext = writable(new Map());

// The session socket holds at most 64 topics, which every screen shares: the first Teams of the list follow their
// Routines' topic, and the Team the chat shows always does. Any other Team is read when listed and after a failure.
export const FOLLOWED_TEAMS = 40;

const NOTHING_LISTED = Object.freeze({ routines: [], runs: [], incidents: [] });

// Team id -> { value, followed, stop }: the Team's synced listing and the subscription that publishes it.
const teams = new Map();
let order = [];
const shown = new Set();

// A Routine refusal keeps its status, so an outage, an overload, or a server failure is read again on its own and a
// refusal or an invalid answer is shown.
async function listed(call, teamId) {
  try {
    return await listRoutines(call, teamId);
  } catch (error) {
    if (error instanceof RoutineError) throw new LocalApiError(error.code, error.status || 200, error.code);
    throw error;
  }
}

function publish(teamId, state) {
  routineContext.update((current) => {
    if (state.status === 'ready') return new Map(current).set(teamId, { ...state.value, failed: false });
    if (state.status === 'error') {
      return new Map(current).set(teamId, { ...(state.value ?? current.get(teamId) ?? NOTHING_LISTED), failed: true });
    }
    return current;
  });
}

function follows(teamId) {
  return shown.has(teamId) || order.indexOf(teamId) < FOLLOWED_TEAMS;
}

function track(teamId) {
  const followed = follows(teamId);
  const current = teams.get(teamId);
  if (current && current.followed === followed) return;
  current?.stop();
  const value = synced(followed ? `team/${teamId}/routines` : null, (call) => listed(call, teamId));
  const entry = { value, followed, stop: () => {} };
  teams.set(teamId, entry);
  // A listing already shown stays while the newly tracked one reads; it never falls back to nothing.
  entry.stop = value.subscribe((state) => {
    if (teams.get(teamId) === entry) publish(teamId, state);
  });
}

function untrack(teamId) {
  teams.get(teamId)?.stop();
  teams.delete(teamId);
}

/** Follow the Routines of exactly these Teams, in list order; a Team no longer listed is forgotten. */
export function retainTeamRoutines(teamIds) {
  order = [...teamIds];
  const kept = new Set(teamIds);
  for (const id of [...teams.keys()]) if (!kept.has(id)) untrack(id);
  for (const id of teamIds) track(id);
  routineContext.update((current) => new Map([...current].filter(([id]) => kept.has(id))));
}

/** The Team the chat shows always follows its Routines' topic; returns the function that stops showing it. */
export function showTeamRoutines(teamId) {
  shown.add(teamId);
  if (teams.has(teamId)) track(teamId);
  return () => {
    shown.delete(teamId);
    if (teams.has(teamId)) track(teamId);
  };
}

/** Read one Team's Routines again; settles once a read started after it has ended. */
export function refreshTeamRoutines(teamId) {
  return teams.get(teamId)?.value.refresh() ?? Promise.resolve();
}

/** Forget every Team's Routines when the Supervisor session ends. */
export function clearTeamRoutines() {
  for (const id of [...teams.keys()]) untrack(id);
  order = [];
  shown.clear();
  routineContext.set(new Map());
}
