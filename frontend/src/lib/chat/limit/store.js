import { socketReads } from '../../session/socket.js';
import { synced } from '../../session/synced.js';
import { exactKeys, jsonObject, LocalApiError, safeApiError } from '../../api.js';

// How many chat conversations the Space runs at once (ADR-0119): Team owns the limit, Admin reads and sets it. The
// rest wait in line, each told its place. 2 is the ceiling proven so far.
export const MAX_CHAT_LIMIT = 2;

function validLimit(body) {
  return exactKeys(body, ['limit']) && Number.isSafeInteger(body.limit) && body.limit >= 1 && body.limit <= MAX_CHAT_LIMIT;
}

async function answered(response, fallback) {
  const body = await jsonObject(response);
  if (!response.ok) throw new LocalApiError(safeApiError(body, fallback), response.status);
  if (!validLimit(body)) throw new LocalApiError('The chat limit is invalid.', response.status);
  return body.limit;
}

/** Read the Space's chat limit, with `call`. An answer carrying any other field fails closed. */
export async function loadChatLimit(call = socketReads.call) {
  return answered(await call('chat_limit.read', {}), 'The chat limit is unavailable.');
}

// The limit as every screen shows it: read over the session socket and again whenever Admin says it changed, in this
// tab or another. A save never writes it itself.
const limitValue = synced('space/chat-limit', loadChatLimit);

/** The chat limit's synced state, `{ status, value: number | null, error }`. */
export const chatLimit = { subscribe: limitValue.subscribe };

/** Forget the limit when the Supervisor session ends. */
export function forgetChatLimit() {
  limitValue.reset();
}

/** Set the limit; what shows afterwards is the limit read once Admin announced Team committed it. */
export async function saveChatLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHAT_LIMIT) throw new LocalApiError('The chat limit is invalid.');
  const saved = await answered(await socketReads.call('chat_limit.save', { body: { limit } }), 'The chat limit could not be saved.');
  if (saved !== limit) throw new LocalApiError('The chat limit is invalid.');
  await limitValue.refresh();
}
