import { get, writable } from 'svelte/store';

import { socketReads } from '../session/socket.js';
import { listAssistantCatalog, listInstalledAssistants } from '../assistants/api.js';
import { synced } from '../session/synced.js';
import { exactKeys, jsonObject, LocalApiError, publicError, safeApiError } from '../api.js';
import { codePointLength, isAscending, isShownText } from '../grammar.js';
import { MAX_TEAM_NAME_CHARS, OPAQUE_ID_RE, TEAM_ID_RE } from '../ids.js';

const MAX_TEAMS = 128;
const MAX_PASSWORD_CHARS = 4096;
const MAX_TEAM_RESIDUE_CLASSES = 32;
const TEAM_RESIDUE_CLASS_RE = /^[a-z][a-z0-9_]{0,63}$/;
// The most Assistants one Team may have installed (Team's MAX_TEAM_ASSISTANTS); a turn may name every one of them.
export const MAX_TEAM_ASSISTANTS = 16;

function emptyContext() {
  return {
    phase: 'idle',
    teams: [],
    selectedTeamId: '',
    catalog: [],
    installedAssistants: [],
    activeAssistantIds: [],
    // Whether the selected Team's inventory is current: `loading` while it is read, `failed` when that read failed
    // (the inventory is then empty), `ready` once read. Other Team operations failing never change it.
    inventory: 'idle',
    error: '',
  };
}

/**
 * The Team context every screen shows (ADR-0114): the Team list, the Assistant registry, and the selected Team's
 * inventory are synced values, each read over the session socket and again whenever Admin says it changed; this store
 * is derived from them and the local selection. A change made here never writes them: the next read does.
 */
export const teamContext = writable(emptyContext());
function hasExactEnvelopeKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if ('trace_id' in value && (typeof value.trace_id !== 'string' || !OPAQUE_ID_RE.test(value.trace_id))) {
    return false;
  }
  const payloadKeys = keys.filter((key) => key !== 'trace_id').sort();
  return payloadKeys.length === expected.length && expected.every((key, index) => key === payloadKeys[index]);
}

function validTeamResidueProof(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_TEAM_RESIDUE_CLASSES &&
    value.every((entry) => typeof entry === 'string' && TEAM_RESIDUE_CLASS_RE.test(entry)) &&
    isAscending(value)
  );
}

function preferredTeamId(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !TEAM_ID_RE.test(value)) {
    throw new LocalApiError('Invalid local Team request.');
  }
  return value;
}

/** A Team's display name exactly as Team admits it, or a thrown LocalApiError carrying `message`. */
export function canonicalTeamName(value, message = 'The local Team inventory is invalid.') {
  if (!isShownText(value, MAX_TEAM_NAME_CHARS)) {
    throw new LocalApiError(message);
  }
  return value;
}

// The Team context is read and changed over the Admin session socket (ADR-0114).
async function listTeams(call) {
  const response = await call('teams.list', {});
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'The local Team inventory is unavailable.'), response.status);
  }
  return parseTeamList(body, response.status);
}

// `teams.list` and `teams.reorder` answer the same closed list, already in the Supervisor's display order.
function parseTeamList(body, status) {
  if (
    !hasExactEnvelopeKeys(body, ['teams']) ||
    !Array.isArray(body.teams) ||
    body.teams.length > MAX_TEAMS
  ) {
    throw new LocalApiError('The local Team inventory is invalid.', status);
  }

  const seen = new Set();
  return body.teams.map((team) => {
    if (
      !exactKeys(team, ['status', 'team_id', 'team_name']) ||
      typeof team.team_id !== 'string' ||
      !TEAM_ID_RE.test(team.team_id) ||
      team.status !== 'running' ||
      seen.has(team.team_id)
    ) {
      throw new LocalApiError('The local Team inventory is invalid.', status);
    }
    canonicalTeamName(team.team_name);
    seen.add(team.team_id);
    return { id: team.team_id, name: team.team_name, status: team.status };
  });
}

