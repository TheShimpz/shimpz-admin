// Team Routines in the viewer's words (ADR-0086, ADR-0092, ADR-0101): a Routine's status, its schedule, plan, inputs,
// and results, its failures' likely causes, its questions and refusals, and every count, each in the interface
// language's copy. Display only: what these words describe is admitted by routines/protocol.js.

import { fill } from '../i18n/fill.js';
import { dateFormat, numberFormat, pluralRules, relativeFormat } from '../i18n/formats.js';
import { humanizeId } from '../ids.js';
import { outcomeUnknown } from '../session/socket.js';
import { escapedText, OUTPUT_MODES, questionTarget, RoutineError } from './protocol.js';

/**
 * How a listed Routine stands for the person, most urgent first: being deleted, held for recovery, waiting to be asked
 * again, paused, waiting for an approval, or running (a run now, or between runs on its schedule).
 */
export function routineStatus(routine, runs = [], incidents = []) {
  const own = runs.filter((run) => run.routine_id === routine.routine_id);
  if (routine.deleting) return 'deleting';
  if (incidents.some((item) => item.routine_id === routine.routine_id) || own.some((run) => run.status === 'held')) {
    return 'recovery';
  }
  if (routine.needs_reconfirm) return 'reconfirm';
  if (routine.state === 'paused') return 'paused';
  if (own.some((run) => run.status === 'frozen')) return 'waiting';
  return 'running';
}

/**
 * The one word a Routine's status shows the person: it is running, paused, or failed. Waiting for an approval and
 * waiting to be asked again stop its dispatch, so they read as paused; a run held for recovery reads as failed. The
 * panel names the reason beside the word. A Routine being deleted shows no word.
 */
export const STATUS_WORDS = Object.freeze({
  running: 'running',
  paused: 'paused',
  waiting: 'paused',
  reconfirm: 'paused',
  recovery: 'failed',
});

/** Each status word's tag tone and icon: one border color per word, the same in every Routine surface. */
export const STATUS_TAGS = Object.freeze({
  running: { tone: 'accent', icon: 'activity' },
  paused: { tone: 'warning', icon: 'pause' },
  failed: { tone: 'danger', icon: 'warning' },
});

/** Statuses that need the person, shown in words beside the Routine. */
export const ATTENTION_STATUSES = Object.freeze(['deleting', 'recovery', 'reconfirm', 'paused', 'waiting']);

/**
 * Whether a Routine waits for the person: a run held for recovery or waiting for their approval or connection, or the
 * Routine paused or waiting to be asked again. One being deleted waits for nobody.
 */
export function needsPerson(routine, runs = [], incidents = []) {
  const status = routineStatus(routine, runs, incidents);
  return status !== 'deleting' && ATTENTION_STATUSES.includes(status);
}

/** A JSON Pointer into a step's result as words: "/zones/0/id" reads "zones › first › id". */
export function pointerWords(pointer, copy) {
  return pointer.split('/').slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => {
      if (!/^(0|[1-9][0-9]{0,8})$/.test(segment)) return segment;
      const index = Number(segment);
      return index === 0 ? copy.first : fill(copy.item, { n: index + 1 });
    })
    .join(' › ');
}

/**
 * A literal's preview as plain words: a JSON string reads without its quotes, with every unsafe character Team escaped
 * escaped again, so decoding never restores a control or invisible character; anything else stays as Team showed it.
 */
export function literalWords(preview) {
  try {
    const value = JSON.parse(preview);
    return typeof value === 'string' ? escapedText(value) : preview;
  } catch {
    return preview;
  }
}

/**
 * A selector's constant in words: a string reads without its quotes, every unsafe character Team escaped escaped
 * again; an integer reads as its digits.
 */
function whereWords(where) {
  return literalWords(where.value_json);
}

/**
 * One plan input in words: a literal's preview, the date of each run, or a path into an earlier step's result, through
 * the one item whose member holds the constant the request named.
 */
export function inputWords(input, copy) {
  if (input.source === 'literal') return literalWords(input.value);
  if (input.source === 'run_clock') {
    // The run date, or the preview of a text whose dates in braces each run writes for its own date.
    return input.value === 'date' ? fill(copy.clock, { format: copy.clocks.date }) : input.value;
  }
  const n = input.step;
  if (input.where !== null) {
    const path = [pointerWords(input.pointer, copy), input.item ? pointerWords(input.item, copy) : ''].filter(Boolean);
    return fill(copy.fromItem, {
      n,
      path: path.join(' › '),
      member: humanizeId(input.where.member),
      value: whereWords(input.where),
    });
  }
  if (!input.pointer) return fill(copy.fromStepWhole, { n });
  return fill(copy.fromStep, { n, path: pointerWords(input.pointer, copy) });
}

