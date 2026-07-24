import { LocalApiError, safeApiError } from './localApi.js';
import MODEL_CATALOG from './modelCatalog.json' with { type: 'json' };
import { exactKeys, jsonObject, TEAM_ID_RE } from './validate.js';

const EXPECTED_CATALOG = Object.freeze(Object.fromEntries(MODEL_CATALOG.providers.map((provider) => [
  provider.id,
  Object.freeze({
    title: provider.title,
    default_model: provider.default_model,
    models: Object.freeze(provider.models.map((model) => Object.freeze({ ...model }))),
  }),
])));
const PROVIDER_IDS = new Set(Object.keys(EXPECTED_CATALOG));
const MAX_PROVIDERS = PROVIDER_IDS.size;
const MODEL_FIELDS = ['id', 'input_usd_per_million_cents', 'output_usd_per_million_cents', 'title'];
const PROVIDER_FIELDS = ['configured', 'default_model', 'id', 'masked', 'models', 'title'];

function validProvider(entry) {
  const expected = EXPECTED_CATALOG[entry?.id];
  return (
    entry &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    exactKeys(entry, PROVIDER_FIELDS) &&
    expected &&
    entry.title === expected.title &&
    entry.default_model === expected.default_model &&
    Array.isArray(entry.models) &&
    entry.models.length === expected.models.length &&
    entry.models.every((model, index) => (
      model &&
      typeof model === 'object' &&
      !Array.isArray(model) &&
      exactKeys(model, MODEL_FIELDS) &&
      MODEL_FIELDS.every((field) => model[field] === expected.models[index][field])
    )) &&
    typeof entry.configured === 'boolean' &&
    (entry.masked === null || (typeof entry.masked === 'string' && /^••••[!-~]{4}$/.test(entry.masked)))
  );
}

function validSelection(provider, model) {
  return PROVIDER_IDS.has(provider) && EXPECTED_CATALOG[provider].models.some((entry) => entry.id === model);
}

/** Read masked provider state. A response containing any secret-shaped extra field fails closed. */
export async function listModelProviders(fetcher) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid model provider request.');
  const response = await fetcher('/api/model-providers', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Model provider settings are unavailable.'), response.status);
  }
  if (!Array.isArray(body.providers) || body.providers.length !== MAX_PROVIDERS) {
    throw new LocalApiError('Model provider settings are invalid.', response.status);
  }
  const ids = new Set();
  for (const provider of body.providers) {
    if (!validProvider(provider) || ids.has(provider.id)) {
      throw new LocalApiError('Model provider settings are invalid.', response.status);
    }
    ids.add(provider.id);
  }
  return body.providers;
}

/** Read only provider/model metadata from one Team. HTTP 409 means it has no selection yet. */
export async function loadInference(fetcher, teamId) {
  if (typeof fetcher !== 'function' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid Team inference request.');
  }
  const response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/inference`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (response.status === 409) return null;
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Team inference settings are unavailable.'), response.status);
  }
  if (
    !exactKeys(body, ['team_id', 'model', 'provider']) ||
    body.team_id !== teamId ||
    !validSelection(body.provider, body.model)
  ) {
    throw new LocalApiError('Team inference settings are invalid.', response.status);
  }
  return { provider: body.provider, model: body.model };
}

/** Save a key to the backend first, then send only provider/model to the Team controller. */
export async function saveModelSetup(fetcher, teamId, setup, providers) {
  if (
    typeof fetcher !== 'function' ||
    !TEAM_ID_RE.test(teamId) ||
    !validSelection(setup?.provider, setup?.model) ||
    !Array.isArray(providers) ||
    providers.length !== MAX_PROVIDERS ||
    !providers.every(validProvider)
  ) {
    throw new LocalApiError('Invalid model provider settings.');
  }
  const current = providers.find((entry) => entry.id === setup.provider);
  if (!current || !current.models.some((entry) => entry.id === setup.model)) {
    throw new LocalApiError('Invalid model provider settings.');
  }
  const apiKey = typeof setup.apiKey === 'string' ? setup.apiKey.trim() : '';
  let providerState = current;

  if (apiKey) {
    const credentialResponse = await fetcher(`/api/model-providers/${encodeURIComponent(setup.provider)}`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    });
    const credentialBody = await jsonObject(credentialResponse);
    if (!credentialResponse.ok) {
      throw new LocalApiError(safeApiError(credentialBody, 'The API key could not be saved.'), credentialResponse.status);
    }
    if (!validProvider(credentialBody) || credentialBody.id !== setup.provider || !credentialBody.configured) {
      throw new LocalApiError('The model provider response is invalid.', credentialResponse.status);
    }
    providerState = credentialBody;
  } else if (!current.configured) {
    throw new LocalApiError('Add an API key for the selected provider.');
  }

  const inferenceResponse = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/inference`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: setup.provider, model: setup.model }),
  });
  const inferenceBody = await jsonObject(inferenceResponse);
  if (!inferenceResponse.ok) {
    throw new LocalApiError(
      safeApiError(inferenceBody, 'The Team model selection could not be saved.'),
      inferenceResponse.status,
    );
  }
  if (
    !exactKeys(inferenceBody, ['team_id', 'model', 'provider']) ||
    inferenceBody.team_id !== teamId ||
    inferenceBody.provider !== setup.provider ||
    inferenceBody.model !== setup.model
  ) {
    throw new LocalApiError('The Team inference response is invalid.', inferenceResponse.status);
  }
  return { providerState, inference: { provider: setup.provider, model: setup.model } };
}

export async function removeModelKey(fetcher, provider) {
  if (typeof fetcher !== 'function' || !PROVIDER_IDS.has(provider)) {
    throw new LocalApiError('Invalid model provider request.');
  }
  const response = await fetcher(`/api/model-providers/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) throw new LocalApiError(safeApiError(body, 'The API key could not be removed.'), response.status);
  if (!validProvider(body) || body.id !== provider || body.configured) {
    throw new LocalApiError('The model provider response is invalid.', response.status);
  }
  return body;
}
