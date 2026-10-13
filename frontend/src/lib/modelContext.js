// The shown Team's model context (ADR-0114): the Space's model providers and the Team's model selection, each a synced
// value Admin announces (`space/models`, `team/{id}/inference`), with the one choice the person is about to save. A save
// never writes the context: what Admin holds after it, read again, does. The Team opens once Admin holds both a
// selection and its provider's key, whichever tab or lost answer stored them.
import { derived, get, writable } from 'svelte/store';

import { listModelProviders, loadInference, saveModelSetup } from './modelProviders.js';
import { synced } from './session/synced.js';
import { LocalApiError, publicError } from './api.js';
import { TEAM_ID_RE } from './ids.js';

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

const providersValue = synced('space/models', (call) => listModelProviders(call));
// The shown Team and its selection, read anew each time a Team view opens; `{ selection }` is null when it has none.
const shownTeam = writable(null);
// The shown Team's local state: a choice not yet saved, a save under way, and the failure of the last save.
const local = writable({ teamId: '', choice: null, saving: false, error: '', errorCode: '' });
// Bumped by every Team view and every save, so a save answered after the view changed leaves it alone.
let views = 0;
let saves = 0;
// The Team views whose default selection this one stored, so it is stored at most once per view.
let autoSelected = 0;

function selectionValue(teamId) {
  return synced(`team/${teamId}/inference`, async (call) => ({ selection: await loadInference(teamId, call) }));
}

const selectionState = derived(shownTeam, (shown, set) => {
  if (!shown) {
    set(null);
    return undefined;
  }
  return shown.value.subscribe((state) => set({ teamId: shown.teamId, ...state }));
});

function selectedModel(provider, modelId) {
  return provider?.models.find((entry) => entry.id === modelId) ?? null;
}

// A read that will not succeed by itself, or one with no value yet that keeps failing while it is read again: the
// context says so rather than staying a load forever.
function refusal(state) {
  const error = state?.status === 'error' ? state.error : !state?.value ? state?.failing : null;
  return error ? publicError(error, 'The Team model settings are unavailable.') : null;
}

// Whether the shown Team has no selection yet while a provider already has a key: it then stores the default.
function awaitingDefault(providers, selection, view) {
  return Boolean(selection && selection.selection === null && !view.choice && providers.some((entry) => entry.configured));
}

function compute(providersState, selectionStateNow, view) {
  if (!view.teamId || selectionStateNow?.teamId !== view.teamId) return emptyContext();
  const base = { ...emptyContext(), teamId: view.teamId };
  const providers = providersState.value;
  const selection = selectionStateNow.value;
  const failed = refusal(providersState) ?? refusal(selectionStateNow);
  if (!providers || !selection) {
    if (view.saving) return { ...base, phase: 'saving' };
    if (failed) return { ...base, phase: 'error', error: failed.message, errorCode: failed.code ?? '' };
    return { ...base, phase: 'loading' };
  }
  const fallback = providers.find((entry) => entry.configured) ?? providers[0];
  const chosen = view.choice ?? selection.selection ?? { provider: fallback.id, model: fallback.default_model };
  const provider = providers.find((entry) => entry.id === chosen.provider);
  if (!provider || !selectedModel(provider, chosen.model)) {
    return { ...base, phase: 'error', providers, error: 'Team model settings are invalid.', errorCode: '' };
  }
  const stored = selection.selection;
  const ready = Boolean(
    !view.choice && stored && stored.provider === provider.id && stored.model === chosen.model && provider.configured,
  );
  const shown = { ...base, providers, provider: provider.id, model: chosen.model, ready };
  if (view.saving) return { ...shown, phase: 'saving', ready: false };
  // A refused read is shown even while an earlier value is known: what Admin holds now cannot be told.
  if (failed) return { ...shown, phase: 'error', ready: false, error: failed.message, errorCode: failed.code ?? '' };
  if (ready) return { ...shown, phase: 'ready' };
  if (view.error) return { ...shown, phase: 'error', error: view.error, errorCode: view.errorCode };
  if (awaitingDefault(providers, selection, view)) return { ...shown, phase: 'loading' };
  return { ...shown, phase: 'ready' };
}

const context = derived([providersValue, selectionState, local], ([providers, selection, view]) => (
  compute(providers, selection, view)
));

// A Team with no selection yet opens on the default model of a provider that already has a key, stored once per view.
function storeDefault() {
  const view = get(local);
  const selection = get(selectionState);
  const providers = get(providersValue).value;
  if (autoSelected === views || view.saving || !providers || !selection?.value) return;
  if (!awaitingDefault(providers, selection.value, view) || selection.teamId !== view.teamId) return;
  autoSelected = views;
  persist(view.teamId, '').catch(() => {});
}

