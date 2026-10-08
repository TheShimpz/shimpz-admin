import assert from 'node:assert/strict';
import test from 'node:test';

import { attemptWords, conditionWords, inputWords } from '../src/lib/routine.js';
import { routineMessages } from '../src/lib/routineMessages.js';
import {
  attemptsByStep,
  durationWords,
  isScalar,
  MAX_RESULT_COLUMNS,
  resultTable,
  resultView,
  valueKind,
  visibleSteps,
} from '../src/lib/routineResult.js';

const text = (value, cut = false) => ({ kind: 'text', value, cut });
const number = (value) => ({ kind: 'number', value });
const bool = (value) => ({ kind: 'bool', value });
const fields = (pairs, omitted = 0) => ({ kind: 'fields', fields: pairs, omitted });
const list = (items, omitted = 0) => ({ kind: 'list', items, omitted });
const HEX = '023e105f4ecef8ad9ca31a8372d0c353';

test('a scalar is any single value, never a list or a field set', () => {
  for (const kind of ['null', 'redacted', 'elided']) assert.equal(isScalar({ kind }), true);
  assert.equal(isScalar(text('a')), true);
  assert.equal(isScalar(number('1')), true);
  assert.equal(isScalar(bool(true)), true);
  assert.equal(isScalar(list([])), false);
  assert.equal(isScalar(fields([])), false);
  assert.equal(isScalar(null), false);
});

test('a column reads by the kind every present value shares', () => {
  assert.equal(valueKind('anything', [null, { kind: 'redacted' }, { kind: 'null' }]), 'text');
  assert.equal(valueKind('paused', [bool(true), null, bool(false)]), 'bool');
  assert.equal(valueKind('count', [number('1'), { kind: 'elided' }]), 'number');
  assert.equal(valueKind('mixed', [number('1'), text('a')]), 'text');
  // An identifier by its key, or by every value being a long hex string or a UUID.
  assert.equal(valueKind('id', [text('short')]), 'id');
  assert.equal(valueKind('zone_id', [text('x')]), 'id');
  assert.equal(valueKind('owner', [text(HEX), text('3f2504e0-4f89-41d3-9a0c-0305e82c3301')]), 'id');
  assert.equal(valueKind('owner', [text(HEX), text('not hex at all')]), 'text');
  assert.equal(valueKind('valid', [text('yes')]), 'text');
  // A status is a short word under a status or state key; anything longer stays text.
  assert.equal(valueKind('Status', [text('active')]), 'status');
  assert.equal(valueKind('state', [text('pending')]), 'status');
  assert.equal(valueKind('status', [text('x'.repeat(33))]), 'text');
  assert.equal(valueKind('status', [text('two\nlines')]), 'text');
  assert.equal(valueKind('type', [text('full')]), 'text');
});

test('a list of field sets spreads a nested flat field set into its own columns, name first and ids last', () => {
  const account = fields([['id', text(HEX)], ['name', text('Main')]]);
  const table = resultTable(list([
    fields([['account', account], ['id', text('z1')], ['name', text('example.com')], ['paused', bool(false)], ['status', text('active')]]),
    fields([['account', { kind: 'null' }], ['id', text('z2')], ['name', text('example.org')], ['paused', bool(true)]]),
  ], 5));
  assert.deepEqual(table.columns.map((column) => column.label), ['Name', 'Account name', 'Account ID', 'Paused', 'Status', 'ID']);
  assert.deepEqual(table.columns.map((column) => column.kind), ['text', 'text', 'id', 'bool', 'status', 'id']);
  assert.deepEqual(table.rows[0].map((cell) => cell?.value ?? null), ['example.com', 'Main', HEX, false, 'active', 'z1']);
  // A null nested value stays a null cell in each of its columns; a field the row lacks is no cell at all.
  assert.deepEqual(table.rows[1].map((cell) => cell?.kind ?? null), ['text', 'null', 'null', 'bool', null, 'text']);
  assert.equal(table.omitted, 5);
});

test('a nested value that is not flat in every row keeps one column and its whole node', () => {
  const deep = fields([['owner', fields([['id', text('1')]])]]);
  const cut = fields([['id', text('1')]], 2);
  const table = resultTable(list([
    fields([['meta', text('plain')], ['deep', deep], ['cut', cut], ['tags', list([text('a')])]]),
    fields([['meta', fields([['a', text('b')]])], ['deep', deep], ['cut', cut], ['tags', list([])]]),
  ]));
  assert.deepEqual(table.columns.map((column) => column.label), ['Meta', 'Deep', 'Cut', 'Tags']);
  assert.equal(table.rows[0][0].value, 'plain');
  assert.equal(table.rows[1][0].kind, 'fields');
  assert.equal(table.rows[0][1], deep);
  assert.equal(table.rows[0][2], cut);
});

