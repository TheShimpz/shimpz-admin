import { get, writable } from 'svelte/store';

import { LocalApiError } from './localApi.js';
import {
  listModelProviders,
  loadInference,
  saveModelSetup,
} from './modelProviders.js';
import { publicError, TEAM_ID_RE } from './validate.js';

function emptyContext() {
  return {
    phase: 'idle',
    teamId: '',
    providers: [],
    provider: '',
    model: '',
    ready: false,
    error: '',
  };
}

export const modelContext = writable(emptyContext());

let generation = 0;
// Bumped only when the session clears: Team views change `generation`, but a saved key belongs to the session.
let sessionEpoch = 0;
let providerCatalogCache = null;
let providerCatalogRequest = null;
// The active Team view's persisted inference, as last loaded or saved by that view; null when it has none.
let persisted = null;
// A key save whose answer was lost may have stored the key. Keys are the Space's, not a Team view's, so whichever view
// shows next reads the providers again, instead of the cached state the lost save may have changed.
let providersUncertain = false;

function cachedModelProviders() {
  if (providersUncertain) {
    providersUncertain = false;
    providerCatalogCache = null;
    providerCatalogRequest = null;
  }
  if (providerCatalogCache) return Promise.resolve(providerCatalogCache);
  if (providerCatalogRequest) return providerCatalogRequest;
  const request = listModelProviders()
    .then((providers) => {
      if (providerCatalogRequest === request) providerCatalogCache = providers;
      return providers;
    })
    .finally(() => {
      if (providerCatalogRequest === request) providerCatalogRequest = null;
    });
  providerCatalogRequest = request;
  return request;
}

function requireRequest(teamId) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid Team model request.');
  }
}

function providerFrom(state, providerId = state.provider) {
  return state.providers.find((entry) => entry.id === providerId) ?? null;
}

function selectedModel(provider, modelId) {
  return provider?.models.find((entry) => entry.id === modelId) ?? null;
}

function persistedAndConfigured(state, provider) {
  return Boolean(
    provider?.configured &&
    persisted?.teamId === state.teamId &&
    persisted.provider === state.provider &&
    persisted.model === state.model,
  );
}

// The active Team view always shows the session's shared provider state and keeps its own selection. A provider
// configured by another Team view's save opens this Team only when its selection is the one it has persisted.
function reconcile(state) {
  if (!providerCatalogCache) return state;
  const provider = providerCatalogCache.find((entry) => entry.id === state.provider);
  return {
    ...state,
    providers: providerCatalogCache,
    ready: state.ready || persistedAndConfigured(state, provider),
  };
}

// Applies a finished load or save only while it is still the current attempt, recording what that Team persisted.
function settle(attempt, snapshot, saved) {
  if (attempt !== generation) return snapshot;
  if (saved) {
    persisted = { teamId: snapshot.teamId, provider: saved.provider, model: saved.model };
  }
  const settled = reconcile(snapshot);
  modelContext.set(settled);
  return settled;
}

// A failed view keeps the failure's code beside its message: `outcome-unknown` when a save's answer was lost with
// Admin's connection.
function fail(attempt, error, state) {
  const safe = publicError(error, 'The Team model settings are unavailable.');
  if (attempt === generation) {
    modelContext.set({ ...state, phase: 'error', ready: false, error: safe.message, errorCode: safe.code ?? '' });
  }
  return safe;
}

export function clearModelContext() {
  generation += 1;
  sessionEpoch += 1;
  providerCatalogCache = null;
  providerCatalogRequest = null;
  providersUncertain = false;
  persisted = null;
  modelContext.set(emptyContext());
}

export function preloadModelProviders() {
  return cachedModelProviders();
}

export async function loadModelContext(teamId) {
  requireRequest(teamId);
  const attempt = ++generation;
  persisted = null;
  const loading = { ...emptyContext(), phase: 'loading', teamId };
  modelContext.set(loading);
  try {
    const [providers, inference] = await Promise.all([
      cachedModelProviders(),
      loadInference(teamId),
    ]);
    const selected = inference
      ? providers.find((entry) => entry.id === inference.provider)
      : providers.find((entry) => entry.configured) ?? providers[0];
    if (!selected) throw new LocalApiError('Model provider settings are invalid.');
    const model = inference?.model ?? selected.default_model;
    if (!selectedModel(selected, model)) throw new LocalApiError('Team model settings are invalid.');
    let selectionReady = Boolean(inference && selected.configured);
    if (!inference && selected.configured) {
      await saveModelSetup(
        teamId,
        { provider: selected.id, model, apiKey: '' },
        providers,
      );
      selectionReady = true;
    }
    const snapshot = {
      phase: 'ready',
      teamId,
      providers,
      provider: selected.id,
      model,
      ready: selectionReady,
      error: '',
    };
    return settle(attempt, snapshot, inference ?? (selectionReady ? { provider: selected.id, model } : null));
  } catch (error) {
    throw fail(attempt, error, loading);
  }
}

