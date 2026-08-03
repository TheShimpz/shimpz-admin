import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executionSteps,
  formatExecutionDuration,
  technicalStepLabel,
} from '../src/lib/executionProgress.js';

test('pairs repeated measured operations without inventing workflow stages', () => {
  const steps = executionSteps([
    { seq: 1, origin: 'team', phase: 'model', state: 'started' },
    { seq: 2, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 1200 },
    { seq: 3, origin: 'team', phase: 'power', state: 'started', index: 1, total: 2 },
    { seq: 4, origin: 'team', phase: 'power', state: 'finished', elapsed_ms: 25, index: 1, total: 2 },
    { seq: 5, origin: 'team', phase: 'model', state: 'started' },
  ]);

  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((step) => step.elapsed_ms), [1200, 25, null]);
  assert.equal(technicalStepLabel(steps[1]), 'team · power 1/2');
});

test('formats only bounded measured durations', () => {
  assert.equal(formatExecutionDuration(0), '0 ms');
  assert.equal(formatExecutionDuration(999), '999 ms');
  assert.equal(formatExecutionDuration(1200), '1.2 s');
  assert.equal(formatExecutionDuration(65_000), '1m 05s');
  assert.equal(formatExecutionDuration(-1), '');
});
