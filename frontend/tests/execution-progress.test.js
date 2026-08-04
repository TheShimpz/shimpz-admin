import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executionSteps,
  executionStepCount,
  formatExecutionDuration,
  localizedEventLabel,
  localizedStepLabel,
  technicalStepLabel,
} from '../src/lib/executionProgress.js';
import { CHAT_PROGRESS_PHASES } from '../src/lib/localChat.js';
import { messages } from '../src/lib/messages.js';

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

test('humanizes every observed phase in every supported Admin locale', () => {
  for (const [locale, copy] of Object.entries(messages)) {
    assert.deepEqual(
      Object.keys(copy.chatPage.progress.phases).sort(),
      [...CHAT_PROGRESS_PHASES].sort(),
      locale,
    );
    for (const phase of CHAT_PROGRESS_PHASES) {
      const step = {
        origin: phase.startsWith('admin') || phase === 'reply-validation' ? 'admin' : 'team',
        phase,
        index: phase === 'power' ? 1 : undefined,
        total: phase === 'power' ? 2 : undefined,
      };
      const label = localizedStepLabel(step, copy.chatPage.progress);
      assert.doesNotMatch(label, /admin-preparation|reply-validation|team-context|power-preparation/);
      assert.doesNotMatch(label, /\{index\}|\{total\}/);
      assert.ok(label.includes(' · '), `${locale}: ${label}`);
    }

    const event = { origin: 'team', phase: 'model', state: 'started' };
    assert.equal(
      localizedEventLabel(event, copy.chatPage.progress),
      `${copy.chatPage.progress.origins.team} · ${copy.chatPage.progress.phases.model} · ${copy.chatPage.progress.states.started}`,
      locale,
    );
  }
});

test('counts the same observed rows when a finish has no observed start', () => {
  const events = [
    { seq: 1, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 5 },
  ];

  assert.equal(executionStepCount(events), executionSteps(events).length);
  assert.equal(executionStepCount(events), 1);
});
