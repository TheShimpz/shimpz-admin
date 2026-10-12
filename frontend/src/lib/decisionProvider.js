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

// The state this session last read or saved. The key is Space-wide and changes only through this module, so the
// composer control shows it again without asking; it still reads it each time it opens. The session's end forgets it,
// and an answer to a request made before that is never remembered. A save or removal outranks every read that overlaps
// it, and among saves the later one wins, so a read never overwrites what a save just stored.
let remembered = null;
let rememberedOrder = 0;
let order = 0;
let epoch = 0;
let pendingChanges = 0;
let changes = 0;

/** The decision provider state this session last read or saved, or null. */
export function knownDecisionProvider() {
  return remembered;
}

/** Forget the remembered state when the Supervisor session ends. */
export function forgetDecisionProvider() {
  epoch += 1;
  remembered = null;
  rememberedOrder = 0;
}

async function request(fetcher, init, fallback, change = false) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid decision provider request.');
  const started = epoch;
  const changesBefore = changes;
  order += 1;
  const position = order;
  if (change) pendingChanges += 1;
  try {
    const response = await fetcher(ENDPOINT, { cache: 'no-store', ...init });
    const body = await jsonObject(response);
    if (!response.ok) throw new LocalApiError(safeApiError(body, fallback), response.status);
    if (!validState(body)) throw new LocalApiError('Decision provider settings are invalid.', response.status);
    const state = { configured: body.configured, masked: body.masked };
    const current = started === epoch && (change
      ? position > rememberedOrder
      : pendingChanges === 0 && changesBefore === changes && position > rememberedOrder);
    if (current) {
      remembered = state;
      rememberedOrder = position;
    }
    if (change) changes += 1;
    return state;
  } finally {
    if (change) pendingChanges -= 1;
  }
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
    true,
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
    true,
  );
  if (state.configured) throw new LocalApiError('Decision provider settings are invalid.');
  return state;
}