async function persist(teamId, apiKey = '') {
  requireRequest(teamId);
  const current = get(modelContext);
  const selected = providerFrom(current);
  if (
    current.teamId !== teamId ||
    !selected ||
    !selectedModel(selected, current.model) ||
    current.phase === 'loading' ||
    current.phase === 'saving'
  ) {
    throw new LocalApiError('Invalid Team model request.');
  }

  const attempt = ++generation;
  const epoch = sessionEpoch;
  // Switching between configured selections keeps the chat open; only a new credential gates it.
  const saving = { ...current, phase: 'saving', ready: current.ready && !apiKey, error: '' };
  modelContext.set(saving);
  try {
    const result = await saveModelSetup(
      teamId,
      { provider: current.provider, model: current.model, apiKey },
      current.providers,
    );
    const providers = withProviderState(current.providers, result.providerState);
    publishProviderState(epoch, result.providerState);
    const snapshot = {
      ...saving,
      phase: 'ready',
      providers,
      provider: result.inference.provider,
      model: result.inference.model,
      ready: true,
      error: '',
    };
    return settle(attempt, snapshot, result.inference);
  } catch (error) {
    const saved = error?.providerState;
    const providers = saved ? withProviderState(saving.providers, saved) : saving.providers;
    if (saved) publishProviderState(epoch, saved);
    else if (apiKey && error?.code === 'outcome-unknown' && epoch === sessionEpoch) providersUncertain = true;
    throw fail(attempt, error, { ...saving, providers });
  }
}

function withProviderState(providers, providerState) {
  return providers.map((entry) => (entry.id === providerState.id ? providerState : entry));
}

// A saved provider state enters the shared cache only within the session that saved it; it merges into the cache
// so a Team switch or another provider's save in between is kept. A settled active Team view reconciles at once; a
// view still loading or saving reconciles when it settles.
function publishProviderState(epoch, providerState) {
  if (epoch !== sessionEpoch || !providerCatalogCache) return;
  providerCatalogCache = withProviderState(providerCatalogCache, providerState);
  const current = get(modelContext);
  if (current.phase === 'ready') modelContext.set(reconcile(current));
}

export async function configureModelContext(teamId, apiKey = '') {
  return persist(teamId, typeof apiKey === 'string' ? apiKey.trim() : '');
}

/**
 * Admin says the Team's model selection changed (another tab, or this one): read it again and show a selection that
 * differs from the one shown. A view that is loading or saving keeps its own answer, which is the newer one.
 */
export async function refreshInference(teamId) {
  requireRequest(teamId);
  const shown = get(modelContext);
  // A save whose outcome was lost, or a load that failed, reads the whole context again, and so does a shown Team after
  // a key save whose answer was lost in any Team's view: the providers are read again then. Nothing is sent again.
  const uncertain = shown.teamId === teamId && providersUncertain && shown.phase === 'ready';
  if ((shown.teamId === teamId && shown.phase === 'error') || uncertain) return loadModelContext(teamId);
  const attempt = generation;
  if (!settledFor(shown, teamId)) return shown;
  const inference = await loadInference(teamId);
  const current = get(modelContext);
  if (attempt !== generation || !settledFor(current, teamId) || !inference) return current;
  if (current.provider === inference.provider && current.model === inference.model) return current;
  const selected = providerFrom(current, inference.provider);
  if (!selected || !selectedModel(selected, inference.model)) return current;
  persisted = { teamId, provider: inference.provider, model: inference.model };
  const snapshot = { ...current, provider: selected.id, model: inference.model, ready: selected.configured, error: '' };
  modelContext.set(snapshot);
  return snapshot;
}

function settledFor(state, teamId) {
  return state.teamId === teamId && state.phase === 'ready';
}

export async function selectTeamBrain(teamId, providerId, modelId) {
  requireRequest(teamId);
  const current = get(modelContext);
  const selected = providerFrom(current, providerId);
  if (
    current.teamId !== teamId ||
    !selected ||
    !selectedModel(selected, modelId) ||
    current.phase === 'loading' ||
    current.phase === 'saving'
  ) {
    throw new LocalApiError('Invalid Team model request.');
  }
  if (current.provider === selected.id && current.model === modelId) return current;
  generation += 1;
  modelContext.set({
    ...current,
    phase: 'ready',
    provider: selected.id,
    model: modelId,
    ready: selected.configured && current.ready,
    error: '',
  });
  return selected.configured ? persist(teamId) : get(modelContext);
}
