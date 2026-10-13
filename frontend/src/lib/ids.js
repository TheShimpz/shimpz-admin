// Identifier grammars shared by Team's and Admin's protocols: Teams, Assistants, Integrations and Stored Inputs, Actions,
// opaque and trace ids, content digests, semantic versions, and Creator handles.

export const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
// The Team HTTP protocol's identifiers (teams protocol/http/v1/identifiers.py), pinned by the Admin parity test: an
// Assistant id and an Integration, provider, or Stored Input identifier share the Developers grammar with two bounds,
// and an Action id has Team's wider grammar.
export const ASSISTANT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
// A canonical semantic version, as Assistant publications and stage labels carry it.
export const SEMANTIC_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
// One public Creator handle, as the Store catalog and Team's stage labels admit it.
export const PUBLIC_CREATOR_RE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const ACTION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const MAX_ASSISTANT_ID_CHARS = 40;
export const MAX_IDENTIFIER_CHARS = 64;
export const MAX_ACTION_ID_CHARS = 128;
export const OPAQUE_ID_RE = /^[0-9a-f]{32}$/;
// A content digest as Team and Developers name an image, an icon, a source, a plan, or a language pack.
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const TRACE_ID_RE = OPAQUE_ID_RE;

// A Team's display name, at most this many code points (Team's MAX_TEAM_NAME_CHARS).
export const MAX_TEAM_NAME_CHARS = 80;

export function isAssistantId(value) {
  return typeof value === 'string' && value.length <= MAX_ASSISTANT_ID_CHARS && ASSISTANT_ID_RE.test(value);
}

/** An Integration, provider, or Stored Input identifier. */
export function isIdentifier(value) {
  return typeof value === 'string' && value.length <= MAX_IDENTIFIER_CHARS && ASSISTANT_ID_RE.test(value);
}

export function isActionId(value) {
  return typeof value === 'string' && value.length <= MAX_ACTION_ID_CHARS && ACTION_ID_RE.test(value);
}

const ACRONYMS = new Set(['api', 'dns', 'http', 'id', 'ip', 'ssl', 'tls', 'url']);

/**
 * A machine identifier as words, the one rule every Admin screen uses: "list-dns-records" reads "List DNS records",
 * "zone_id" reads "Zone ID". Anything but a string reads as nothing.
 */
export function humanizeId(value) {
  if (typeof value !== 'string') return '';
  const words = value.split(/[-_.]+/u).filter(Boolean)
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()));
  if (words.length === 0) return value;
  const [first, ...rest] = words;
  return [first === first.toUpperCase() ? first : first[0].toUpperCase() + first.slice(1), ...rest].join(' ');
}