function selectAvailableTeam(teams, ...preferred) {
  return preferred.find((id) => id && teams.some((team) => team.id === id)) ?? teams[0]?.id ?? '';
}

// What Admin holds, as last read, and what this page holds: whether a context was asked for, the Team asked for (by
// the address or a creation) until the list shows it, the selected Team, a selection under way, the changes in flight,
// and the order a reorder shows until its save is read back.
const teamsValue = synced('teams', listTeams);
const registryValue = synced('assistants/registry', (call) => listAssistantCatalog(call));
const local = {
  active: false,
  preferred: '',
  awaitingCreated: false,
  selected: '',
  selecting: null,
  // A Team that refused to open: the Team selected before shows again, without the inventory a message names, until
  // its inventory is read again or another Team is selected.
  refusal: null,
  pending: 0,
  refreshing: 0,
  overlay: null,
  stops: [],
};
let teamsState = { status: 'loading', value: null, error: null };
let registryState = { status: 'loading', value: null, error: null };
// The selected Team's inventory: its synced value, the Team it belongs to, and its last state.
let inventory = null;

function inventoryOf(teamId) {
  if (inventory?.teamId === teamId) return inventory;
  inventory?.stop();
  inventory = null;
  if (!teamId) return null;
  const value = synced(`team/${teamId}/inventory`, (call) => listInstalledAssistants(teamId, call));
  const entry = { teamId, value, state: { status: 'loading', value: null, error: null }, stop: () => {} };
  inventory = entry;
  entry.stop = value.subscribe((state) => {
    entry.state = state;
    if (inventory === entry) inventoryChanged();
  });
  return entry;
}

function sameMembers(ids, teams) {
  const members = new Set(teams.map((team) => team.id));
  return ids.length === members.size && ids.every((id) => members.has(id));
}

/** The current Team objects in `ids` order; names, statuses, and selection are untouched. */
function arranged(teams, ids) {
  const byId = new Map(teams.map((team) => [team.id, team]));
  return ids.map((id) => byId.get(id));
}

function chatScope(installedAssistants) {
  // Every running Assistant joins the chat in inventory order; a Team never has more than one turn may name.
  return installedAssistants.filter((entry) => entry.status === 'running').map((entry) => entry.assistant);
}

function failure(state, fallback) {
  return state.status === 'error' ? publicError(state.error, fallback).message : '';
}

// The context as screens see it, derived from the synced values and this page's own state.
function compose() {
  if (!local.active) {
    teamContext.set(emptyContext());
    return;
  }
  const listed = teamsState.value ?? [];
  const overlaid = local.overlay && sameMembers(local.overlay, listed) ? arranged(listed, local.overlay) : listed;
  const selectedTeamId = local.selected;
  const shown = inventory?.teamId === selectedTeamId ? inventory.state : null;
  const inventoryState = !selectedTeamId
    ? 'ready'
    : !shown || shown.status === 'loading' || local.refreshing
      ? 'loading'
      : shown.status === 'error' || local.refusal ? 'failed' : 'ready';
  const installedAssistants = inventoryState === 'failed' || !shown?.value ? [] : shown.value;
  const contextError = (!teamsState.value && failure(teamsState, 'The local Team context is unavailable.')) ||
    (!registryState.value && failure(registryState, 'The local Team context is unavailable.')) ||
    (inventoryState === 'failed'
      ? local.refusal?.message || failure(shown, 'The selected Team is unavailable.')
      : '');
  const known = Boolean(teamsState.value && registryState.value);
  const busy = local.pending > 0 || local.refreshing > 0 || inventoryState === 'loading';
  teamContext.set({
    phase: contextError ? 'error' : !known || busy ? 'loading' : 'ready',
    teams: overlaid,
    selectedTeamId,
    catalog: registryState.value ?? [],
    installedAssistants,
    activeAssistantIds: chatScope(installedAssistants),
    inventory: inventoryState,
    error: contextError,
  });
}

