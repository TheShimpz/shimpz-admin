// The Team protocol mirror Admin builds from (ADR-0101): the string literals of one Rust constant, in source order.
// A constant this cannot find fails the test that reads it; it never passes silently.
import { readFileSync } from 'node:fs';

// `file` is the mirror source's path relative to this directory, written out by each caller.
export function constantStrings(file, name) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = source.indexOf(`pub const ${name}: `);
  if (start < 0) throw new Error(`${name} is not a constant of ${file}`);
  const open = source.indexOf('= [', start);
  const close = source.indexOf('];', open);
  if (open < 0 || close < 0) throw new Error(`${name} is not an array constant`);
  return [...source.slice(open, close).matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(([, literal]) => JSON.parse(`"${literal}"`));
}

// The constant's literals taken `size` at a time: one tuple each.
export function constantTuples(file, name, size) {
  const strings = constantStrings(file, name);
  if (strings.length % size !== 0) throw new Error(`${name} does not hold ${size}-string tuples`);
  return Array.from({ length: strings.length / size }, (_, index) => strings.slice(index * size, (index + 1) * size));
}
