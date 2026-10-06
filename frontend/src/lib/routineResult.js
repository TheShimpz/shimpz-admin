// A completed Routine run as its run view shows it (ADR-0092 amendment, 2026-10-05, output and scale): each step as the
// run recorded it, the failed attempts Team recorded, and the result Team projected, organized for reading. Pure data
// shaping only: every value stays Team's node, rendered later as escaped text.

import { humanizeId, outputLabels } from './routine.js';

const SCALAR_KINDS = new Set(['null', 'redacted', 'elided', 'bool', 'number', 'text']);
// Values that say nothing about a column's kind: an absent, hidden, or cut-away value.
const BLANK_KINDS = new Set(['null', 'redacted', 'elided']);
const NAME_KEYS = new Set(['name', 'title', 'label', 'hostname', 'domain']);
const STATUS_KEYS = new Set(['status', 'state']);
const ID_KEY_RE = /(?:^|[_-])(?:id|uuid)$/iu;
const ID_VALUE_RE = /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const MAX_STATUS_CHARS = 32;
// A table wider than this reads better as records.
export const MAX_RESULT_COLUMNS = 16;

/** Whether a node of a shown result is one value rather than a list or a field set. */
export function isScalar(node) {
  return SCALAR_KINDS.has(node?.kind);
}

// A field set every one of whose values is a scalar, which Team did not cut short: it can spread into columns.
function flatFields(node) {
  return node.kind === 'fields' && node.omitted === 0 && node.fields.length > 0 && node.fields.every(([, value]) => isScalar(value));
}

function leafRank(key) {
  const leaf = key.toLowerCase();
  if (NAME_KEYS.has(leaf)) return 0;
  return ID_KEY_RE.test(leaf) ? 2 : 1;
}

// A stable order that reads like a record: its name first, identifiers last, everything else as Team ordered it.
function readingOrder(keys) {
  return keys.map((key, index) => ({ key, index }))
    .sort((a, b) => leafRank(a.key) - leafRank(b.key) || a.index - b.index)
    .map((item) => item.key);
}

/**
 * How a set of values of one key reads: `id` for identifiers (an id-like key, or every value a long hex string or a
 * UUID), `number`, `bool`, `status` for short words under a status or state key, or `text`.
 */
export function valueKind(key, nodes) {
  const present = nodes.filter((node) => node && !BLANK_KINDS.has(node.kind));
  if (present.length === 0) return 'text';
  if (present.every((node) => node.kind === 'bool')) return 'bool';
  if (present.every((node) => node.kind === 'number')) return 'number';
  if (!present.every((node) => node.kind === 'text')) return 'text';
  if (ID_KEY_RE.test(key) || present.every((node) => ID_VALUE_RE.test(node.value))) return 'id';
  const short = present.every((node) => [...node.value].length <= MAX_STATUS_CHARS && !/\s{2,}|\n/u.test(node.value));
  return STATUS_KEYS.has(key.toLowerCase()) && short ? 'status' : 'text';
}

// Labels for column paths: "account" and "name" read "Account name" while every label stays distinct; otherwise each
// reads as Team wrote its keys, joined by " › ", and a label that still repeats takes the first number that no other
// label reads, so no two columns read alike.
function pathLabels(paths) {
  const humanized = paths.map((path) => humanizeId(path.join('_')));
  if (new Set(humanized).size === paths.length) return humanized;
  const raw = paths.map((path) => path.join(' › '));
  const single = (label) => raw.indexOf(label) === raw.lastIndexOf(label);
  const taken = new Set(raw.filter(single));
  return raw.map((label) => {
    if (single(label)) return label;
    let n = 1;
    while (taken.has(`${label} (${n})`)) n += 1;
    taken.add(`${label} (${n})`);
    return `${label} (${n})`;
  });
}

// The column paths of a table's rows: each key once, and, when `spread`, a key whose value is in every row absent,
// null, or a flat field set becomes one path per inner key.
function columnPaths(rows, keys, spread) {
  return keys.flatMap((key) => {
    const values = rows.map((row) => row.get(key)).filter((value) => value !== undefined && value.kind !== 'null');
    if (!spread || values.length === 0 || !values.every(flatFields)) return [[key]];
    return readingOrder([...new Set(values.flatMap((value) => value.fields.map(([child]) => child)))]).map((child) => [key, child]);
  });
}

function cellAt(row, [key, child]) {
  const value = row.get(key) ?? null;
  if (child === undefined || value === null || value.kind !== 'fields') return value;
  return new Map(value.fields).get(child) ?? null;
}

