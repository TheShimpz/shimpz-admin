import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { dateFormat, listFormat, numberFormat, pluralRules, relativeFormat } from '../src/lib/i18n/formats.js';

test('each kind, locale, and options get one formatter, kept for every later use', () => {
  assert.equal(numberFormat('pt-BR'), numberFormat('pt-BR'));
  assert.notEqual(numberFormat('pt-BR'), numberFormat('en-US'));
  assert.notEqual(numberFormat('en-US'), numberFormat('en-US', { maximumFractionDigits: 1 }));
  assert.equal(numberFormat('pt-BR').format(2880), new Intl.NumberFormat('pt-BR').format(2880));
  assert.equal(relativeFormat('en', { numeric: 'auto' }).format(-1, 'day'), 'yesterday');
  assert.equal(pluralRules('en').select(1), 'one');
  assert.equal(listFormat('en', { type: 'conjunction' }).format(['a', 'b']), 'a and b');
  const zoned = { dateStyle: 'long', timeZone: 'UTC' };
  assert.equal(dateFormat('en', zoned), dateFormat('en', { ...zoned }));
  assert.equal(dateFormat('en', zoned).format(Date.UTC(2026, 9, 2)), 'October 2, 2026');
});

test('options Intl refuses are refused the same way after a default formatter is cached', () => {
  numberFormat('en');
  assert.throws(() => numberFormat('en', null), TypeError);
  dateFormat('en');
  assert.throws(() => dateFormat('en', null), TypeError);
});

test('a date formatter that names no zone follows the viewer zone once it is resolved again', (t) => {
  const zone = process.env.TZ;
  t.after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  // Later than any real resolution an earlier test made.
  let now = Date.now() + 86_400_000;
  mock.method(Date, 'now', () => now);
  t.after(() => mock.restoreAll());
  const instant = Date.UTC(2026, 9, 3, 1, 29);
  const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  process.env.TZ = 'UTC';
  now += 120_000;
  assert.equal(dateFormat('en', options).format(instant), '01:29');
  process.env.TZ = 'America/Sao_Paulo';
  assert.equal(dateFormat('en', options).format(instant), '01:29');
  now += 60_000;
  assert.equal(dateFormat('en', options).format(instant), '22:29');
  // A clock set back resolves the zone again at once.
  process.env.TZ = 'UTC';
  now -= 3_600_000;
  assert.equal(dateFormat('en', options).format(instant), '01:29');
});
