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
const MAX_STORED_INTENT_BYTES = 16 * 1024;
const MAX_INSTALLED_ASSISTANTS = 128;
const ASSISTANT_INTENT_VERSION = 2;
const ASSISTANT_INTENT_KEY_PREFIX = 'shimpz.admin.chat.assistant-intent.v2:';
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
const assistantIntents = new Map();

function intentStorage() {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function intentStorageKey(teamId) {
  return `${ASSISTANT_INTENT_KEY_PREFIX}${teamId}`;
}

function readStoredAssistantIntent(teamId) {
  const storage = intentStorage();
  if (!storage) return undefined;
  const key = intentStorageKey(teamId);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    if (raw.length > MAX_STORED_INTENT_BYTES) throw new Error('oversized preference');
    const parsed = JSON.parse(raw);
    if (
      !hasExactKeys(parsed, ['disabled', 'version']) ||
      parsed.version !== ASSISTANT_INTENT_VERSION ||
      !Array.isArray(parsed.disabled) ||
      parsed.disabled.length > MAX_INSTALLED_ASSISTANTS ||
      parsed.disabled.some((id) => typeof id !== 'string' || id.length > 80 || !ASSISTANT_ID_RE.test(id)) ||
      new Set(parsed.disabled).size !== parsed.disabled.length
    ) {
      throw new Error('invalid preference');
    }
    return { disabled: [...parsed.disabled] };
  } catch {
    try { storage.removeItem(key); } catch { /* Session preferences are best-effort only. */ }
    return undefined;
  }
}

function writeStoredAssistantIntent(teamId, intent) {
  const storage = intentStorage();
  if (!storage) return;
  try {
    storage.setItem(intentStorageKey(teamId), JSON.stringify({
      version: ASSISTANT_INTENT_VERSION,
      disabled: intent.disabled,
    }));
  } catch {
    // Chat scope stays correct in memory when browser session storage is unavailable.
  }
}

function clearStoredAssistantIntent(teamId) {
  assistantIntents.delete(teamId);
  const storage = intentStorage();
  if (!storage) return;
  try {
    storage.removeItem(intentStorageKey(teamId));
  } catch {
    // Deletion remains authoritative when browser session storage is unavailable.
  }
}

function runningAssistantIds(installedAssistants) {
  return installedAssistants
    .filter((entry) => entry.status === 'running')
    .map((entry) => entry.assistant);
}

function activeAssistantIds(installedAssistants, disabled) {
  const blocked = new Set(disabled);
  return runningAssistantIds(installedAssistants)
    .filter((id) => !blocked.has(id))
    .slice(0, MAX_SELECTED_ASSISTANTS);
}

function reconcileAssistantIntent(teamId, installedAssistants) {
  const installed = new Set(installedAssistants.map((entry) => entry.assistant));
  const remembered = assistantIntents.has(teamId)
    ? assistantIntents.get(teamId)
    : readStoredAssistantIntent(teamId);
  // Absence means enabled. This distinguishes explicit user choice from temporary runtime state:
  // outdated/stopped Assistants remain intended, while a confirmed uninstall removes old intent.
  const intent = {
    disabled: (remembered?.disabled ?? []).filter((id) => installed.has(id)),
  };
  assistantIntents.set(teamId, intent);
  writeStoredAssistantIntent(teamId, intent);
  return activeAssistantIds(installedAssistants, intent.disabled);
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
  const selectedAssistantIds = reconcileAssistantIntent(
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
    const selectedAssistantIds = reconcileAssistantIntent(
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
    const selectedAssistantIds = reconcileAssistantIntent(
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

function updateAssistantIntent(project) {
  let changed = false;
  teamContext.update((state) => {
    if (!state.selectedTeamId || state.phase !== 'ready') return state;
    const installed = state.installedAssistants.map((entry) => entry.assistant);
    const running = runningAssistantIds(state.installedAssistants);
    const current = assistantIntents.get(state.selectedTeamId) ?? { disabled: [] };
    const nextDisabled = project(installed, running, current.disabled, state.selectedAssistantIds);
    if (
      !Array.isArray(nextDisabled) ||
      nextDisabled.length > MAX_INSTALLED_ASSISTANTS ||
      nextDisabled.some((id) => !installed.includes(id)) ||
      new Set(nextDisabled).size !== nextDisabled.length
    ) return state;
    const nextIntent = { disabled: [...nextDisabled] };
    const nextSelected = activeAssistantIds(state.installedAssistants, nextIntent.disabled);
    const intentChanged = (
      nextIntent.disabled.length !== current.disabled.length
      || nextIntent.disabled.some((id, index) => id !== current.disabled[index])
    );
    const selectionChanged = (
      nextSelected.length !== state.selectedAssistantIds.length
      || nextSelected.some((id, index) => id !== state.selectedAssistantIds[index])
    );
    if (!intentChanged && !selectionChanged) return state;
    assistantIntents.set(state.selectedTeamId, nextIntent);
    writeStoredAssistantIntent(state.selectedTeamId, nextIntent);
    changed = true;
    return { ...state, selectedAssistantIds: nextSelected };
  });
  return changed;
}

export function toggleTeamAssistant(id) {
  return updateAssistantIntent((_installed, running, disabled, selected) => {
    if (!running.includes(id)) return disabled;
    if (disabled.includes(id)) {
      if (selected.length >= MAX_SELECTED_ASSISTANTS) return disabled;
      return disabled.filter((assistantId) => assistantId !== id);
    }
    return selected.includes(id) ? [...disabled, id] : disabled;
  });
}

export function selectAllTeamAssistants() {
  return updateAssistantIntent((installed, running) => {
    const enabled = new Set(running.slice(0, MAX_SELECTED_ASSISTANTS));
    return installed.filter((id) => !enabled.has(id));
  });
}

export function unselectAllTeamAssistants() {
  return updateAssistantIntent((installed) => [...installed]);
}

export function selectOnlyTeamAssistant(id) {
  return updateAssistantIntent((installed, running, disabled) => (
    running.includes(id) ? installed.filter((assistantId) => assistantId !== id) : disabled
  ));
}

export function clearTeamContext() {
  generation += 1;
  assistantIntents.clear();
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

  clearStoredAssistantIntent(canonicalId);
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