// Words that suggest what may have caused a failure, read only from Team's sanitized diagnostic. They choose the
// plain explanation shown beside the literal error, never anything Team does: a guess, phrased as a possible cause.
const CAUSE_WORDS = [
  ['credits', /\b(credits?|quota|billing|balance|insufficient[ _]funds|payment required|out of funds)\b/i],
  ['rateLimit', /\b(rate[ _-]?limit(ed)?|too many requests|throttl\w*)\b/i],
  ['auth', /\b(unauthori[sz]ed|forbidden|permission|access denied|authentication|invalid (api[ _-]?)?(key|token)|expired token)\b/i],
  ['timeout', /\b(timed? ?out|timeout|deadline exceeded)\b/i],
  ['notFound', /\b(not found|does not exist|no such|could not route)\b/i],
  ['invalid', /\b(invalid|validation|malformed|bad request|unprocessable)\b/i],
];
const CAUSE_STATUSES = { 402: 'credits', 429: 'rateLimit', 401: 'auth', 403: 'auth', 404: 'notFound', 410: 'notFound', 408: 'timeout', 504: 'timeout' };

/** The likely cause of a card's recorded failure, for its plain explanation; `unknown` when nothing suggests one. */
export function failureCause(diagnostic) {
  if (!diagnostic) return 'unknown';
  if (diagnostic.condition !== null) return diagnostic.condition === 'timeout' ? 'timeout' : 'assistant';
  const { error_type: type, message, http_status: status, response_excerpt: excerpt } = diagnostic.failure;
  const text = `${type} ${message} ${excerpt ?? ''}`;
  // Billing words outrank a status: providers report an exhausted balance as 402, 403, or 429 alike.
  if (CAUSE_WORDS[0][1].test(text)) return 'credits';
  if (status !== null && CAUSE_STATUSES[status]) return CAUSE_STATUSES[status];
  const matched = CAUSE_WORDS.find(([, words]) => words.test(text));
  if (matched) return matched[0];
  if (status === 400 || status === 422) return 'invalid';
  return status !== null && status >= 500 ? 'provider' : 'unknown';
}

