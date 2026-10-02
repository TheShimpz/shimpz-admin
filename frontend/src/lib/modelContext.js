import { get, writable } from 'svelte/store';

import { LocalApiError } from './localApi.js';
import {
  DEFAULT_INFERENCE_EFFORT,
  INFERENCE_EFFORTS,
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
    effort: DEFAULT_INFERENCE_EFFORT,
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

function cachedModelProviders(fetcher) {
  if (providerCatalogCache) return Promise.resolve(providerCatalogCache);
  if (providerCatalogRequest) return providerCatalogRequest;
  const request = listModelProviders(fetcher)
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

function requireRequest(fetcher, teamId) {
  if (typeof fetcher !== 'function' || typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
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
    persisted.model === state.model &&
    persisted.effort === state.effort,
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
    persisted = { teamId: snapshot.teamId, provider: saved.provider, model: saved.model, effort: saved.effort };
  }
  const settled = reconcile(snapshot);
  modelContext.set(settled);
  return settled;
}

function fail(attempt, error, state) {
  const safe = publicError(error, 'The Team model settings are unavailable.');
  if (attempt === generation) {
    modelContext.set({ ...state, phase: 'error', ready: false, error: safe.message });
  }
  return safe;
}

export function clearModelContext() {
  generation += 1;
  sessionEpoch += 1;
  providerCatalogCache = null;
  providerCatalogRequest = null;
  persisted = null;
  modelContext.set(emptyContext());
}

export function preloadModelProviders(fetcher) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid model provider request.');
  return cachedModelProviders(fetcher);
}

export async function loadModelContext(fetcher, teamId) {
  requireRequest(fetcher, teamId);
  const attempt = ++generation;
  persisted = null;
  const loading = { ...emptyContext(), phase: 'loading', teamId };
  modelContext.set(loading);
  try {
    const [providers, inference] = await Promise.all([
      cachedModelProviders(fetcher),
      loadInference(fetcher, teamId),
    ]);
    const selected = inference
      ? providers.find((entry) => entry.id === inference.provider)
      : providers.find((entry) => entry.configured) ?? providers[0];
    if (!selected) throw new LocalApiError('Model provider settings are invalid.');
    const model = inference?.model ?? selected.default_model;
    const effort = inference?.effort ?? DEFAULT_INFERENCE_EFFORT;
    if (!selectedModel(selected, model)) throw new LocalApiError('Team model settings are invalid.');
    let selectionReady = Boolean(inference && selected.configured);
    if (!inference && selected.configured) {
      await saveModelSetup(
        fetcher,
        teamId,
        { provider: selected.id, model, effort, apiKey: '' },
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
      effort,
      ready: selectionReady,
      error: '',
    };
    return settle(attempt, snapshot, inference ?? (selectionReady ? { provider: selected.id, model, effort } : null));
  } catch (error) {
    throw fail(attempt, error, loading);
  }
}

async function persist(fetcher, teamId, apiKey = '') {
  requireRequest(fetcher, teamId);
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
      fetcher,
      teamId,
      { provider: current.provider, model: current.model, effort: current.effort, apiKey },
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
      effort: result.inference.effort,
      ready: true,
      error: '',
    };
    return settle(attempt, snapshot, result.inference);
  } catch (error) {
    const saved = error?.providerState;
    const providers = saved ? withProviderState(saving.providers, saved) : saving.providers;
    if (saved) publishProviderState(epoch, saved);
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

export async function configureModelContext(fetcher, teamId, apiKey = '') {
  return persist(fetcher, teamId, typeof apiKey === 'string' ? apiKey.trim() : '');
}

export async function selectTeamBrain(fetcher, teamId, providerId, modelId) {
  requireRequest(fetcher, teamId);
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
  return selected.configured ? persist(fetcher, teamId) : get(modelContext);
}

export async function selectTeamEffort(fetcher, teamId, effort) {
  requireRequest(fetcher, teamId);
  const current = get(modelContext);
  const selected = providerFrom(current);
  if (
    current.teamId !== teamId ||
    !selected ||
    !INFERENCE_EFFORTS.includes(effort) ||
    current.phase === 'loading' ||
    current.phase === 'saving'
  ) {
    throw new LocalApiError('Invalid Team model request.');
  }
  if (current.effort === effort) return current;
  generation += 1;
  modelContext.set({ ...current, phase: 'ready', effort, error: '' });
  return selected.configured ? persist(fetcher, teamId) : get(modelContext);
}
