// Calendar days and times of the chat transcript, in the viewer's own timezone: the day headers above each day's
// first item and the time on each message.
//
// Which instant an item has:
// - A chat history row carries the time Admin wrote it (a Routine notice's is the notice's own): a message when it
//   was sent, a reply when it was completed.
// - An item that arrived while this page was open (a message sent, a reply, an install or uninstall outcome) is not
//   yet a history row here, so its time is when the page first showed it.
// An exchange (a message and the reply under it) stays whole under the day of its first item.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const formats = new Map();

// One formatter per use, locale, and timezone: a transcript formats every item's day and time on each render.
function cachedFormat(use, locale, timeZone, options) {
  const key = `${use} ${locale} ${timeZone ?? ''}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formats.set(key, format);
  }
  return format;
}

function keyFormat(timeZone) {
  // en-CA writes a calendar date as YYYY-MM-DD, the same order the key keeps.
  return cachedFormat('day', 'en-CA', timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** The calendar day (YYYY-MM-DD) an instant falls on in a timezone (the viewer's when omitted), or null. */
export function calendarDay(instant, timeZone) {
  if (!Number.isFinite(instant)) return null;
  const parts = Object.fromEntries(keyFormat(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayNumber(day) {
  const [, year, month, date] = DAY_RE.exec(day);
  return Date.UTC(Number(year), Number(month) - 1, Number(date)) / DAY_MS;
}

/** Each exchange's calendar day: its first turn's. `instantOf(turn)` answers a turn's instant in milliseconds. */
export function exchangeDays(exchanges, instantOf, timeZone) {
  return exchanges.map((exchange) => calendarDay(instantOf(exchange.user ?? exchange.assistant), timeZone));
}

/**
 * The instant of each transcript turn: a history row's stored time, else the moment the page first showed it. A shown
 * turn keeps its first time across later updates; `retain(turns)` forgets the turns the transcript no longer holds.
 */
export function turnInstants(now = () => Date.now()) {
  const shown = new Map();
  const instantOf = (turn) => {
    if (turn.createdAt) return Date.parse(turn.createdAt);
    if (!shown.has(turn.renderKey)) shown.set(turn.renderKey, now());
    return shown.get(turn.renderKey);
  };
  instantOf.retain = (turns) => {
    const live = new Set(turns.map((turn) => turn.renderKey));
    for (const key of shown.keys()) if (!live.has(key)) shown.delete(key);
  };
  return instantOf;
}

/** An instant's time of day to the second on a 24-hour clock ("14:03:07"), in the Admin locale's digits. */
export function clockTime(instant, locale, timeZone) {
  return cachedFormat('clock', locale, timeZone, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .format(instant);
}

/** An instant as a `<time datetime>` value: UTC to the second, the form a stored row's time has. */
export function instantValue(instant) {
  return new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function capitalized(text, locale) {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** A day in words for the Admin locale: today, yesterday, or else its full date ("2 de outubro de 2026"). */
export function dayLabel(day, today, locale) {
  const distance = dayNumber(day) - dayNumber(today);
  if (distance === 0 || distance === -1) {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(distance, 'day');
    return capitalized(relative, locale);
  }
  const [, year, month, date] = DAY_RE.exec(day);
  // The date is a calendar day, not an instant: it is written in UTC so no timezone can move it.
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' })
    .format(Date.UTC(Number(year), Number(month) - 1, Number(date)));
}

/** Milliseconds from an instant until the viewer's next local midnight, when "today" changes. */
export function untilNextDay(instant) {
  const next = new Date(instant);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - instant;
}
