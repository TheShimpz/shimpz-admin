// A Team's standing instructions (ADR-0083): Supervisor-saved rules the Brain follows as data in every chat turn.
import { LocalApiError, safeApiError } from './localApi.js';
import { exactKeys, jsonObject, TEAM_ID_RE } from './validate.js';

export const MAX_INSTRUCTIONS = 16;
export const MAX_INSTRUCTION_CHARS = 280;
const FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;

function validRule(rule) {
  return (
    typeof rule === 'string' &&
    rule.normalize('NFC') === rule &&
    rule.trim() === rule &&
    rule.length > 0 &&
    rule.length <= MAX_INSTRUCTION_CHARS &&
    !FORBIDDEN_RE.test(rule)
  );
}

/** True only for the exact protocol list: at most 16 distinct single-line rules of at most 280 characters. */
export function validInstructions(value) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INSTRUCTIONS &&
    value.every(validRule) &&
    new Set(value.map((rule) => rule.toLowerCase())).size === value.length
  );
}

/**
 * Turn the editor text into rules, one per non-empty line. Returns the rules, or the first problem as
 * `{ error: 'tooMany' | 'tooLong' | 'invalid' | 'duplicate', line }` with its 1-based line.
 */
export function parseInstructionLines(text) {
  const rules = [];
  const seen = new Set();
  const lines = String(text).normalize('NFC').split('\n');
  for (const [index, raw] of lines.entries()) {
    const rule = raw.trim();
    if (!rule) continue;
    const line = index + 1;
    if (rules.length === MAX_INSTRUCTIONS) return { error: 'tooMany', line };
    if (rule.length > MAX_INSTRUCTION_CHARS) return { error: 'tooLong', line };
    if (!validRule(rule)) return { error: 'invalid', line };
    if (seen.has(rule.toLowerCase())) return { error: 'duplicate', line };
    seen.add(rule.toLowerCase());
    rules.push(rule);
  }
  return { rules };
}

function path(teamId) {
  return `/api/teams/${encodeURIComponent(teamId)}/instructions`;
}

function projected(body, teamId, status) {
  if (!exactKeys(body, ['team_id', 'instructions']) || body.team_id !== teamId || !validInstructions(body.instructions)) {
    throw new LocalApiError('The Team instructions response is invalid.', status);
  }
  return [...body.instructions];
}

export async function loadInstructions(fetcher, teamId) {
  if (typeof fetcher !== 'function' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid Team instructions request.');
  }
  const response = await fetcher(path(teamId), { cache: 'no-store', headers: { Accept: 'application/json' } });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Team instructions are unavailable.'), response.status);
  }
  return projected(body, teamId, response.status);
}

export async function saveInstructions(fetcher, teamId, rules) {
  if (typeof fetcher !== 'function' || !TEAM_ID_RE.test(teamId) || !validInstructions(rules)) {
    throw new LocalApiError('Invalid Team instructions request.');
  }
  const response = await fetcher(path(teamId), {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions: rules }),
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'The Team instructions could not be saved.'), response.status);
  }
  const saved = projected(body, teamId, response.status);
  if (saved.length !== rules.length || saved.some((rule, index) => rule !== rules[index])) {
    throw new LocalApiError('The Team instructions response is invalid.', response.status);
  }
  return saved;
}
