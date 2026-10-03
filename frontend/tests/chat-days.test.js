import assert from 'node:assert/strict';
import test from 'node:test';

import { calendarDay, dayLabel, exchangeDays, turnInstants, untilNextDay } from '../src/lib/chatDays.js';
import { LOCALES } from '../src/lib/locales.js';

const SAO_PAULO = 'America/Sao_Paulo';
const TOKYO = 'Asia/Tokyo';

test('a day is the calendar date in the viewer timezone, across a midnight boundary', () => {
  // 02:30 UTC on 3 October is still 2 October in São Paulo and already midday in Tokyo.
  const instant = Date.parse('2026-10-03T02:30:00Z');
  assert.equal(calendarDay(instant, 'UTC'), '2026-10-03');
  assert.equal(calendarDay(instant, SAO_PAULO), '2026-10-02');
  assert.equal(calendarDay(instant, TOKYO), '2026-10-03');
  assert.equal(calendarDay(Date.parse('2026-10-02T14:59:59Z'), TOKYO), '2026-10-02');
  assert.equal(calendarDay(Date.parse('2026-10-02T15:00:00Z'), TOKYO), '2026-10-03');
  assert.equal(calendarDay(null, 'UTC'), null);
  assert.equal(calendarDay(Number.NaN, 'UTC'), null);
  assert.match(calendarDay(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
});

test('today and yesterday are relative words; older and later days are full dates in every Admin locale', () => {
  const today = '2026-10-03';
  assert.equal(dayLabel('2026-10-03', today, 'pt'), 'Hoje');
  assert.equal(dayLabel('2026-10-02', today, 'pt'), 'Ontem');
  assert.equal(dayLabel('2026-10-01', today, 'pt'), '1 de outubro de 2026');
  assert.equal(dayLabel('2026-10-03', today, 'en'), 'Today');
  assert.equal(dayLabel('2026-10-02', today, 'en'), 'Yesterday');
  assert.equal(dayLabel('2025-12-31', today, 'en'), 'December 31, 2025');
  assert.equal(dayLabel('2026-10-04', today, 'en'), 'October 4, 2026');
  // Yesterday across a month and a year boundary.
  assert.equal(dayLabel('2026-09-30', '2026-10-01', 'en'), 'Yesterday');
  assert.equal(dayLabel('2025-12-31', '2026-01-01', 'es'), 'Ayer');
  for (const { code } of LOCALES) {
    const words = [dayLabel(today, today, code), dayLabel('2026-10-02', today, code), dayLabel('2026-10-01', today, code)];
    assert.equal(new Set(words).size, 3, code);
    for (const word of words) assert.ok(word.length > 0 && word === word.trim(), code);
    assert.equal(words[0], new Intl.RelativeTimeFormat(code, { numeric: 'auto' }).format(0, 'day')
      .replace(/^./u, (first) => first.toLocaleUpperCase(code)), code);
  }
  assert.equal(dayLabel('2026-10-01', today, 'de'), '1. Oktober 2026');
});

test('an exchange takes its first turn\'s stored time, so every history row has a day', () => {
  const at = (iso) => ({ historyId: 'x', createdAt: iso });
  const exchanges = [
    { user: at('2026-09-30T18:00:00Z'), assistant: at('2026-09-30T18:00:04Z') },
    { user: null, assistant: { ...at('2026-10-01T12:00:00Z'), routineRun: {} } },
    // A reply written after midnight stays under the day its message was sent.
    { user: at('2026-10-02T23:59:58Z'), assistant: at('2026-10-03T00:00:03Z') },
    { user: at('2026-10-03T00:10:00Z'), assistant: null },
  ];
  const instantOf = turnInstants();
  assert.deepEqual(exchangeDays(exchanges, instantOf, 'UTC'), [
    '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03',
  ]);
  // The same transcript seen from São Paulo: 00:10 UTC is still the evening before.
  assert.deepEqual(exchangeDays(exchanges, instantOf, SAO_PAULO), [
    '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-02',
  ]);
  assert.deepEqual(exchangeDays([], instantOf, 'UTC'), []);
});

test('a turn shown live keeps the time the page first showed it, through later updates', () => {
  let clock = Date.parse('2026-10-02T23:59:59Z');
  const instantOf = turnInstants(() => clock);
  assert.equal(instantOf({ historyId: 'a:user', renderKey: 1, createdAt: '2026-10-01T12:00:00Z' }),
    Date.parse('2026-10-01T12:00:00Z'));
  assert.equal(instantOf({ renderKey: 7, text: 'sent' }), Date.parse('2026-10-02T23:59:59Z'));
  clock += 60_000;
  // An updated copy of the same turn (same render key) is still the moment it first appeared.
  assert.equal(instantOf({ renderKey: 7, text: 'sent', receipt: [] }), Date.parse('2026-10-02T23:59:59Z'));
  assert.equal(instantOf({ renderKey: 8 }), Date.parse('2026-10-03T00:00:59Z'));
  const days = exchangeDays([{ user: { renderKey: 7 }, assistant: { renderKey: 8 } }], instantOf, 'UTC');
  // A reply after midnight stays under the day its message was sent.
  assert.deepEqual(days, ['2026-10-02']);
  assert.ok(turnInstants()({ renderKey: 1 }) <= Date.now());
});

test('today changes at the next local midnight', () => {
  const noon = new Date(2026, 9, 2, 12, 0, 0).getTime();
  assert.equal(untilNextDay(noon), new Date(2026, 9, 3).getTime() - noon);
  const late = new Date(2026, 9, 2, 23, 59, 59, 500).getTime();
  assert.equal(untilNextDay(late), 500);
  assert.notEqual(calendarDay(late + untilNextDay(late)), calendarDay(late));
});
