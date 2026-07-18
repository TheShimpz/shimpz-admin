import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/routes/teams/+page.ts', import.meta.url),
  'utf8',
);

test('redirects the retired Teams page to the persistent Chat workspace', () => {
  assert.match(source, /redirect\(308, '\/chat\/'\)/);
  assert.doesNotMatch(source, /\/api\/teams|TeamCard|create|destroy/);
});