// The Team list was read: the Team asked for is selected when it shows, and a selected Team that is gone gives way to
// the first.
function teamsChanged(state) {
  teamsState = state;
  if (state.value) {
    const teams = state.value;
    if (!teams.some((team) => team.id === local.selected) || teams.some((team) => team.id === local.preferred)) {
      local.selected = selectAvailableTeam(teams, local.preferred, local.selected);
    }
    // A Team the address asked for is decided by the first list read; a created one waits until a read shows it.
    if (!local.awaitingCreated || teams.some((team) => team.id === local.preferred)) {
      local.preferred = '';
      local.awaitingCreated = false;
    }
    inventoryOf(local.selected);
  }
  compose();
}

// The selected Team's inventory was read: a selection under way settles, and one that failed returns to the Team it
// was made from.
function inventoryChanged() {
  const selecting = local.selecting;
  if (selecting && inventory?.teamId === selecting.teamId && inventory.state.status !== 'loading') {
    local.selecting = null;
    if (inventory.state.status === 'error') {
      const refused = publicError(inventory.state.error, 'The selected Team is unavailable.');
      local.selected = selecting.previous;
      local.refusal = selecting.previous ? refused : null;
      inventoryOf(local.selected);
      selecting.reject(refused);
    } else {
      selecting.resolve({ installedAssistants: inventory.state.value });
    }
  }
  compose();
}

function start() {
  local.active = true;
  local.stops = [
    teamsValue.subscribe(teamsChanged),
    registryValue.subscribe((state) => {
      registryState = state;
      compose();
    }),
  ];
}

// The context once it settled: ready, or why it failed. A context cleared meanwhile settles as failed.
function settledContext() {
  return new Promise((resolve, reject) => {
    let done = false;
    let stop = () => {};
    stop = teamContext.subscribe((state) => {
      if (done || state.phase === 'loading') return;
      done = true;
      queueMicrotask(() => stop());
      if (state.phase === 'ready') resolve(state);
      else reject(new LocalApiError(state.error || 'The local Team context changed.'));
    });
    if (done) stop();
  });
}

/**
 * Show the Team context, selecting `preferredId` once the list shows it. Asked for again (a retry), every value is
 * read again. Settles once the context is ready, or with why it failed.
 */
export async function loadTeamContext(preferredId = '') {
  const preferred = preferredTeamId(preferredId);
  if (preferred) local.preferred = preferred;
  local.refusal = null;
  if (!local.active) {
    start();
  } else {
    if (preferred && get(teamContext).teams.some((team) => team.id === preferred)) {
      local.selected = preferred;
      local.preferred = '';
      inventoryOf(preferred);
    }
    local.refreshing += 1;
    compose();
    try {
      await Promise.all([teamsValue.refresh(), registryValue.refresh(), inventory?.value.refresh()]);
    } finally {
      local.refreshing -= 1;
      compose();
    }
  }
  return settledContext();
}

/** Select one listed Team; settles with its inventory, or returns to the Team selected before when it fails. */
export function selectTeam(id) {
  const teamId = preferredTeamId(id);
  const current = get(teamContext);
  if (!teamId || !current.teams.some((team) => team.id === teamId)) {
    return Promise.reject(new LocalApiError('Invalid local Team request.'));
  }
  if (teamId === local.selected && inventory?.state.status === 'ready') {
    return Promise.resolve({ installedAssistants: inventory.state.value });
  }
  local.selecting?.reject(new LocalApiError('Another Team was selected.'));
  const previous = local.selecting?.previous ?? local.selected;
  local.refusal = null;
  return new Promise((resolve, reject) => {
    local.selecting = { teamId, previous, resolve, reject };
    local.selected = teamId;
    inventoryOf(teamId);
    inventoryChanged();
  });
}

/**
 * Read the selected Team's inventory and the Assistant registry again now: what depends on the inventory (a message's
 * Assistants, admitting an Assistant's request) waits, with the context `loading`, for the fresh one.
 */
