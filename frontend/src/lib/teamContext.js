import { get, writable } from 'svelte/store';

import { listAssistantCatalog, listInstalledAssistants, LocalApiError, safeApiError } from './localApi.js';
import { listTeamFiles } from './localChat.js';

const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ASSISTANT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_TEAMS = 128;
const MAX_TEAM_NAME_CHARS = 80;
const MAX_ADMIN_PASSWORD_CHARS = 4096;
const MAX_SELECTED_FILES = 8;
const MAX_STORED_SELECTION_BYTES = 4096;
const ASSISTANT_SELECTION_KEY_PREFIX = 'shimpz.admin.chat.assistants.v1:';
export const MAX_SELECTED_ASSISTANTS = 16;

function emptyContext() {
  return {
    phase: 'idle',
    teams: [],
    selectedTeamId: '',
    catalog: [],
    installedAssistants: [],
    selectedAssistantIds: [],
    files: [],
    selectedFileIds: [],
    error: '',
  };
}

export const teamContext = writable(emptyContext());

let generation = 0;
const assistantSelections = new Map();

function selectionStorage() {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function selectionStorageKey(teamId) {
  return `${ASSISTANT_SELECTION_KEY_PREFIX}${teamId}`;
}

function readStoredAssistantSelection(teamId) {
  const storage = selectionStorage();
  if (!storage) return undefined;
  const key = selectionStorageKey(teamId);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    if (raw.length > MAX_STORED_SELECTION_BYTES) throw new Error('oversized preference');
    const parsed = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_SELECTED_ASSISTANTS ||
      parsed.some((id) => typeof id !== 'string' || id.length > 80 || !ASSISTANT_ID_RE.test(id)) ||
      new Set(parsed).size !== parsed.length
    ) {
      throw new Error('invalid preference');
    }
    return parsed;
  } catch {
    try { storage.removeItem(key); } catch { /* Session preferences are best-effort only. */ }
    return undefined;
  }
}

function writeStoredAssistantSelection(teamId, selected) {
  const storage = selectionStorage();
  if (!storage) return;
  try {
    storage.setItem(selectionStorageKey(teamId), JSON.stringify(selected));
  } catch {
    // Chat scope stays correct in memory when browser session storage is unavailable.
  }
}

function clearStoredAssistantSelection(teamId) {
  assistantSelections.delete(teamId);
  const storage = selectionStorage();
  if (!storage) return;
  try {
    storage.removeItem(selectionStorageKey(teamId));
  } catch {
    // Deletion remains authoritative when browser session storage is unavailable.
  }
}

function runningAssistantIds(installedAssistants) {
  return installedAssistants
    .filter((entry) => entry.status === 'running')
    .map((entry) => entry.assistant);
}