test('labels that would read alike keep Team keys, and a label that still repeats is numbered', () => {
  const both = resultTable(list([fields([['account', fields([['name', text('a')]])], ['account_name', text('b')]])]));
  assert.deepEqual(both.columns.map((column) => column.label), ['account › name', 'account_name']);
  const repeated = resultTable(list([fields([
    ['a', fields([['b › c', text('1')]])], ['a › b', fields([['c', text('2')]])], ['A b › c', text('3')],
  ])]));
  assert.deepEqual(repeated.columns.map((column) => column.label), ['a › b › c (1)', 'a › b › c (2)', 'A b › c']);
  // A numbered label never reads like a key Team already wrote that way.
  const suffixed = resultTable(list([fields([
    ['a', fields([['b › c', text('1')]])], ['a › b', fields([['c', text('2')]])], ['A b › c', text('3')], ['a › b › c (1)', text('4')],
  ])]));
  const labels = suffixed.columns.map((column) => column.label);
  assert.deepEqual(labels, ['a › b › c (2)', 'a › b › c (3)', 'A b › c', 'a › b › c (1)']);
  assert.equal(new Set(labels).size, labels.length);
});

test('a table that would be too wide spreads nothing, and one still too wide is no table', () => {
  const wide = fields(Array.from({ length: 10 }, (_, index) => [`k${index}`, text('v')]));
  const row = fields([['inner', wide], ['other', text('x')]]);
  const unspread = resultTable(list([row]), 8);
  assert.deepEqual(unspread.columns.map((column) => column.label), ['Inner', 'Other']);
  assert.equal(unspread.rows[0][0], wide);
  const tooWide = fields(Array.from({ length: MAX_RESULT_COLUMNS + 1 }, (_, index) => [`k${index}`, text('v')]));
  assert.equal(resultTable(list([tooWide])), null);
});

test('only a non-empty list of whole field sets is a table', () => {
  assert.equal(resultTable(list([])), null);
  assert.equal(resultTable(list([text('a')])), null);
  assert.equal(resultTable(list([fields([['a', text('b')]], 1)])), null);
  assert.equal(resultTable(fields([['a', text('b')]])), null);
  assert.equal(resultTable(list([fields([])])), null);
});

test('a field set reads as summary groups and blocks, keeping every value and omission', () => {
  const zones = list([fields([['name', text('example.com')]])], 2);
  const view = resultView(fields([
    ['page', number('1')],
    ['per_page', number('20')],
    ['result_info', fields([['count', number('3')], ['cursor', text(HEX)]])],
    ['zones', zones],
    ['tags', list([text('a'), text('b')], 1)],
    ['mixed', list([text('a'), fields([['b', text('c')]])])],
    ['owner', fields([['contact', fields([['email', { kind: 'redacted' }]])], ['plan', text('pro')]])],
  ], 3));
  assert.deepEqual(view.summary.map((group) => group.label), ['', 'Result info']);
  assert.deepEqual(view.summary[0].items.map((item) => [item.label, item.kind, item.node.value]), [
    ['Page', 'number', '1'],
    ['Per page', 'number', '20'],
  ]);
  assert.deepEqual(view.summary[1].items.map((item) => [item.label, item.kind]), [['Count', 'number'], ['Cursor', 'id']]);
  assert.deepEqual(view.blocks.map((block) => [block.label, block.kind]), [
    ['Zones', 'table'], ['Tags', 'values'], ['Mixed', 'node'], ['Owner', 'view'],
  ]);
  assert.equal(view.blocks[0].omitted, 2);
  assert.equal(view.blocks[1].omitted, 1);
  // A deeper field set is a nested view of its own, its flat inner field set a summary group there.
  assert.deepEqual(view.blocks[3].view.summary.map((group) => group.label), ['', 'Contact']);
  assert.equal(view.blocks[3].view.summary[1].items[0].node.kind, 'redacted');
  assert.equal(view.omitted, 3);
});

test('a field set without single values has no loose summary group, and a cut field set is a nested view', () => {
  const view = resultView(fields([['partial', fields([['a', text('1')]], 4)], ['empty', fields([])]]));
  assert.deepEqual(view.summary, []);
  assert.deepEqual(view.blocks.map((block) => block.kind), ['view', 'view']);
  assert.equal(view.blocks[0].view.omitted, 4);
});

