import { LocalApiError, safeApiError } from './localApi.js';
import { exactKeys, jsonObject } from './validate.js';

// The Supervisor's optional TypeSafe key for the Jev intent fast path (ADR-0077). Only masked metadata crosses here.
const ENDPOINT = '/api/decision-provider';
const PROVIDER = 'typesafe';
const FIELDS = ['configured', 'masked', 'provider'];
const MASKED_RE = /^••••[!-~]{4}$/;

function validState(body) {
  return (
    exactKeys(body, FIELDS) &&
    body.provider === PROVIDER &&
    typeof body.configured === 'boolean' &&
    (body.configured ? typeof body.masked === 'string' && MASKED_RE.test(body.masked) : body.masked === null)
  );
}

async function request(fetcher, init, fallback) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid decision provider request.');
  const response = await fetcher(ENDPOINT, { cache: 'no-store', ...init });
  const body = await jsonObject(response);
  if (!response.ok) throw new LocalApiError(safeApiError(body, fallback), response.status);
  if (!validState(body)) throw new LocalApiError('Decision provider settings are invalid.', response.status);
  return { configured: body.configured, masked: body.masked };
}

/** Read whether a TypeSafe key is configured. A response carrying any extra field fails closed. */
export function loadDecisionProvider(fetcher) {
  return request(fetcher, { headers: { Accept: 'application/json' } }, 'Fast routing settings are unavailable.');
}

/** Admin validates the key with TypeSafe before storing it; the response carries only the masked suffix. */
export async function saveDecisionKey(fetcher, apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length < 16 || key.length > 8192) throw new LocalApiError('Enter a valid TypeSafe API key.');
  const state = await request(
    fetcher,
    {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key }),
    },
    'The TypeSafe key could not be saved.',
  );
  if (!state.configured) throw new LocalApiError('Decision provider settings are invalid.');
  return state;
}

/** Remove the key; intent classification then runs only the LLM route. */
export async function removeDecisionKey(fetcher) {
  const state = await request(
    fetcher,
    { method: 'DELETE', headers: { Accept: 'application/json' } },
    'The TypeSafe key could not be removed.',
  );
  if (state.configured) throw new LocalApiError('Decision provider settings are invalid.');
  return state;
}
