import { get, writable } from 'svelte/store';

import { LocalApiError } from './localApi.js';
import { listModelProviders, loadInference, saveModelSetup } from './modelProviders.js';

const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;

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

function requireRequest(fetcher, teamId) {
  if (typeof fetcher !== 'function' || typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid Team model request.');
  }
}

function publicError(error, fallback = 'The Team model settings are unavailable.') {
  if (error instanceof LocalApiError && error.message && error.message.length <= 300) return error;
  return new LocalApiError(fallback);
}

function providerFrom(state, providerId = state.provider) {
  return state.providers.find((entry) => entry.id === providerId) ?? null;
}

function selectedModel(provider, modelId) {
  return provider?.models.find((entry) => entry.id === modelId) ?? null;
}

function fail(attempt, error, state) {
  const safe = publicError(error);
  if (attempt === generation) {
    modelContext.set({ ...state, phase: 'error', ready: false, error: safe.message });
  }
  return safe;
}

export function clearModelContext() {
  generation += 1;
  modelContext.set(emptyContext());
}

export async function loadModelContext(fetcher, teamId) {
  requireRequest(fetcher, teamId);
  const attempt = ++generation;
  const loading = { ...emptyContext(), phase: 'loading', teamId };
  modelContext.set(loading);
  try {
    const [providers, inference] = await Promise.all([
      listModelProviders(fetcher),
      loadInference(fetcher, teamId),
    ]);
    const selected = inference
      ? providers.find((entry) => entry.id === inference.provider)
      : providers.find((entry) => entry.configured) ?? providers[0];
    if (!selected) throw new LocalApiError('Model provider settings are invalid.');
    const model = inference?.model ?? selected.default_model;
    if (!selectedModel(selected, model)) throw new LocalApiError('Team model settings are invalid.');
    const snapshot = {
      phase: 'ready',
      teamId,
      providers,
      provider: selected.id,
      model,
      ready: Boolean(inference && selected.configured),
      error: '',
    };
    if (attempt === generation) modelContext.set(snapshot);
    return snapshot;
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
  const saving = { ...current, phase: 'saving', ready: false, error: '' };
  modelContext.set(saving);
  try {
    const result = await saveModelSetup(
      fetcher,
      teamId,
      { provider: current.provider, model: current.model, apiKey },
      current.providers,
    );
    const providers = current.providers.map((entry) => (
      entry.id === result.providerState.id ? result.providerState : entry
    ));
    const snapshot = {
      ...saving,
      phase: 'ready',
      providers,
      provider: result.inference.provider,
      model: result.inference.model,
      ready: true,
      error: '',
    };
    if (attempt === generation) modelContext.set(snapshot);
    return snapshot;
  } catch (error) {
    throw fail(attempt, error, saving);
  }
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
    ready: false,
    error: '',
  });
  return selected.configured ? persist(fetcher, teamId) : get(modelContext);
}
