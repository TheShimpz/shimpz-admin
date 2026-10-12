import { get, writable } from 'svelte/store';

import { socketReads } from './adminSocket.js';
import { listAssistantCatalog, listInstalledAssistants, LocalApiError, safeApiError } from './localApi.js';
import {
  ASSISTANT_ID_RE,
  canonicalTeamName,
  codePointLength,
  exactKeys,
  jsonObject,
  publicError,
  TEAM_ID_RE,
  TRACE_ID_RE,
} from './validate.js';

const MAX_TEAMS = 128;
const MAX_PASSWORD_CHARS = 4096;
const MAX_INSTALLED_ASSISTANTS = 128;
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

export const teamContext = writable(emptyContext());

let generation = 0;
// The Team list operation in flight (a load, a selection, a creation, or a deletion). It publishes a fresh inventory
// of the Team it selects, so an inventory refresh started meanwhile waits for it instead of discarding its list.
let listOperation = null;

function listing(operation) {
  const tracked = operation.finally(() => {
    if (listOperation === tracked) listOperation = null;
  });
  listOperation = tracked;
  return tracked;
}
function chatScope(installedAssistants) {
  // Every running Assistant joins the chat in inventory order; a Team never has more than one turn may name.
  return {
    activeAssistantIds: installedAssistants
      .filter((entry) => entry.status === 'running')
      .map((entry) => entry.assistant),
  };
}

function hasExactEnvelopeKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if ('trace_id' in value && (typeof value.trace_id !== 'string' || !TRACE_ID_RE.test(value.trace_id))) {
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
    value.every((entry, index) => (
      typeof entry === 'string' &&
      TEAM_RESIDUE_CLASS_RE.test(entry) &&
      (index === 0 || value[index - 1] < entry)
    ))
  );
}

function preferredTeamId(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !TEAM_ID_RE.test(value)) {
    throw new LocalApiError('Invalid local Team request.');
  }
  return value;
}