test('a list or a single value at the top is one unlabeled block', () => {
  assert.deepEqual(resultView(text('done')), { summary: [], blocks: [{ label: '', kind: 'value', node: text('done') }], omitted: 0 });
  const top = resultView(list([fields([['id', text('1')]])]));
  assert.equal(top.blocks[0].kind, 'table');
  assert.equal(top.blocks[0].label, '');
});

test('a recorded attempt joins the step whose position it names, and one beyond the run is kept apart', () => {
  const replay = (step, number) => ({ action: 'list-zones', position: { phase: 'replay', step }, attempt: number });
  // Three replay steps: step 4's attempt names no step of this run.
  const { byStep, apart } = attemptsByStep([replay(2, 1), replay(1, 1), replay(4, 1), replay(2, 2)], 3);
  assert.deepEqual([...byStep].map(([key, items]) => [key, items.map((item) => item.attempt)]), [[2, [1, 2]], [1, [1]]]);
  assert.deepEqual(apart.map((item) => item.position.step), [4]);
});

test("a step's duration reads in the viewer's locale", () => {
  assert.equal(durationWords(812, 'en'), '812 ms');
  assert.equal(durationWords(4031, 'en'), '4 sec');
  assert.equal(durationWords(4_250, 'en'), '4.3 sec');
  assert.equal(durationWords(90_000, 'en'), '1.5 min');
  assert.equal(durationWords(4_250, 'pt'), '4,3 s');
});

test('a long run reveals its steps a page at a time', () => {
  const steps = Array.from({ length: 23 }, (_, index) => index);
  assert.equal(visibleSteps(steps, 1).length, 10);
  assert.equal(visibleSteps(steps, 0).length, 10);
  assert.equal(visibleSteps(steps, 2).length, 20);
  assert.equal(visibleSteps(steps, 3).length, 23);
  assert.equal(visibleSteps(steps, 1, 5).length, 5);
});

test('plan inputs and attempt conditions read in words', () => {
  const plan = routineMessages.en.plan;
  assert.equal(inputWords({ member: 'page', source: 'literal', value: '"1"' }, plan), '1');
  assert.equal(inputWords({ member: 'at', source: 'run_clock', value: 'date' }, plan), "each run's date");
  // A reference names the earlier step by its position.
  const from = (step, pointer, where = null, item = null) => ({ member: 'z', source: 'step_output', step, pointer, where, item });
  assert.equal(inputWords(from(1, ''), plan), 'the whole result of step 1');
  assert.equal(inputWords(from(1, '/zones/0/id'), plan), 'from step 1 (zones › first › id)');
  // A selector names the one item whose member holds the constant, escaped.
  assert.equal(
    inputWords(from(1, '/result', { member: 'name', value_json: '"shimpz.com"' }, '/id'), plan),
    'from step 1 (result › id), the item whose Name is “shimpz.com”',
  );
  const details = routineMessages.en.details;
  assert.equal(conditionWords('exit-status:-9', details), 'The Action exited with status -9.');
  assert.equal(conditionWords('timeout', details), 'The Action ran out of time.');
  assert.equal(conditionWords('transport-failed', details), 'Team could not reach the Action.');
});

test("an attempt's heading names its recorded position, so one Action's attempts at two positions read apart", () => {
  const attempt = (step) => ({ assistant_id: 'shimpz-cloudflare', action: 'list-dns-records', position: { phase: 'replay', step }, attempt: 1 });
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    const [second, fifth] = [attempt(2), attempt(5)].map((item) => attemptWords(item, catalog.details.attempt));
    assert.notEqual(second, fifth, locale);
    assert.doesNotMatch(second, /\{\w+\}/u, locale);
    assert.match(fifth, /5/u, locale);
  }
  assert.equal(
    attemptWords(attempt(2), routineMessages.en.details.attempt, { assistant: () => 'Shimpz Cloudflare', action: () => 'List DNS records' }),
    'Step 2: Shimpz Cloudflare · List DNS records, attempt 1',
  );
});

test('every interface language words the run view with the same keys', () => {
  const keys = (value) => Object.entries(value).flatMap(([key, item]) => (
    typeof item === 'object' ? keys(item).map((inner) => `${key}.${inner}`) : [key]
  )).sort();
  const english = keys(routineMessages.en.result);
  for (const [locale, messages] of Object.entries(routineMessages)) {
    assert.deepEqual(keys(messages.result), english, locale);
    for (const value of Object.values(messages.result).flatMap((item) => (typeof item === 'object' ? Object.values(item) : [item]))) {
      assert.equal(typeof value, 'string');
      assert.ok(value.length > 0, locale);
    }
  }
});
