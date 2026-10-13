import { socketReads } from './adminSocket.js';
import { synced } from './synced.js';
import { exactKeys, jsonObject, LocalApiError, safeApiError } from './validate.js';

// The Supervisor's optional TypeSafe key for the Jev intent fast path (ADR-0077). Only masked metadata crosses here.
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

async function answered(response, fallback) {
  const body = await jsonObject(response);
  if (!response.ok) throw new LocalApiError(safeApiError(body, fallback), response.status);
  if (!validState(body)) throw new LocalApiError('Decision provider settings are invalid.', response.status);
  return { configured: body.configured, masked: body.masked };
}

/** Read whether a TypeSafe key is configured, with `call`. A response carrying any extra field fails closed. */
export async function loadDecisionProvider(call = socketReads.call) {
  return answered(await call('decision.read', {}), 'Fast routing settings are unavailable.');
}

// The key's state as every screen shows it: read over the session socket and again whenever Admin says it changed,
// in this tab or another, or once a save whose answer was lost finished. A save never writes it itself.
const decisionValue = synced('space/decision', loadDecisionProvider);

/** The decision provider's synced state, `{ status, value: { configured, masked } | null, error }`. */
export const decisionProvider = { subscribe: decisionValue.subscribe };

/** Forget the state when the Supervisor session ends. */
export function forgetDecisionProvider() {
  decisionValue.reset();
}

// A change is checked against Admin's answer; what shows afterwards is the state read once Admin announced it.
async function change(method, params, fallback, configured) {
  const state = await answered(await socketReads.call(method, params), fallback);
  if (state.configured !== configured) throw new LocalApiError('Decision provider settings are invalid.');
  await decisionValue.refresh();
}

/** Admin validates the key with TypeSafe before storing it; the answer carries only the masked suffix. */
export async function saveDecisionKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length < 16 || key.length > 8192) throw new LocalApiError('Enter a valid TypeSafe API key.');
  await change('decision.save', { body: { api_key: key } }, 'The TypeSafe key could not be saved.', true);
}

/** Remove the key; intent classification then runs only the LLM route. */
export async function removeDecisionKey() {
  await change('decision.remove', {}, 'The TypeSafe key could not be removed.', false);
}
