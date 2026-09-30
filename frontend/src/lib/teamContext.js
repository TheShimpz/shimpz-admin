import { get, writable } from 'svelte/store';

import { listAssistantCatalog, listInstalledAssistants, LocalApiError, safeApiError } from './localApi.js';
import {
  ASSISTANT_ID_RE,
  canonicalTeamName,
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
  if (
    !hasExactEnvelopeKeys(body, ['teams']) ||
    !Array.isArray(body.teams) ||
    body.teams.length > MAX_TEAMS
  ) {
    throw new LocalApiError('The local Team inventory is invalid.', response.status);
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
      throw new LocalApiError('The local Team inventory is invalid.', response.status);
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

// A rename confirmed after a Team list read started wins over that read's older name.
let renameClock = 0;
const renamedAt = new Map();

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
  renamedAt.clear();
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
  renameClock += 1;
  renamedAt.set(canonicalId, { clock: renameClock, name: body.team_name });
  teamContext.update((state) => ({
    ...state,
    teams: state.teams.map((team) => (team.id === canonicalId ? { ...team, name: body.team_name } : team)),
  }));
  return renamed;
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
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_CHARS) {
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