function reconcileAssistantSelection(teamId, installedAssistants) {
  const running = runningAssistantIds(installedAssistants);
  const allowed = new Set(running);
  const remembered = assistantSelections.has(teamId)
    ? assistantSelections.get(teamId)
    : readStoredAssistantSelection(teamId);
  const selected = remembered === undefined
    ? running.slice(0, MAX_SELECTED_ASSISTANTS)
    : remembered.filter((id) => allowed.has(id));
  assistantSelections.set(teamId, selected);
  writeStoredAssistantSelection(teamId, selected);
  return [...selected];
}

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
      !hasExactKeys(team, ['status', 'team_id', 'team_name']) ||
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
      selectedAssistantIds: [],
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
      selectedAssistantIds: [],
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
  const selectedAssistantIds = reconcileAssistantSelection(
    selectedTeamId,
    inventory.installedAssistants,
  );
  if (attempt === generation) {
    teamContext.set({
      phase: 'ready',
      teams,
      selectedTeamId,
      catalog,
      ...inventory,
      selectedAssistantIds,
      selectedFileIds: [],
      error: '',
    });
  }
  return { teams, selectedTeamId, catalog, ...inventory, selectedAssistantIds };
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
    selectedAssistantIds: [],
    files: [],
    selectedFileIds: [],
    error: '',
  });
  try {
    const inventory = await inventorySnapshot(fetcher, canonicalId, current.catalog);
    const selectedAssistantIds = reconcileAssistantSelection(
      canonicalId,
      inventory.installedAssistants,
    );
    if (attempt === generation) {
      teamContext.set({
        ...current,
        phase: 'ready',
        selectedTeamId: canonicalId,
        ...inventory,
        selectedAssistantIds,
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
        selectedAssistantIds: [],
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
      selectedAssistantIds: [],
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
    selectedAssistantIds: [],
    files: [],
    selectedFileIds: [],
    error: '',
  });
  try {
    const inventory = await inventorySnapshot(fetcher, current.selectedTeamId, current.catalog);
    const selectedAssistantIds = reconcileAssistantSelection(
      current.selectedTeamId,
      inventory.installedAssistants,
    );
    if (attempt === generation) {
      teamContext.set({
        ...current,
        phase: 'ready',
        ...inventory,
        selectedAssistantIds,
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

function updateAssistantSelection(project) {
  let changed = false;
  teamContext.update((state) => {
    if (!state.selectedTeamId || state.phase !== 'ready') return state;
    const running = runningAssistantIds(state.installedAssistants);
    const next = project(running, state.selectedAssistantIds);
    if (
      !Array.isArray(next) ||
      next.length > MAX_SELECTED_ASSISTANTS ||
      next.some((id) => !running.includes(id)) ||
      new Set(next).size !== next.length
    ) return state;
    if (
      next.length === state.selectedAssistantIds.length &&
      next.every((id, index) => id === state.selectedAssistantIds[index])
    ) return state;
    assistantSelections.set(state.selectedTeamId, [...next]);
    writeStoredAssistantSelection(state.selectedTeamId, next);
    changed = true;
    return { ...state, selectedAssistantIds: [...next] };
  });
  return changed;
}

export function toggleTeamAssistant(id) {
  return updateAssistantSelection((running, selected) => {
    if (!running.includes(id)) return selected;
    return selected.includes(id)
      ? selected.filter((assistantId) => assistantId !== id)
      : [...selected, id];
  });
}

export function selectAllTeamAssistants() {
  return updateAssistantSelection((running) => running.slice(0, MAX_SELECTED_ASSISTANTS));
}

export function unselectAllTeamAssistants() {
  return updateAssistantSelection(() => []);
}

export function selectOnlyTeamAssistant(id) {
  return updateAssistantSelection((running, selected) => (
    running.includes(id) ? [id] : selected
  ));
}

export function clearTeamContext() {
  generation += 1;
  assistantSelections.clear();
  teamContext.set(emptyContext());
}

export async function createTeam(fetcher, name) {
  requireFetcher(fetcher);
  const canonicalName = typeof name === 'string' ? name.trim() : name;
  canonicalTeamName(canonicalName, 'Enter a valid Team name.');

  const attempt = ++generation;
  const current = get(teamContext);
  teamContext.set({
    ...current,
    phase: 'loading',
    error: '',
    selectedAssistantIds: [],
    selectedFileIds: [],
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
  if (typeof password !== 'string' || !password || password.length > MAX_ADMIN_PASSWORD_CHARS) {
    throw new LocalApiError('Enter the current Admin password.');
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
      !hasExactEnvelopeKeys(body, ['assistants_removed', 'destroyed', 'storage_removed', 'team_id']) ||
      body.team_id !== canonicalId ||
      typeof body.destroyed !== 'boolean' ||
      !Number.isSafeInteger(body.assistants_removed) ||
      body.assistants_removed < 0 ||
      typeof body.storage_removed !== 'boolean'
    ) {
      throw new LocalApiError('The Team deletion returned an invalid response.', response.status);
    }
    result = {
      teamId: body.team_id,
      destroyed: body.destroyed,
      assistantsRemoved: body.assistants_removed,
      storageRemoved: body.storage_removed,
    };
  } catch (error) {
    const safe = publicError(error, 'The Team could not be deleted.');
    if (attempt === generation) teamContext.set({ ...current, phase: 'ready', error: '' });
    throw safe;
  }

  clearStoredAssistantSelection(canonicalId);
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
