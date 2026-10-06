// One Brain multiple-choice clarification (ADR-0081). Answering sends one new user message that combines the
// original request, the question, and the chosen answer; that message remains the only Action authority.

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

/**
 * Return the exact clarification, or null when the value is null. Any other shape throws. `default_index` names the
 * recommended option, or is null when the question recommends none, as a Routine question never steers a choice.
 */
export function parseClarification(value) {
  if (value === null) return null;
  if (!exact(value, ['question', 'options', 'default_index']) || !closedText(value.question, MAX_QUESTION_CHARS)) {
    throw new TypeError('invalid clarification');
  }
  const { options, default_index: defaultIndex } = value;
  if (!Array.isArray(options) || options.length < 2 || options.length > 5) {
    throw new TypeError('invalid clarification');
  }
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
    (defaultIndex !== null && (!Number.isInteger(defaultIndex) || defaultIndex < 0 || defaultIndex >= parsed.length))
  ) throw new TypeError('invalid clarification');
  return { question: value.question, options: parsed, default_index: defaultIndex };
}

/**
 * The exact plain reply that accompanies a clarification; every boundary requires the reply to equal it. A recommended
 * option carries " ✓"; with a null default none does.
 */
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
 * Combine the original request, the question, and the answer into the message the answer sends.
 * Returns null when the answer is empty or the combination would exceed the chat message limit; it never truncates.
 */
export function composeClarifiedRequest(original, question, answer, labels) {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (!text) return null;
  const composed = `${original.trim()}\n\n${labels.question}: ${question}\n${labels.answer}: ${text}`;
  return codePointLength(composed) <= MAX_COMPOSED_CHARS ? composed : null;
}

/**
 * The answer a sent message gives to a clarification, or null. A message answers it only when it is exactly the
 * composition `composeClarifiedRequest` produces for that original request and question with one of the given label
 * pairs (one per interface language, so a language change never reopens an answered question), so the transcript can
 * show the answer alone while the Team still receives the whole request.
 */
export function clarificationAnswer(message, original, question, labelSets) {
  if (typeof message !== 'string' || typeof original !== 'string') return null;
  for (const labels of labelSets) {
    const prefix = `${original.trim()}\n\n${labels.question}: ${question}\n${labels.answer}: `;
    if (!message.startsWith(prefix)) continue;
    const answer = message.slice(prefix.length);
    if (answer && answer === answer.trim() && !answer.includes('\n')) return answer;
  }
  return null;
}

/** The request a question card clarifies, or null unless its exchange still holds that exact user request. */
export function clarifiedRequest(exchange) {
  const { user, assistant } = exchange;
  if (!assistant?.clarification || !user) return null;
  if (user.historyId || assistant.historyId) {
    const turn = (value) => value?.split(':')[0];
    if (!user.historyId || !assistant.historyId || turn(user.historyId) !== turn(assistant.historyId)) return null;
  }
  return user.text;
}

/**
 * Each question is answered by at most one later message that is exactly its composed request: a live answer by the
 * message it sent (`liveAnswers` maps that user turn's render key to the answered assistant turn's render key), and
 * otherwise the nearest earlier open question it composes. `given` maps the question's exchange index to that answer,
 * and `sent` maps the answering exchange index to the question it answers and the answer, so the message can show both.
 * One pass keeps the open questions, so a message is only checked against questions still waiting for an answer.
 */
export function matchClarificationAnswers(exchanges, liveAnswers, labelSets) {
  const given = new Map();
  const sent = new Map();
  const originals = exchanges.map(clarifiedRequest);
  const answer = (later, index) => {
    // A question Admin words itself, such as a Routine question, may have been sent in any interface language.
    const { question, questions = [question] } = exchanges[index].assistant.clarification;
    for (const asked of questions) {
      const value = clarificationAnswer(exchanges[later].user?.text, originals[index], asked, labelSets);
      if (value === null) continue;
      given.set(index, value);
      sent.set(later, { question, answer: value });
      return true;
    }
    return false;
  };
  const exchangeOf = new Map(exchanges.map((exchange, index) => [exchange.assistant?.renderKey, index]));
  exchanges.forEach((exchange, later) => {
    const linked = exchange.user ? liveAnswers.get(exchange.user.renderKey) : undefined;
    const index = linked === undefined ? undefined : exchangeOf.get(linked);
    if (index !== undefined && index < later && !given.has(index) && originals[index] !== null) answer(later, index);
  });
  const open = [];
  exchanges.forEach((exchange, later) => {
    if (exchange.user && !sent.has(later)) {
      for (let position = open.length - 1; position >= 0; position -= 1) {
        if (answer(later, open[position])) {
          open.splice(position, 1);
          break;
        }
      }
    }
    if (originals[later] !== null && !given.has(later)) open.push(later);
  });
  return { given, sent };
}
