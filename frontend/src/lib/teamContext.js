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
const MAX_STORED_INTENT_BYTES = 16 * 1024;
const MAX_INSTALLED_ASSISTANTS = 128;
const MAX_TEAM_RESIDUE_CLASSES = 32;
const ASSISTANT_INTENT_VERSION = 2;
const ASSISTANT_INTENT_KEY_PREFIX = 'shimpz.admin.chat.assistant-intent.v2:';
const TEAM_RESIDUE_CLASS_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_SELECTED_ASSISTANTS = 16;

function emptyContext() {
  return {
    phase: 'idle',
    teams: [],
    selectedTeamId: '',
    catalog: [],
    installedAssistants: [],
    selectedAssistantIds: [],
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
      !exactKeys(parsed, ['disabled', 'version']) ||
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
      selectedAssistantIds: [],
      error: safe.message,
    }));
  }
  return safe;
}

async function hydrate(fetcher, preferredId, attempt, previousId = '') {
  const [teams, catalog] = await Promise.all([
    listTeams(fetcher),
    listAssistantCatalog(fetcher),
  ]);
  const selectedTeamId = selectAvailableTeam(teams, preferredId, previousId);
  if (!selectedTeamId) {
    const snapshot = {
      teams,
      selectedTeamId: '',
      catalog,
      installedAssistants: [],
      selectedAssistantIds: [],
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
    error: '',
  });
  try {
    const [catalog, inventory] = await Promise.all([
      listAssistantCatalog(fetcher),
      inventorySnapshot(fetcher, canonicalId),
    ]);
    const selectedAssistantIds = reconcileAssistantIntent(
      canonicalId,
      inventory.installedAssistants,
    );
    if (attempt === generation) {
      teamContext.set({
        ...current,
        phase: 'ready',
        selectedTeamId: canonicalId,
        catalog,
        ...inventory,
        selectedAssistantIds,
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
    selectedAssistantIds: [],
    error: '',
  });
  try {
    const [catalog, inventory] = await Promise.all([
      listAssistantCatalog(fetcher),
      inventorySnapshot(fetcher, current.selectedTeamId),
    ]);
    const selectedAssistantIds = reconcileAssistantIntent(
      current.selectedTeamId,
      inventory.installedAssistants,
    );
    if (attempt === generation) {
      teamContext.set({
        ...current,
        phase: 'ready',
        catalog,
        ...inventory,
        selectedAssistantIds,
        error: '',
      });
    }
    return inventory;
  } catch (error) {
    throw markFailure(attempt, error, 'The selected Team is unavailable.', false);
  }
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