// The Team context is read and changed over the Admin session socket (ADR-0114).
async function listTeams() {
  const response = await socketReads.call('teams.list', {});
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

function selectAvailableTeam(teams, preferredId, previousId) {
  if (preferredId && teams.some((team) => team.id === preferredId)) return preferredId;
  if (previousId && teams.some((team) => team.id === previousId)) return previousId;
  return teams[0]?.id ?? '';
}

async function inventorySnapshot(teamId) {
  if (!teamId) return { installedAssistants: [] };
  return { installedAssistants: await listInstalledAssistants(teamId) };
}

function markFailure(attempt, error, fallback, clearAuthority) {
  const safe = publicError(error, fallback);
  if (attempt === generation) {
    teamContext.update((state) => ({
      ...(clearAuthority ? emptyContext() : state),
      phase: 'error',
      installedAssistants: [],
      activeAssistantIds: [],
      inventory: 'failed',
      error: safe.message,
    }));
  }
  return safe;
}

// A rename confirmed after a Team list read started wins over that read's older name. A rename answered after the
// context was cleared belongs to an earlier session and never publishes.
let renameClock = 0;
let contextEpoch = 0;
const renamedAt = new Map();
// Every Team list read from Admin advances this, so a failed reorder never rolls back over a newer list.
let listVersion = 0;
// Every admitted reorder and every order published from a save advances this, so a list re-read that began before
// either never publishes an older order or membership over it.
let orderRevision = 0;
// Team list reads are numbered as they begin; `listBarrier` is the newest read published, or the read a context load or
// clear began after. A re-read publishes only when it began after that, so of concurrent reads the newest one wins.
let listReads = 0;
let listBarrier = 0;
// A Team list change Admin announced while the context loads is read once the load ends, so it is never dropped.
let listChangedWhileLoading = null;

function withRenames(teams, since) {
  return teams.map((team) => {
    const renamed = renamedAt.get(team.id);
    return renamed && renamed.clock > since ? { ...team, name: renamed.name } : team;
  });
}

async function hydrate(preferredId, attempt, previousId = '') {
  const since = renameClock;
  const read = ++listReads;
  const [listed, catalog] = await Promise.all([
    listTeams(),
    listAssistantCatalog(),
  ]);
  const teams = withRenames(listed, since);
  const selectedTeamId = selectAvailableTeam(teams, preferredId, previousId);
  if (!selectedTeamId) {
    const snapshot = {
      teams,
      selectedTeamId: '',
      catalog,
      installedAssistants: [],
      activeAssistantIds: [],
    };
    if (attempt === generation) {
      listVersion += 1;
      listBarrier = Math.max(listBarrier, read);
      teamContext.set({
        phase: 'ready',
        ...snapshot,
        inventory: 'ready',
        error: '',
      });
    }
    return snapshot;
  }

  const inventory = await inventorySnapshot(selectedTeamId);
  const scope = chatScope(inventory.installedAssistants);
  // Re-apply renames at publication: one may have been confirmed while the inventory was loading.
  const published = withRenames(listed, since);
  if (attempt === generation) {
    listVersion += 1;
    listBarrier = Math.max(listBarrier, read);
    teamContext.set({
      phase: 'ready',
      teams: published,
      selectedTeamId,
      catalog,
      ...inventory,
      ...scope,
      inventory: 'ready',
      error: '',
    });
  }
  return { teams: published, selectedTeamId, catalog, ...inventory, ...scope };
}

export function loadTeamContext(preferredId = '') {
  return listing(loadContext(preferredId));
}

async function loadContext(preferredId) {
  const canonicalPreferredId = preferredTeamId(preferredId);
  const previousId = get(teamContext).selectedTeamId;
  const attempt = ++generation;
  listVersion += 1;
  listBarrier = ++listReads;
  teamContext.set({ ...emptyContext(), phase: 'loading', inventory: 'loading' });
  try {
    return await hydrate(canonicalPreferredId, attempt, previousId);
  } catch (error) {
    throw markFailure(attempt, error, 'The local Team context is unavailable.', true);
  }
}

export function selectTeam(id) {
  return listing(select(id));
}

async function select(id) {
  const canonicalId = preferredTeamId(id);
  const current = get(teamContext);
  if (!canonicalId || !current.teams.some((team) => team.id === canonicalId)) {
    throw new LocalApiError('Invalid local Team request.');
  }
  const attempt = ++generation;
  teamContext.set({
    ...current,
    phase: 'loading',
    selectedTeamId: canonicalId,
    installedAssistants: [],
    activeAssistantIds: [],
    inventory: 'loading',
    error: '',
  });
  try {
    const inventory = await inventorySnapshot(canonicalId);
    // The catalog is the Space's, not the Team's: a switch keeps the one this session last read, and reads it again
    // only when the selected Team has an Assistant that catalog does not name yet.
    const known = new Set(current.catalog.map((assistant) => assistant.id));
    const catalog = inventory.installedAssistants.every((entry) => known.has(entry.assistant))
      ? current.catalog
      : await listAssistantCatalog();
    const scope = chatScope(inventory.installedAssistants);
    if (attempt === generation) {
      teamContext.set({
        ...current,
        // A rename that finished during this selection already updated the list; keep it.
        teams: get(teamContext).teams,
        phase: 'ready',
        selectedTeamId: canonicalId,
        catalog,
        ...inventory,
        ...scope,
        inventory: 'ready',
        error: '',
      });
    }
    return inventory;
  } catch (error) {
    const safe = publicError(error, 'The selected Team is unavailable.');
    if (attempt === generation) {
      teamContext.set({
        ...current,
        teams: get(teamContext).teams,
        phase: 'error',
        installedAssistants: [],
        activeAssistantIds: [],
        inventory: 'failed',
        error: safe.message,
      });
    }
    throw safe;
  }
}

/**
 * Re-read the selected Team's inventory. The last one stays on display meanwhile, with the context `loading`: what
 * depends on the inventory (a message's Assistants, admitting an Assistant's request) waits for the fresh one.
 */
export async function refreshTeamInventory() {
  const epoch = contextEpoch;
  if (listOperation) await listOperation.catch(() => {});
  // A session that ended meanwhile cleared the context; the next one loads its own, so nothing is published into it.
  if (epoch !== contextEpoch) throw new LocalApiError('The local Team context changed.');
  const current = get(teamContext);
  if (!current.selectedTeamId) {
    teamContext.set({
      ...current,
      phase: 'ready',
      installedAssistants: [],
      activeAssistantIds: [],
      inventory: 'ready',
      error: '',
    });
    return { installedAssistants: [] };
  }
  if (!current.teams.some((team) => team.id === current.selectedTeamId)) {
    throw new LocalApiError('Invalid local Team request.');
  }

  const attempt = ++generation;
  teamContext.set({
    ...current,
    phase: 'loading',
    inventory: 'loading',
    error: '',
  });
  try {
    const [catalog, inventory] = await Promise.all([
      listAssistantCatalog(),
      inventorySnapshot(current.selectedTeamId),
    ]);
    const scope = chatScope(inventory.installedAssistants);
    if (attempt === generation) {
      teamContext.set({
        ...current,
        // A rename that finished during this refresh already updated the list; keep it.
        teams: get(teamContext).teams,
        phase: 'ready',
        catalog,
        ...inventory,
        ...scope,
        inventory: 'ready',
        error: '',
      });
    }
    return inventory;
  } catch (error) {
    throw markFailure(attempt, error, 'The selected Team is unavailable.', false);
  }
}

// Announced changes of the selected Team's inventory and of the Assistant registry share one read: requests within a
// short window (a reopen, an install that changes both) are read once, and those made while that read runs are read
// once more after it. Each request settles once a read that began after it has ended, whatever its outcome.
const INVENTORY_WINDOW_MS = 100;
const inventoryRead = { timer: undefined, running: false, again: false, waiters: [] };

/** Read the selected Team's inventory again soon, together with every other request; settles once it was read. */
export function requestInventoryRefresh() {
  return new Promise((resolve) => {
    inventoryRead.waiters.push(resolve);
    if (inventoryRead.running) inventoryRead.again = true;
    else if (inventoryRead.timer === undefined) inventoryRead.timer = setTimeout(readInventory, INVENTORY_WINDOW_MS);
  });
}

async function readInventory() {
  inventoryRead.timer = undefined;
  inventoryRead.running = true;
  const waiters = inventoryRead.waiters.splice(0);
  try {
    await refreshTeamInventory();
  } catch {
    // The next change or reopen reads again; whoever waited reads what the context now holds.
  } finally {
    inventoryRead.running = false;
  }
  for (const settle of waiters) settle();
  if (inventoryRead.again) {
    inventoryRead.again = false;
    inventoryRead.timer = setTimeout(readInventory, 0);
  }
}

export function clearTeamContext() {
  clearTimeout(inventoryRead.timer);
  inventoryRead.timer = undefined;
  inventoryRead.again = false;
  for (const settle of inventoryRead.waiters.splice(0)) settle();
  generation += 1;
  contextEpoch += 1;
  listVersion += 1;
  listBarrier = ++listReads;
  listChangedWhileLoading = null;
  renamedAt.clear();
  reorder.desired = null;
  reorder.baseline = null;
  teamContext.set(emptyContext());
}

export function createTeam(name) {
  return listing(create(name));
}

async function create(name) {
  // Team admits names in NFC; normalize before sending and before comparing its answer (ADR-0088).
  const canonicalName = typeof name === 'string' ? name.trim().normalize('NFC') : name;
  canonicalTeamName(canonicalName, 'Enter a valid Team name.');

  const attempt = ++generation;
  const current = get(teamContext);
  // The selected Team and its inventory stay as they are until the new Team's context is published.
  teamContext.set({
    ...current,
    phase: 'loading',
    error: '',
  });
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
    // Nothing was created: the selected Team keeps its inventory.
    const safe = publicError(error, 'The Team could not be created.');
    if (attempt === generation) teamContext.update((state) => ({ ...state, phase: 'error', error: safe.message }));
    throw safe;
  }

  try {
    await hydrate(created.id, attempt, created.id);
  } catch (error) {
    markFailure(attempt, error, 'The Team was created, but its local context could not be refreshed.', false);
  }
  return created;
}

