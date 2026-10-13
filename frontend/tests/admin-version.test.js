import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVersion } from '../src/lib/space/version.js';

const revision = '4a50863d1c0e2f7a9b3c5d6e7f8091a2b3c4d5e6';

test('names a built Admin by its commit date and short revision', () => {
  assert.equal(buildVersion('1791884573', revision), 'v2026.10.13-4a50863');
});

test('names a build without a revision dev', () => {
  assert.equal(buildVersion(undefined, undefined), 'dev');
  assert.equal(buildVersion('0', ''), 'dev');
});

test('refuses a build whose revision or commit time is malformed', () => {
  for (const [epoch, value] of [
    [undefined, revision],
    ['0', revision],
    ['1791884573', revision.slice(0, 39)],
    ['1791884573', revision.toUpperCase()],
    ['17918845.73', revision],
  ]) {
    assert.throws(() => buildVersion(epoch, value), /revision is invalid/);
  }
});