const CONTINUOUS_UNITS = [['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
// One day or one week alone names a calendar day, never an interval, so an interval counts them only from two on.
const CALENDAR_UNITS = new Set(['week', 'day']);
// Weekday 0 is Monday in the Routine grammar.
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * A schedule in words for the viewer's locale; wall-clock times are in the Routine's own timezone. These are words
 * Team's own reader reads back as exactly this schedule (ADR-0101 amendment, 2026-10-16), so a card's Edit can send
 * them: a count is never grouped ("1001", not "1,001"), and a day of the month takes its locale's ordinal form.
 */
export function scheduleWords(schedule, copy, locale) {
  if (schedule.kind === 'continuous') {
    // The gap in its largest whole unit: "Every 30 minutes", "Every 90 seconds", "Every 24 hours".
    const [unit, seconds] = CONTINUOUS_UNITS.find(
      ([name, size]) => schedule.gap % size === 0 && !(CALENDAR_UNITS.has(name) && schedule.gap === size),
    );
    const count = schedule.gap / seconds;
    return fill(plural(copy.every[unit], count, locale), { count: numberFormat(locale, { useGrouping: false }).format(count) });
  }
  if (schedule.kind === 'daily') return fill(copy.daily, { time: schedule.time });
  if (schedule.kind === 'weekly') {
    // Each locale names its weekdays itself, so the article agrees with the day ("Todo domingo", "Toda segunda-feira").
    return fill(copy.weekly, { weekday: copy.weekdays[WEEKDAYS[schedule.weekday]], time: schedule.time });
  }
  const ordinal = copy.monthDay[pluralRules(locale, { type: 'ordinal' }).select(schedule.day)] ?? copy.monthDay.other;
  return fill(copy.monthly, { day: fill(ordinal, { day: schedule.day }), time: schedule.time });
}

/** A UTC instant shown in a Routine's timezone for the viewer's locale. */
export function instantWords(value, locale, timeZone) {
  return dateFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
}

/** An instant as day/Month/year and a 24-hour clock to the second ("02/Outubro/2026 22:29:00") in a timezone. */
export function clockWords(value, locale, timeZone) {
  const parts = Object.fromEntries(dateFormat(locale, {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone,
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const month = parts.month.charAt(0).toLocaleUpperCase(locale) + parts.month.slice(1);
  return `${parts.day}/${month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** How far ahead an instant is, in the largest whole unit ("in 3 hours"); an instant already due has no words. */
export function untilWords(value, now, locale) {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  if (!(seconds > 0)) return '';
  const [unit, size] = [['day', 86_400], ['hour', 3_600], ['minute', 60], ['second', 1]].find(([, step]) => seconds >= step);
  return relativeFormat(locale, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
}

/** A copy template as ordered parts, each value part keyed by its placeholder so it can be styled on its own. */
export function fillParts(template, values) {
  return template.split(/(\{\w+\})/u).filter(Boolean).map((part) => {
    const key = /^\{(\w+)\}$/u.exec(part)?.[1];
    return key && key in values ? { text: String(values[key]), key } : { text: part, key: '' };
  });
}

/** The localized message for a Routine failure code. */
export function routineErrorMessage(error, copy) {
  const code = error instanceof RoutineError ? error.code : '';
  const byCode = {
    'team-context-changed': copy.changed,
    // The run's request no longer renders against the Team's reviewed Assistant; it stays frozen (ADR-0091).
    'human-request-invalid': copy.changed,
    // The run's request expired before its answer arrived; it stays frozen and is reviewed again.
    'human-request-expired': copy.expired,
    'assistant-language-drift': copy.unavailable,
    'routine-limit': copy.full,
    // The Team's Routines' daily Action steps together, or their definitions together, would outgrow its budget.
    'routine-step-budget': copy.stepBudget,
    'routine-team-budget': copy.teamBudget,
    'routine-too-large': copy.tooLarge,
    // The Routine changed while its steps were read; it is read again, never mixed with the other revision.
    'routine-revision-changed': copy.routineChanged,
    'routine-run-changed': copy.stale,
    // Another window answered the frozen run's request first, so the run no longer waits for one here.
    'routine-run-not-frozen': copy.stale,
    'routine-run-not-found': copy.ended,
    'routine-incident-unavailable': copy.ended,
    // Team cannot verify a held run's evidence, so it opens no card for it; its Routine can still be deleted.
    'routine-incident-unverifiable': copy.unverifiable,
    // The card changed before the answer arrived; the decision opens its current card itself, so nothing is to reopen.
    'routine-card-stale': copy.cardChanged,
    'routine-not-found': copy.ended,
    'routine-busy': copy.busy,
    'routine-workload-unquiesced': copy.stillRunning,
    'routine-contracts-changed': copy.contractsChanged,
    // The card was confirmed, revoked, replaced, or outlived its fifteen minutes; nothing was created.
    'routine-proposal-expired': copy.proposalExpired,
    // The Team cannot hold one more change right now; nothing changed, and it frees up on its own.
    'notices-full': copy.unavailable,
    'routine-state-unavailable': copy.unavailable,
    'team-context-unavailable': copy.unavailable,
    // Admin could not check the Supervisor's password for the Action, so the run ended denied; trying again cannot help.
    'human-authentication-unavailable': copy.authenticationUnavailable,
  };
  return byCode[code] ?? copy.generic;
}

/**
 * The words of a failed Routine change: `unknown` when the socket dropped before Admin answered, so the change may or
 * may not have happened, else the words of its code.
 */
export function routineFailureWords(error, copy, unknown) {
  return outcomeUnknown(error) ? unknown : routineErrorMessage(error, copy);
}

// The words of a count: one form for exactly one, the other for any other number.
function plural(forms, count, locale) {
  return pluralRules(locale).select(count) === 'one' ? forms.one : forms.other;
}

/** A count in words: its form for the count in the viewer's locale, the count written in that locale's digits. */
export function countWords(forms, count, locale) {
  return fill(plural(forms, count, locale), { count: numberFormat(locale).format(count) });
}

// Each run notice's tone where its run is shown in full: healthy (done, recovered), danger (failed, held, denied),
// waiting (paused, frozen), or neutral (set aside, stopped).
const NOTICE_TONES = Object.freeze({
  done: 'healthy',
  recovered: 'healthy',
  failed: 'danger',
  held: 'danger',
  denied: 'danger',
  paused: 'waiting',
  frozen: 'waiting',
  'user-skipped': 'neutral',
  stopped: 'neutral',
});

/**
 * Ordered Assistant Actions as one line grouped by Assistant: "A · x › y" when every step shares A, otherwise
 * "A · x › B · y", naming an Assistant again only where it changes. An item may carry how many consecutive steps
 * repeat its Action, which reads "x ×3".
 */
export function stepChain(steps, assistantName) {
  return steps.map(([assistant, action, count = 1], index) => {
    const words = count > 1 ? `${humanizeId(action)} ×${count}` : humanizeId(action);
    return index > 0 && steps[index - 1][0] === assistant ? words : `${assistantName(assistant)} · ${words}`;
  }).join(' › ');
}

/** A plan summary's Actions as one line, then how many steps follow beyond the runs it names. */
export function summaryChain(plan, assistantName, copy, locale) {
  const chain = stepChain(plan.actions, assistantName);
  if (plan.more === 0) return chain;
  return `${chain} › ${countWords(copy.rest, plan.more, locale)}`;
}

/** One of a Routine's runs opened in full, in plain text only: its tone and a short status phrase. */
export function routineNotice(entry, copy) {
  const notice = copy.notice;
  const frozen = {
    human: notice.status.frozenHuman,
    integrations: notice.status.frozenIntegrations,
  };
  const status = {
    'user-skipped': notice.status.userSkipped,
    frozen: frozen[entry.detail.request_kind],
  }[entry.outcome] ?? notice.status[entry.outcome];
  return { tone: NOTICE_TONES[entry.outcome], status };
}

/** Whether a plan step reads or writes, as its tag shows it: each in its own tone, in the card's words. */
export function stepTag(readOnly, card) {
  return readOnly ? { tone: 'accent', label: card.stepRead } : { tone: 'warning', label: card.stepWrite };
}

/** What a Routine does with each run's result, in words: the shown step is named by its place in the plan. */
export function dispositionWords(output, copy) {
  return fill(copy.output[output.mode], { n: output.step });
}

/**
 * Labels as shown: humanized ("per_page" reads "Per page") only while that keeps every label distinct, otherwise
 * exactly as Team wrote them, so two fields never read alike.
 */
export function outputLabels(labels) {
  const humanized = labels.map((label) => humanizeId(label));
  return new Set(humanized).size === labels.length ? humanized : [...labels];
}

/**
 * A number's exact JSON text in the viewer's locale only when the browser holds it exactly and the locale's digits
 * keep every one of them: at most 15 significant digits, and zero or a magnitude from 0.000001 to under 10^15.
 * Anything else reads exactly as Team wrote it, so a shown number is never rounded.
 */
function numberWords(text, locale) {
  const digits = text.replace(/^-/u, '').replace(/[eE].*$/u, '').replace('.', '').replace(/^0+/u, '');
  const value = Number(text);
  const magnitude = Math.abs(value);
  const localizable = digits.length <= 15 && Number.isFinite(value) &&
    (value === 0 || (magnitude >= 1e-6 && magnitude < 1e15));
  return localizable ? numberFormat(locale, { maximumFractionDigits: 21 }).format(value) : text;
}

/** One scalar node of a shown result as plain words in the viewer's language. */
export function outputScalarWords(node, copy, locale) {
  switch (node.kind) {
    case 'text': return node.value;
    case 'number': return numberWords(node.value, locale);
    case 'bool': return node.value ? copy.yes : copy.no;
    case 'redacted': return copy.redacted;
    case 'elided': return '…';
    default: return '—';
  }
}

/** How many more items or fields a shown result left out, in words. */
export function omittedWords(copy, count, locale) {
  return countWords(copy.more, count, locale);
}

/**
 * A recorded attempt's heading: the replay step Team recorded, its Assistant and Action, and its attempt number, so
 * attempts of one Action repeated at different steps never read alike. `names` words the Assistant and Action.
 */
export function attemptWords(item, template, { assistant = (id) => id, action = (id) => id } = {}) {
  return fill(template, {
    step: item.position,
    assistant: assistant(item.assistant_id),
    action: action(item.action),
    attempt: item.attempt,
  });
}

/** A failed attempt's safe transport condition in words. */
export function conditionWords(condition, copy) {
  const exit = condition.match(/^exit-status:(-?\d+)$/u);
  if (exit) return fill(copy.conditions.exit, { code: exit[1] });
  return {
    'stderr-output': copy.conditions.stderr,
    timeout: copy.conditions.timeout,
    'frame-invalid': copy.conditions.frame,
    'exit-unavailable': copy.conditions.exitUnavailable,
    'transport-failed': copy.conditions.transport,
  }[condition];
}

const QUESTION_KEYS = {
  'routine-schedule-unstated': 'schedule',
  'routine-interval-over-budget': 'overBudget',
  'routine-binding-ambiguous': 'ambiguous',
  'routine-work-rerun': 'rerun',
  'routine-output-unstated': 'output',
};

/**
 * A Routine question in words: its sentence and the answers a person may send with one press, each with the label a
 * person reads and the text the answer sends. An ambiguous binding's target is sent as its exact JSON text, the only
 * answer Team matches, so a string and an integer of the same digits stay distinct; every other answer is sent as the
 * words it shows. An interval over budget offers the shortest interval that fits.
 */
export function questionWords(question, questions) {
  const words = questions[QUESTION_KEYS[question.code]];
  if (question.code === 'routine-binding-ambiguous') {
    const answers = question.options.map((option) => {
      const target = questionTarget(option.value).shown;
      const label = option.label === null ? target : fill(words.option, { label: option.label, value: target });
      return { label, text: option.value };
    });
    return { question: words.question, answers };
  }
  if (question.code === 'routine-interval-over-budget') {
    const seconds = String(question.value);
    const answer = fill(words.answer, { seconds });
    return { question: fill(words.question, { seconds }), answers: [{ label: answer, text: answer }] };
  }
  return { question: words.question, answers: (words.answers ?? []).map((answer) => ({ label: answer, text: answer })) };
}

// The words of a refusal code. Every documented one has its own sentence; a plan code reads as the plan's, and any
// other code reads as the generic sentence, so Team may stop emitting one without a stored row turning invalid.
const REFUSAL_KEYS = {
  'routine-recording-unavailable': 'unavailable',
  'routine-recording-too-large': 'tooLarge',
  'routine-recording-empty': 'empty',
  'routine-secret-literal': 'secret',
  'routine-step-budget': 'stepBudget',
  'routine-proposal-too-large': 'tooLarge',
  'routine-record-again': 'recordAgain',
  'routine-recording-cyclic': 'unverified',
  'routine-recording-conflict': 'unverified',
  'routine-recording-unverified': 'unverified',
  'routine-recording-ambiguous': 'ambiguous',
};

/** The localized sentence saying why no Routine was created from this turn. */
export function refusalWords(refusal, copy) {
  const key = REFUSAL_KEYS[refusal.code] ?? (refusal.code.startsWith('plan-') ? 'plan' : 'generic');
  return copy.refusals[key];
}

/**
 * One card input's value in words: a literal as itself, the date of each run, or where in an earlier step's result it
 * is read; `planCopy` words a path into that result.
 */
export function proposalInputValue(input, copy, planCopy) {
  if (input.origin === 'request' || input.origin === 'assistant') return literalWords(input.value);
  if (input.origin === 'clock') return input.value ?? copy.origins.clock;
  const path = [input.pointer, input.item ?? ''].filter(Boolean).map((pointer) => pointerWords(pointer, planCopy));
  const origin = input.origin === 'selector'
    ? fill(copy.origins.selector, { n: input.step, member: humanizeId(input.where.member), value: whereWords(input.where) })
    : fill(copy.origins.step, { n: input.step });
  return path.length ? `${origin}: ${path.join(' › ')}` : origin;
}

/** A card's output in Team's own label for it, the one its output question offers in the interface language. */
export function outputChoiceWords(mode, questions) {
  return questions.output.answers[OUTPUT_MODES.indexOf(mode)];
}

/** When a card's Routine runs, in its zone; a Routine given no timezone runs in UTC and says so. */
export function proposalWhen(proposal, copy, locale) {
  const template = proposal.timezone_source === 'none' ? copy.proposal.whenFallback : copy.proposal.when;
  return fill(template, { schedule: scheduleWords(proposal.schedule, copy.schedule, locale), timezone: proposal.timezone });
}

/**
 * The request a card's Edit offers to change and send again: its work, then its schedule and output in words Team's own
 * reader reads back as exactly the card's (ADR-0101 amendment, 2026-10-16). The zone goes with them unless the Routine
 * was given none, so the edited Routine keeps it wherever it is sent from.
 */
export function proposalRequest(proposal, copy, locale) {
  const when = proposal.timezone_source === 'none'
    ? scheduleWords(proposal.schedule, copy.schedule, locale)
    : proposalWhen(proposal, copy, locale);
  return [proposal.description, when, outputChoiceWords(proposal.output, copy.proposal.questions)].join('\n');
}