/**
 * Rename a Team (ADR-0088): only its display name changes; its id and every Team-scoped state stay as they are. The
 * confirmed name is applied by id to whatever context is current, so a newer context keeps it and a cleared one ignores
 * it; inventory refreshes keep the latest Team list rather than the one they started from.
 */
export async function renameTeam(id, name) {
  const canonicalId = preferredTeamId(id);
  const canonicalName = typeof name === 'string' ? name.trim().normalize('NFC') : name;
  canonicalTeamName(canonicalName, 'Enter a valid Team name.');
  const current = get(teamContext);
  const target = current.teams.find((team) => team.id === canonicalId);
  if (!target || current.phase !== 'ready') throw new LocalApiError('Invalid local Team request.');
  if (target.name === canonicalName) return target;
  const epoch = contextEpoch;
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
  const renamed = { ...target, name: body.team_name };
  if (epoch !== contextEpoch) return renamed;
  renameClock += 1;
  renamedAt.set(canonicalId, { clock: renameClock, name: body.team_name });
  teamContext.update((state) => ({
    ...state,
    teams: state.teams.map((team) => (team.id === canonicalId ? { ...team, name: body.team_name } : team)),
  }));
  return renamed;
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

function applyOrder(ids) {
  teamContext.update((state) => (sameMembers(ids, state.teams) ? { ...state, teams: arranged(state.teams, ids) } : state));
}

async function putTeamOrder(ids) {
  const response = await socketReads.call('teams.reorder', { body: { team_ids: ids } });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'The Team order could not be saved.'), response.status);
  }
  const teams = parseTeamList(body, response.status);
  if (!sameMembers(ids, teams)) throw new LocalApiError('The Team order returned an invalid response.', response.status);
  return teams.map((team) => team.id);
}

