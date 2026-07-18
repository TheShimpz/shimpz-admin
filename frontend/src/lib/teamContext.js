import { get, writable } from 'svelte/store';

import { listAssistantCatalog, listInstalledAssistants, LocalApiError, safeApiError } from './localApi.js';
import { listTeamFiles } from './localChat.js';

const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_TEAMS = 128;
const MAX_TEAM_NAME_CHARS = 80;
const MAX_SELECTED_FILES = 8;

function emptyContext() {
  return {
    phase: 'idle',
    teams: [],
    selectedTeamId: '',
    catalog: [],
    installedAssistants: [],
    files: [],
    selectedFileIds: [],
    error: '',
  };
}

export const teamContext = writable(emptyContext());

let generation = 0;

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => key === actual[index]);
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

async function jsonObject(response) {
  const body = await response.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function publicError(error, fallback) {
  if (error instanceof LocalApiError && error.message && error.message.length <= 300) return error;
  return new LocalApiError(fallback);
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

function canonicalTeamName(value, message = 'The local Team inventory is invalid.') {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > MAX_TEAM_NAME_CHARS ||
    CONTROL_RE.test(value)
  ) {
    throw new LocalApiError(message);
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
      !hasExactKeys(team, ['id', 'name', 'status']) ||
      typeof team.id !== 'string' ||
      !TEAM_ID_RE.test(team.id) ||
      team.status !== 'running' ||
      seen.has(team.id)
    ) {
      throw new LocalApiError('The local Team inventory is invalid.', response.status);
    }
    canonicalTeamName(team.name);
    seen.add(team.id);
    return { id: team.id, name: team.name, status: team.status };
  });
}

function selectAvailableTeam(teams, preferredId, previousId) {
  if (preferredId && teams.some((team) => team.id === preferredId)) return preferredId;
  if (previousId && teams.some((team) => team.id === previousId)) return previousId;
  return teams[0]?.id ?? '';
}

async function inventorySnapshot(fetcher, teamId, catalog) {
  if (!teamId) return { installedAssistants: [], files: [] };
  const [installedAssistants, files] = await Promise.all([
    listInstalledAssistants(fetcher, teamId),
    listTeamFiles(fetcher, teamId),
  ]);
  const catalogIds = new Set(catalog.map((assistant) => assistant.id));
  if (installedAssistants.some((entry) => !catalogIds.has(entry.assistant))) {
    throw new LocalApiError('The installed Assistant inventory is invalid.');
  }
  if (new Set(files.map((file) => file.id)).size !== files.length) {
    throw new LocalApiError('Team file inventory is invalid.');
  }
  return { installedAssistants, files };
}

function markFailure(attempt, error, fallback, clearAuthority) {
  const safe = publicError(error, fallback);
  if (attempt === generation) {
    teamContext.update((state) => ({
      ...(clearAuthority ? emptyContext() : state),
      phase: 'error',
      installedAssistants: [],
      files: [],
      selectedFileIds: [],
      error: safe.message,
    }));
  }
  return safe;
}

