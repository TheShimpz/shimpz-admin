// The bounded value grammars every protocol parser shares: text measured in code points, the control characters no
// shown text may hold, a UTC instant in whole seconds, and a whole count.

export const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A whole count from zero to `maximum`. */
export function isCount(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Producers bound text in Unicode code points (Python len(), JSON Schema maxLength), not UTF-16 code units. */
export function codePointLength(value) {
  return [...value].length;
}

/**
 * Text shown as it was written: a non-empty string with no surrounding space and none of `controls`, at most `maximum`
 * code points long.
 */
export function isShownText(value, maximum, controls = CONTROL_RE) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value === value.trim() &&
    codePointLength(value) <= maximum &&
    !controls.test(value)
  );
}

/** A list of `minimum` to `maximum` distinct items, each admitted by `isItem`. */
export function isUniqueList(value, minimum, maximum, isItem) {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every((item) => isItem(item)) &&
    new Set(value).size === value.length
  );
}

/** A real UTC instant in whole seconds, written YYYY-MM-DDTHH:MM:SSZ. */
export function isInstant(value) {
  // Date.parse rolls impossible dates such as February 30 forward, so the instant must round-trip exactly.
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString().replace('.000Z', 'Z') === value;
}