/**
 * Re-read only the Team list after Admin changed it or refused an order for stale membership: the selection, catalog,
 * and inventory stay as they are unless the selected Team itself is gone, which reloads the whole context.
 */
export async function reloadTeamList() {
  const since = renameClock;
  const epoch = contextEpoch;
  const read = ++listReads;
  const revision = orderRevision;
  const listed = await listTeams();
  const current = get(teamContext);
  if (
    epoch !== contextEpoch ||
    read < listBarrier ||
    revision !== orderRevision ||
    (current.phase === 'loading' && !current.teams.length)
  ) return;
  // The selected Team is gone, or none was selected and a Team now exists (one made elsewhere, or one whose creation
  // answer was lost): the whole context loads again and opens an available Team.
  const selectedGone = current.selectedTeamId && !listed.some((team) => team.id === current.selectedTeamId);
  if (selectedGone || (!current.selectedTeamId && listed.length)) {
    await loadTeamContext('');
    return;
  }
  listVersion += 1;
  listBarrier = read;
  teamContext.set({ ...current, teams: withRenames(listed, since) });
}

function settled(phase) {
  return phase === 'ready' || phase === 'error';
}

/** Admin announced that the Team list changed: read it again now, or once the context has finished loading. */
export function teamListChanged() {
  if (!settled(get(teamContext).phase)) {
    listChangedWhileLoading = true;
    return;
  }
  reloadTeamList().catch(() => {});
}

teamContext.subscribe((state) => {
  if (!listChangedWhileLoading || !settled(state.phase)) return;
  listChangedWhileLoading = null;
  reloadTeamList().catch(() => {});
});

// Reordering is optimistic and serialized: the list moves at once, one save runs at a time, and moves made during a
// save are coalesced into the next one. `baseline` is the last order Admin confirmed, the one a failure restores.
const reorder = { desired: null, baseline: null, running: null };

async function drainTeamOrder() {
  while (reorder.desired) {
    const ids = reorder.desired;
    reorder.desired = null;
    const epoch = contextEpoch;
    const version = listVersion;
    try {
      const saved = await putTeamOrder(ids);
      // A save answered after the context cleared never publishes; an order queued since then still gets saved.
      if (epoch !== contextEpoch) continue;
      reorder.baseline = saved;
      // Admin's answer is the committed order; a move made meanwhile is applied by the next save instead.
      if (!reorder.desired) {
        orderRevision += 1;
        applyOrder(saved);
      }
    } catch (error) {
      if (epoch !== contextEpoch) continue;
      reorder.desired = null;
      // Only the order rolls back, and never over a Team list read after this save began.
      if (version === listVersion && reorder.baseline) {
        orderRevision += 1;
        applyOrder(reorder.baseline);
      }
      reorder.baseline = null;
      const safe = publicError(error, 'The Team order could not be saved.');
      // Teams were added or removed since this list was read: read it again. Not awaited, so no move made meanwhile
      // can be queued behind a save that has already given up.
      if (safe.status === 409) reloadTeamList().catch(() => {});
      throw safe;
    }
  }
  reorder.baseline = null;
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
  // The order a failure restores: the list as shown before the first queued move, also after a cleared context.
  if (!reorder.running || !reorder.baseline) reorder.baseline = current.teams.map((team) => team.id);
  reorder.desired = [...ids];
  orderRevision += 1;
  teamContext.set({ ...current, teams: arranged(current.teams, ids) });
  if (!reorder.running) {
    reorder.running = drainTeamOrder().finally(() => {
      reorder.running = null;
    });
  }
  return reorder.running;
}

export function deleteTeam(id, name, password) {
  return listing(remove(id, name, password));
}

async function remove(id, name, password) {
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

  const attempt = ++generation;
  teamContext.set({ ...current, phase: 'loading', error: '' });
  let result;
  try {
    const response = await socketReads.call('teams.delete', { team_id: canonicalId, body: { team_name: name, password } });
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
    const safe = publicError(error, 'The Team could not be deleted.');
    if (attempt === generation) teamContext.set({ ...current, phase: 'ready', error: '' });
    throw safe;
  }
  const preferredId = current.selectedTeamId === canonicalId ? '' : current.selectedTeamId;
  try {
    await hydrate(preferredId, attempt, '');
  } catch (error) {
    throw markFailure(
      attempt,
      error,
      'The Team was deleted, but the remaining Team context could not be refreshed.',
      true,
    );
  }
  return result;
}