/** The shown Team's model context: `{ phase, teamId, providers, provider, model, ready, error }`. */
export const modelContext = {
  subscribe(run) {
    return context.subscribe((value) => {
      run(value);
      if (value.phase === 'loading' && value.providers.length) queueMicrotask(storeDefault);
    });
  },
};

function requireRequest(teamId) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid Team model request.');
  }
}

/** The session ended, or no Team is shown: forget everything read for it. */
export function clearModelContext() {
  views += 1;
  shownTeam.set(null);
  local.set({ teamId: '', choice: null, saving: false, error: '', errorCode: '' });
  providersValue.reset();
}

// Settles with the shown Team's context once it is ready, or fails with its error; a Team view that changed meanwhile
// fails it as changed.
function settled(teamId) {
  return new Promise((resolve, reject) => {
    let done = false;
    let stop = () => {};
    const finish = (outcome) => {
      done = true;
      queueMicrotask(() => stop());
      outcome();
    };
    stop = modelContext.subscribe((value) => {
      if (done) return;
      if (value.teamId !== teamId) {
        finish(() => reject(new LocalApiError('The local Team context changed.')));
      } else if (value.phase === 'ready') {
        finish(() => resolve(value));
      } else if (value.phase === 'error') {
        finish(() => reject(publicError(new LocalApiError(value.error), 'The Team model settings are unavailable.')));
      }
    });
  });
}

/** Show one Team's model context; showing it again reads it again. Settles once it is ready or failed. */
export function loadModelContext(teamId) {
  requireRequest(teamId);
  const shown = get(shownTeam);
  if (shown?.teamId === teamId) {
    local.update((current) => ({ ...current, error: '', errorCode: '' }));
    void providersValue.refresh();
    void shown.value.refresh();
  } else {
    views += 1;
    local.set({ teamId, choice: null, saving: false, error: '', errorCode: '' });
    shownTeam.set({ teamId, value: selectionValue(teamId) });
  }
  return settled(teamId);
}

async function persist(teamId, apiKey = '') {
  requireRequest(teamId);
  const current = get(modelContext);
  const provider = current.providers.find((entry) => entry.id === current.provider);
  if (
    current.teamId !== teamId ||
    !provider ||
    !selectedModel(provider, current.model) ||
    current.phase === 'saving' ||
    (current.phase === 'loading' && !current.providers.length)
  ) {
    throw new LocalApiError('Invalid Team model request.');
  }
  const token = ++saves;
  const ownView = views;
  const mine = () => ownView === views && token === saves;
  local.update((state) => ({ ...state, saving: true, error: '', errorCode: '' }));
  const shown = get(shownTeam);
  try {
    await saveModelSetup(teamId, { provider: current.provider, model: current.model, apiKey }, current.providers);
  } catch (error) {
    const safe = publicError(error, 'The Team model selection could not be saved.');
    // What Admin holds after a failed or lost save is read again; a lost answer is read once Admin is back.
    void providersValue.refresh();
    void shown?.value.refresh();
    if (mine()) local.update((state) => ({ ...state, saving: false, error: safe.message, errorCode: safe.code ?? '' }));
    throw safe;
  }
  // The context shows what Admin holds once it is read again, never the save's own answer.
  await Promise.all([providersValue.refresh(), shown?.value.refresh()]);
  if (mine()) local.update((state) => ({ ...state, saving: false, choice: null }));
  return get(modelContext);
}

/** Save the key for the shown selection, when one is given, and store that selection for the Team. */
export async function configureModelContext(teamId, apiKey = '') {
  return persist(teamId, typeof apiKey === 'string' ? apiKey.trim() : '');
}

/** Choose a model for the shown Team: stored at once when its provider has a key, or held until the key is saved. */
export async function selectTeamBrain(teamId, providerId, modelId) {
  requireRequest(teamId);
  const current = get(modelContext);
  const provider = current.providers.find((entry) => entry.id === providerId);
  if (
    current.teamId !== teamId ||
    !provider ||
    !selectedModel(provider, modelId) ||
    current.phase === 'loading' ||
    current.phase === 'saving'
  ) {
    throw new LocalApiError('Invalid Team model request.');
  }
  if (current.provider === provider.id && current.model === modelId) return current;
  local.update((state) => ({ ...state, choice: { provider: provider.id, model: modelId }, error: '', errorCode: '' }));
  return provider.configured ? persist(teamId) : get(modelContext);
}
