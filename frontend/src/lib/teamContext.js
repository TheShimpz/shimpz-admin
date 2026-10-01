import { get, writable } from 'svelte/store';

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
// The chat protocol admits at most this many Assistants in one turn's capability scope.
export const MAX_CHAT_ASSISTANTS = 16;

function emptyContext() {
  return {
    phase: 'idle',
    teams: [],
    selectedTeamId: '',
    catalog: [],
    installedAssistants: [],
    activeAssistantIds: [],
    omittedAssistantIds: [],
    error: '',
  };
}

export const teamContext = writable(emptyContext());

let generation = 0;
function chatScope(installedAssistants) {
  // Every running Assistant joins the chat in inventory order; any beyond the protocol bound is reported as omitted.
  const running = installedAssistants
    .filter((entry) => entry.status === 'running')
    .map((entry) => entry.assistant);
  return {
    activeAssistantIds: running.slice(0, MAX_CHAT_ASSISTANTS),
    omittedAssistantIds: running.slice(MAX_CHAT_ASSISTANTS),
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

function requireFetcher(fetcher) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid local Team request.');
}

function preferredTeamId(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !TEAM_ID_RE.test(value)) {
    throw new LocalApiError('Invalid local Team request.');
  }
  return value;
}

async function listTeams(fetcher) {
  requireFetcher(fetcher);
  const response = await fetcher('/api/teams', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'The local Team inventory is unavailable.'), response.status);
  }
  return parseTeamList(body, response.status);
}

// GET /api/teams and PUT /api/teams/order answer the same closed list, already in the Supervisor's display order.
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

async function inventorySnapshot(fetcher, teamId) {
  if (!teamId) return { installedAssistants: [] };
  return { installedAssistants: await listInstalledAssistants(fetcher, teamId) };
}

function markFailure(attempt, error, fallback, clearAuthority) {
  const safe = publicError(error, fallback);
  if (attempt === generation) {
    teamContext.update((state) => ({
      ...(clearAuthority ? emptyContext() : state),
      phase: 'error',
      installedAssistants: [],
      activeAssistantIds: [],
      omittedAssistantIds: [],
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

function withRenames(teams, since) {
  return teams.map((team) => {
    const renamed = renamedAt.get(team.id);
    return renamed && renamed.clock > since ? { ...team, name: renamed.name } : team;
  });
}

async function hydrate(fetcher, preferredId, attempt, previousId = '') {
  const since = renameClock;
  const [listed, catalog] = await Promise.all([
    listTeams(fetcher),
    listAssistantCatalog(fetcher),
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
      omittedAssistantIds: [],
    };
    if (attempt === generation) {
      listVersion += 1;
      teamContext.set({
        phase: 'ready',
        ...snapshot,
        error: '',
      });
    }
    return snapshot;
  }

  const inventory = await inventorySnapshot(fetcher, selectedTeamId);
  const scope = chatScope(inventory.installedAssistants);
  // Re-apply renames at publication: one may have been confirmed while the inventory was loading.
  const published = withRenames(listed, since);
  if (attempt === generation) {
    listVersion += 1;
    teamContext.set({
      phase: 'ready',
      teams: published,
      selectedTeamId,
      catalog,
      ...inventory,
      ...scope,
      error: '',
    });
  }
  return { teams: published, selectedTeamId, catalog, ...inventory, ...scope };
}

export async function loadTeamContext(fetcher, preferredId = '') {
  requireFetcher(fetcher);
  const canonicalPreferredId = preferredTeamId(preferredId);
  const previousId = get(teamContext).selectedTeamId;
  const attempt = ++generation;
  listVersion += 1;
  teamContext.set({ ...emptyContext(), phase: 'loading' });
  try {
    return await hydrate(fetcher, canonicalPreferredId, attempt, previousId);
  } catch (error) {
    throw markFailure(attempt, error, 'The local Team context is unavailable.', true);
  }
}

export async function selectTeam(fetcher, id) {
  requireFetcher(fetcher);
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
    omittedAssistantIds: [],
    error: '',
  });
  try {
    const [catalog, inventory] = await Promise.all([
      listAssistantCatalog(fetcher),
      inventorySnapshot(fetcher, canonicalId),
    ]);
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
        omittedAssistantIds: [],
        error: safe.message,
      });
    }
    throw safe;
  }
}

export async function refreshTeamInventory(fetcher) {
  requireFetcher(fetcher);
  const current = get(teamContext);
  if (!current.selectedTeamId) {
    teamContext.set({
      ...current,
      phase: 'ready',
      installedAssistants: [],
      activeAssistantIds: [],
      omittedAssistantIds: [],
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
    installedAssistants: [],
    activeAssistantIds: [],
    omittedAssistantIds: [],
    error: '',
  });
  try {
    const [catalog, inventory] = await Promise.all([
      listAssistantCatalog(fetcher),
      inventorySnapshot(fetcher, current.selectedTeamId),
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
        error: '',
      });
    }
    return inventory;
  } catch (error) {
    throw markFailure(attempt, error, 'The selected Team is unavailable.', false);
  }
}