export async function refreshTeamInventory() {
  if (!local.active) throw new LocalApiError('The local Team context changed.');
  const entry = inventory?.teamId === local.selected ? inventory : null;
  if (!entry) return { installedAssistants: [] };
  local.refreshing += 1;
  compose();
  try {
    await Promise.all([entry.value.refresh(), registryValue.refresh()]);
  } finally {
    local.refreshing -= 1;
    compose();
  }
  if (inventory !== entry) throw new LocalApiError('The local Team context changed.');
  if (entry.state.status === 'error') throw publicError(entry.state.error, 'The selected Team is unavailable.');
  if (local.refusal) {
    local.refusal = null;
    compose();
  }
  return { installedAssistants: entry.state.value ?? [] };
}

export function clearTeamContext() {
  for (const stop of local.stops) stop();
  inventory?.stop();
  inventory = null;
  local.selecting?.reject(new LocalApiError('The local Team context changed.'));
  Object.assign(local, {
    active: false,
    preferred: '',
    awaitingCreated: false,
    selected: '',
    selecting: null,
    refusal: null,
    pending: 0,
    refreshing: 0,
    overlay: null,
    stops: [],
  });
  reorder.desired = null;
  teamsValue.reset();
  registryValue.reset();
  teamsState = { status: 'loading', value: null, error: null };
  registryState = { status: 'loading', value: null, error: null };
  compose();
}

// A change in flight shows the context as loading; what it changed shows once the Team list is read after it.
async function changing(operation) {
  local.pending += 1;
  compose();
  try {
    return await operation();
  } finally {
    local.pending -= 1;
    compose();
  }
}

/** Create a Team; once the Team list read after it shows the Team, it is selected. */
export async function createTeam(name) {
  // Team admits names in NFC; normalize before sending and before comparing its answer (ADR-0088).
  const canonicalName = typeof name === 'string' ? name.trim().normalize('NFC') : name;
  canonicalTeamName(canonicalName, 'Enter a valid Team name.');
  return changing(async () => {
    let created;
    try {
      const response = await socketReads.call('teams.create', { body: { team_name: canonicalName } });
      const body = await jsonObject(response);
      if (!response.ok) {
        throw new LocalApiError(safeApiError(body, 'The Team could not be created.'), response.status);
      }
      if (
        !hasExactEnvelopeKeys(body, ['created', 'status', 'team_id', 'team_name']) ||
        typeof body.created !== 'boolean' ||
        typeof body.team_id !== 'string' ||
        !TEAM_ID_RE.test(body.team_id) ||
        body.team_name !== canonicalName ||
        body.status !== 'running'
      ) {
        throw new LocalApiError('The Team creation returned an invalid response.', response.status);
      }
      canonicalTeamName(body.team_name, 'The Team creation returned an invalid response.');
      created = { created: body.created, id: body.team_id, name: body.team_name, status: body.status };
    } catch (error) {
      // Nothing was created, or what happened is unknown: the Team list read next says which.
      throw publicError(error, 'The Team could not be created.');
    }
    local.preferred = created.id;
    local.awaitingCreated = true;
    await teamsValue.refresh();
    return created;
  });
}

/**
 * Rename a Team (ADR-0088): only its display name changes; its id and every Team-scoped state stay as they are. The
 * name shown is the one the Team list read after the rename holds.
 */
export async function renameTeam(id, name) {
  const canonicalId = preferredTeamId(id);
  const canonicalName = typeof name === 'string' ? name.trim().normalize('NFC') : name;
  canonicalTeamName(canonicalName, 'Enter a valid Team name.');
  const target = get(teamContext).teams.find((team) => team.id === canonicalId);
  // A Team the list shows can be renamed while an inventory or selection read runs; a whole-context load shows none.
  if (!target) throw new LocalApiError('Invalid local Team request.');
  if (target.name === canonicalName) return target;
  const response = await socketReads.call('teams.rename', { team_id: canonicalId, body: { team_name: canonicalName } });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'The Team could not be renamed.'), response.status);
  }
  if (
    !hasExactEnvelopeKeys(body, ['team_id', 'team_name']) ||
    body.team_id !== canonicalId ||
    body.team_name !== canonicalName
  ) {
    throw new LocalApiError('The Team rename returned an invalid response.', response.status);
  }
  await teamsValue.refresh();
  return get(teamContext).teams.find((team) => team.id === canonicalId) ?? { ...target, name: body.team_name };
}