async function hydrate(fetcher, preferredId, attempt, previousId = '') {
  const teams = await listTeams(fetcher);
  const selectedTeamId = selectAvailableTeam(teams, preferredId, previousId);
  if (!selectedTeamId) {
    const snapshot = {
      teams,
      selectedTeamId: '',
      catalog: [],
      installedAssistants: [],
      files: [],
    };
    if (attempt === generation) {
      teamContext.set({
        phase: 'ready',
        ...snapshot,
        selectedFileIds: [],
        error: '',
      });
    }
    return snapshot;
  }

  const catalog = await listAssistantCatalog(fetcher);
  const inventory = await inventorySnapshot(fetcher, selectedTeamId, catalog);
  if (attempt === generation) {
    teamContext.set({
      phase: 'ready',
      teams,
      selectedTeamId,
      catalog,
      ...inventory,
      selectedFileIds: [],
      error: '',
    });
  }
  return { teams, selectedTeamId, catalog, ...inventory };
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

export async function refreshTeams(fetcher, preferredId = '') {
  requireFetcher(fetcher);
  const canonicalPreferredId = preferredTeamId(preferredId);
  const current = get(teamContext);
  const attempt = ++generation;
  teamContext.set({ ...current, phase: 'loading', error: '', selectedFileIds: [] });
  try {
    return await hydrate(fetcher, canonicalPreferredId, attempt, current.selectedTeamId);
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
    files: [],
    selectedFileIds: [],
    error: '',
  });
  try {
    const inventory = await inventorySnapshot(fetcher, canonicalId, current.catalog);
    if (attempt === generation) {
      teamContext.set({
        ...current,
        phase: 'ready',
        selectedTeamId: canonicalId,
        ...inventory,
        selectedFileIds: [],
        error: '',
      });
    }
    return inventory;
  } catch (error) {
    const safe = publicError(error, 'The selected Team is unavailable.');
    if (attempt === generation) {
      teamContext.set({
        ...current,
        phase: 'error',
        installedAssistants: [],
        files: [],
        selectedFileIds: [],
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
      files: [],
      selectedFileIds: [],
      error: '',
    });
    return { installedAssistants: [], files: [] };
  }
  if (!current.teams.some((team) => team.id === current.selectedTeamId)) {
    throw new LocalApiError('Invalid local Team request.');
  }

  const attempt = ++generation;
  teamContext.set({
    ...current,
    phase: 'loading',
    installedAssistants: [],
    files: [],
    selectedFileIds: [],
    error: '',
  });
  try {
    const inventory = await inventorySnapshot(fetcher, current.selectedTeamId, current.catalog);
    if (attempt === generation) {
      teamContext.set({
        ...current,
        phase: 'ready',
        ...inventory,
        selectedFileIds: [],
        error: '',
      });
    }
    return inventory;
  } catch (error) {
    throw markFailure(attempt, error, 'The selected Team is unavailable.', false);
  }
}

export function toggleTeamFile(id) {
  let changed = false;
  teamContext.update((state) => {
    if (!state.files.some((file) => file.id === id)) return state;
    if (state.selectedFileIds.includes(id)) {
      changed = true;
      return { ...state, selectedFileIds: state.selectedFileIds.filter((fileId) => fileId !== id) };
    }
    if (state.selectedFileIds.length >= MAX_SELECTED_FILES) return state;
    changed = true;
    return { ...state, selectedFileIds: [...state.selectedFileIds, id] };
  });
  return changed;
}

export function clearTeamContext() {
  generation += 1;
  teamContext.set(emptyContext());
}

export async function createTeam(fetcher, name) {
  requireFetcher(fetcher);
  const canonicalName = typeof name === 'string' ? name.trim() : name;
  canonicalTeamName(canonicalName, 'Enter a valid Team name.');

  const attempt = ++generation;
  const current = get(teamContext);
  teamContext.set({ ...current, phase: 'loading', error: '', selectedFileIds: [] });
  let created;
  try {
    const response = await fetcher('/api/teams', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: canonicalName }),
    });
    const body = await jsonObject(response);
    if (!response.ok) {
      throw new LocalApiError(safeApiError(body, 'The Team could not be created.'), response.status);
    }
    if (
      !hasExactEnvelopeKeys(body, ['created', 'id', 'name', 'status']) ||
      typeof body.created !== 'boolean' ||
      typeof body.id !== 'string' ||
      !TEAM_ID_RE.test(body.id) ||
      body.name !== canonicalName ||
      body.status !== 'running'
    ) {
      throw new LocalApiError('The Team creation returned an invalid response.', response.status);
    }
    canonicalTeamName(body.name, 'The Team creation returned an invalid response.');
    created = { created: body.created, id: body.id, name: body.name, status: body.status };
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