export function clearTeamContext() {
  generation += 1;
  contextEpoch += 1;
  listVersion += 1;
  renamedAt.clear();
  reorder.desired = null;
  reorder.baseline = null;
  teamContext.set(emptyContext());
}

export async function createTeam(fetcher, name) {
  requireFetcher(fetcher);
  // Team admits names in NFC; normalize before sending and before comparing its answer (ADR-0088).
  const canonicalName = typeof name === 'string' ? name.trim().normalize('NFC') : name;
  canonicalTeamName(canonicalName, 'Enter a valid Team name.');

  const attempt = ++generation;
  const current = get(teamContext);
  teamContext.set({
    ...current,
    phase: 'loading',
    error: '',
    activeAssistantIds: [],
    omittedAssistantIds: [],
  });
  let created;
  try {
    const response = await fetcher('/api/teams', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_name: canonicalName }),
    });
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
    throw markFailure(attempt, error, 'The Team could not be created.', false);
  }

  try {
    await hydrate(fetcher, created.id, attempt, created.id);
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
export async function renameTeam(fetcher, id, name) {
  requireFetcher(fetcher);
  const canonicalId = preferredTeamId(id);
  const canonicalName = typeof name === 'string' ? name.trim().normalize('NFC') : name;
  canonicalTeamName(canonicalName, 'Enter a valid Team name.');
  const current = get(teamContext);
  const target = current.teams.find((team) => team.id === canonicalId);
  if (!target || current.phase !== 'ready') throw new LocalApiError('Invalid local Team request.');
  if (target.name === canonicalName) return target;
  const epoch = contextEpoch;
  const response = await fetcher(`/api/teams/${encodeURIComponent(canonicalId)}`, {
    method: 'PATCH',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_name: canonicalName }),
  });
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

async function putTeamOrder(fetcher, ids) {
  const response = await fetcher('/api/teams/order', {
    method: 'PUT',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_ids: ids }),
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'The Team order could not be saved.'), response.status);
  }
  const teams = parseTeamList(body, response.status);
  if (!sameMembers(ids, teams)) throw new LocalApiError('The Team order returned an invalid response.', response.status);
  return teams.map((team) => team.id);
}

/**
 * Re-read only the Team list after Admin refused an order for stale membership: the selection, catalog, and inventory
 * stay as they are unless the selected Team itself is gone, which reloads the whole context.
 */
export async function reloadTeamList(fetcher) {
  requireFetcher(fetcher);
  const since = renameClock;
  const epoch = contextEpoch;
  const version = listVersion;
  const revision = orderRevision;
  const listed = await listTeams(fetcher);
  const current = get(teamContext);
  if (
    epoch !== contextEpoch ||
    version !== listVersion ||
    revision !== orderRevision ||
    (current.phase === 'loading' && !current.teams.length)
  ) return;
  if (current.selectedTeamId && !listed.some((team) => team.id === current.selectedTeamId)) {
    await loadTeamContext(fetcher, '');
    return;
  }
  listVersion += 1;
  teamContext.set({ ...current, teams: withRenames(listed, since) });
}

// Reordering is optimistic and serialized: the list moves at once, one save runs at a time, and moves made during a
// save are coalesced into the next one. `baseline` is the last order Admin confirmed, the one a failure restores.
const reorder = { desired: null, baseline: null, running: null };

async function drainTeamOrder(fetcher) {
  while (reorder.desired) {
    const ids = reorder.desired;
    reorder.desired = null;
    const epoch = contextEpoch;
    const version = listVersion;
    try {
      const saved = await putTeamOrder(fetcher, ids);
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
      if (safe.status === 409) reloadTeamList(fetcher).catch(() => {});
      throw safe;
    }
  }
  reorder.baseline = null;
}

/** Show the Teams in `ids` order now and save it; the promise settles when every queued order has been saved. */
export function reorderTeams(fetcher, ids) {
  requireFetcher(fetcher);
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
    reorder.running = drainTeamOrder(fetcher).finally(() => {
      reorder.running = null;
    });
  }
  return reorder.running;
}

export async function deleteTeam(fetcher, id, name, password) {
  requireFetcher(fetcher);
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
    const response = await fetcher(`/api/teams/${encodeURIComponent(canonicalId)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_name: name, password }),
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
    const safe = publicError(error, 'The Team could not be deleted.');
    if (attempt === generation) teamContext.set({ ...current, phase: 'ready', error: '' });
    throw safe;
  }
  const preferredId = current.selectedTeamId === canonicalId ? '' : current.selectedTeamId;
  try {
    await hydrate(fetcher, preferredId, attempt, '');
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