/**
 * A list of field sets as one table, or null: every item a field set Team did not cut short. A field whose value is,
 * in every row, absent, null, or a flat field set spreads into one column per inner field ("Account name", "Account
 * ID") while the table stays within `maximum` columns; otherwise it keeps one column. Columns read name first and
 * identifiers last, and each says how its values read. A cell is the row's node for its column, or null when the row
 * has none; nothing a row carries is dropped.
 */
export function resultTable(node, maximum = MAX_RESULT_COLUMNS) {
  if (node.kind !== 'list' || node.items.length === 0 || !node.items.every((item) => item.kind === 'fields' && item.omitted === 0)) {
    return null;
  }
  const rows = node.items.map((item) => new Map(item.fields));
  const keys = readingOrder([...new Set(node.items.flatMap((item) => item.fields.map(([key]) => key)))]);
  const spread = columnPaths(rows, keys, true);
  const paths = spread.length <= maximum ? spread : columnPaths(rows, keys, false);
  if (paths.length === 0 || paths.length > maximum) return null;
  const cells = rows.map((row) => paths.map((path) => cellAt(row, path)));
  const labels = pathLabels(paths);
  return {
    columns: paths.map((path, index) => ({
      label: labels[index],
      kind: valueKind(path.at(-1), cells.map((row) => row[index])),
    })),
    rows: cells,
    omitted: node.omitted,
  };
}

function block(label, node) {
  if (isScalar(node)) return { label, kind: 'value', node };
  if (node.kind === 'list') {
    const table = resultTable(node);
    if (table) return { label, kind: 'table', table, omitted: node.omitted };
    if (node.items.every(isScalar)) return { label, kind: 'values', items: node.items, omitted: node.omitted };
    return { label, kind: 'node', node };
  }
  return { label, kind: 'view', view: resultView(node) };
}

function summaryItems(fields) {
  const labels = outputLabels(fields.map(([key]) => key));
  return fields.map(([key, value], index) => ({ label: labels[index], kind: valueKind(key, [value]), node: value }));
}

/**
 * A shown result as its run view reads it: a field set's single values as one compact summary group, each flat inner
 * field set as a summary group of its own, then one block per list or deeper field set: a table, a row of values, a
 * nested view, or the plain node. A list or a single value at the top is one unlabeled block.
 */
export function resultView(node) {
  if (node.kind !== 'fields') return { summary: [], blocks: [block('', node)], omitted: 0 };
  const labels = outputLabels(node.fields.map(([key]) => key));
  const loose = [];
  const groups = [];
  const blocks = [];
  node.fields.forEach(([key, value], index) => {
    if (isScalar(value)) loose.push([key, value]);
    else if (flatFields(value)) groups.push({ label: labels[index], items: summaryItems(value.fields) });
    else blocks.push(block(labels[index], value));
  });
  const summary = loose.length ? [{ label: '', items: summaryItems(loose) }, ...groups] : groups;
  return { summary, blocks, omitted: node.omitted };
}

/** The key of a recorded position: a replay step's or a decision call's, which never read alike. */
export function positionKey(position) {
  return position.phase === 'replay' ? `replay:${position.step}` : `decision:${position.call}`;
}

/**
 * A run's recorded failed attempts beside the entries they belong to: each attempt names its position, a replay step
 * or a decision call, and one that names a position beyond the run's `replay` steps or its `total` entries is kept
 * apart, never guessed.
 */
export function attemptsByStep(diagnostics, replay, total) {
  const byStep = new Map();
  const apart = [];
  for (const item of diagnostics) {
    const { phase, step, call } = item.position;
    if (phase === 'replay' ? step > replay : replay + call > total) apart.push(item);
    else byStep.set(positionKey(item.position), [...(byStep.get(positionKey(item.position)) ?? []), item]);
  }
  return { byStep, apart };
}

/** How long a step's attempt took, in the viewer's locale: milliseconds under a second, else seconds or minutes. */
export function durationWords(ms, locale) {
  const unit = (value, name, digits = 0) => new Intl.NumberFormat(locale, {
    style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: digits,
  }).format(value);
  if (ms < 1_000) return unit(ms, 'millisecond');
  if (ms < 60_000) return unit(ms / 1_000, 'second', 1);
  return unit(ms / 60_000, 'minute', 1);
}

/** The steps a list shows when it reveals `page` steps at a time and the person asked for more `pages` times. */
export function visibleSteps(steps, pages, page = 10) {
  return steps.slice(0, Math.max(1, pages) * page);
}