async function putTeamOrder(ids) {
  const response = await socketReads.call('teams.reorder', { body: { team_ids: ids } });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'The Team order could not be saved.'), response.status);
  }
  if (!sameMembers(ids, parseTeamList(body, response.status))) {
    throw new LocalApiError('The Team order returned an invalid response.', response.status);
  }
}

// Reordering shows the moved order at once and saves it behind: one save runs at a time, and moves made during a save
// are coalesced into the next one. The moved order shows until the Team list read after the last save holds it; a
// refused save shows the list as Admin holds it.
const reorder = { desired: null, running: null };

async function drainTeamOrder() {
  try {
    while (reorder.desired) {
      const ids = reorder.desired;
      reorder.desired = null;
      await putTeamOrder(ids);
      await teamsValue.refresh();
    }
  } catch (error) {
    reorder.desired = null;
    // Teams were added or removed since this list was read, or the answer was lost: the list read next shows Admin's.
    void teamsValue.refresh();
    throw publicError(error, 'The Team order could not be saved.');
  } finally {
    local.overlay = null;
    compose();
  }
}

/** Show the Teams in `ids` order now and save it; the promise settles when every queued order has been saved. */
export function reorderTeams(ids) {
  const current = get(teamContext);
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_TEAMS ||
    new Set(ids).size !== ids.length ||
    !sameMembers(ids, current.teams)
  ) {
    return Promise.reject(new LocalApiError('Invalid local Team request.'));
  }
  reorder.desired = [...ids];
  local.overlay = [...ids];
  compose();
  if (!reorder.running) {
    reorder.running = drainTeamOrder().finally(() => {
      reorder.running = null;
    });
  }
  return reorder.running;
}

/** Delete a Team after its exact name and the Supervisor password; the Team list read after it says what remains. */
export async function deleteTeam(id, name, password) {
  const canonicalId = preferredTeamId(id);
  const current = get(teamContext);
  const target = current.teams.find((team) => team.id === canonicalId);
  if (!target || current.phase !== 'ready') {
    throw new LocalApiError('Invalid local Team request.');
  }
  if (typeof name !== 'string' || name !== target.name) {
    throw new LocalApiError('Enter the exact Team name.');
  }
  if (typeof password !== 'string' || !password || codePointLength(password) > MAX_PASSWORD_CHARS) {
    throw new LocalApiError('Enter the current Supervisor password.');
  }
  return changing(async () => {
    let result;
    try {
      const response = await socketReads.call('teams.delete', {
        team_id: canonicalId,
        body: { team_name: name, password },
      });
      const body = await jsonObject(response);
      if (!response.ok) {
        throw new LocalApiError(safeApiError(body, 'The Team could not be deleted.'), response.status);
      }
      if (
        !hasExactEnvelopeKeys(
          body,
          ['assistants_removed', 'destroyed', 'residue_absent', 'storage_removed', 'team_id'],
        ) ||
        body.team_id !== canonicalId ||
        typeof body.destroyed !== 'boolean' ||
        !Number.isSafeInteger(body.assistants_removed) ||
        body.assistants_removed < 0 ||
        typeof body.storage_removed !== 'boolean' ||
        !validTeamResidueProof(body.residue_absent)
      ) {
        throw new LocalApiError('The Team deletion returned an invalid response.', response.status);
      }
      result = {
        teamId: body.team_id,
        destroyed: body.destroyed,
        assistantsRemoved: body.assistants_removed,
        residueAbsent: [...body.residue_absent],
        storageRemoved: body.storage_removed,
      };
    } catch (error) {
      throw publicError(error, 'The Team could not be deleted.');
    }
    await teamsValue.refresh();
    return result;
  });
}
