// One Brain multiple-choice clarification (ADR-0081). It is presentation only: answering never sends anything;
// it fills the composer with the original request and the answer, and the user reviews and sends that message.

import { codePointLength } from './validate.js';

export const MAX_QUESTION_CHARS = 240;
export const MAX_LABEL_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 160;
export const MAX_COMPOSED_CHARS = 16000;
const FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;

function closedText(value, maximum, empty = false) {
  return (
    typeof value === 'string' &&
    value.normalize('NFC') === value &&
    value.trim() === value &&
    codePointLength(value) <= maximum &&
    (empty || value.length > 0) &&
    !FORBIDDEN_RE.test(value)
  );
}

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Return the exact clarification, or null when the value is null. Any other shape throws. */
export function parseClarification(value) {
  if (value === null) return null;
  if (!exact(value, ['question', 'options', 'default_index']) || !closedText(value.question, MAX_QUESTION_CHARS)) {
    throw new TypeError('invalid clarification');
  }
  const { options, default_index: defaultIndex } = value;
  if (!Array.isArray(options) || options.length < 2 || options.length > 5) throw new TypeError('invalid clarification');
  const parsed = options.map((option) => {
    if (
      !exact(option, ['label', 'description']) ||
      !closedText(option.label, MAX_LABEL_CHARS) ||
      !closedText(option.description, MAX_DESCRIPTION_CHARS, true)
    ) throw new TypeError('invalid clarification');
    return { label: option.label, description: option.description };
  });
  if (
    new Set(parsed.map((option) => option.label.toLowerCase())).size !== parsed.length ||
    !Number.isInteger(defaultIndex) ||
    defaultIndex < 0 ||
    defaultIndex >= parsed.length
  ) throw new TypeError('invalid clarification');
  return { question: value.question, options: parsed, default_index: defaultIndex };
}

/** The exact plain reply that accompanies a clarification; every boundary requires the reply to equal it. */
export function renderClarification(clarification) {
  return [
    clarification.question,
    '',
    ...clarification.options.map((option, index) => (
      `${index + 1}. ${option.label}${index === clarification.default_index ? ' ✓' : ''}${option.description ? ` — ${option.description}` : ''}`
    )),
  ].join('\n');
}

/**
 * Combine the original request, the question, and the answer into the message the user will review and send.
 * Returns null when the answer is empty or the combination would exceed the chat message limit; it never truncates.
 */
export function composeClarifiedRequest(original, question, answer, labels) {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (!text) return null;
  const composed = `${original.trim()}\n\n${labels.question}: ${question}\n${labels.answer}: ${text}`;
  return codePointLength(composed) <= MAX_COMPOSED_CHARS ? composed : null;
}
