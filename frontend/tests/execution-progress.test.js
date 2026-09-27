import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExecutionProjection,
  executionSteps,
  executionStepCount,
  extendExecutionProjection,
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
    {
      seq: 3, origin: 'team', phase: 'action', state: 'started',
      assistant_id: 'shimpz-cloudflare', action: 'list-zones', index: 1, total: 2,
    },
    {
      seq: 4, origin: 'team', phase: 'action', state: 'finished', elapsed_ms: 25,
      assistant_id: 'shimpz-cloudflare', action: 'list-zones', index: 1, total: 2,
    },
    { seq: 5, origin: 'team', phase: 'model', state: 'started' },
  ]);

  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((step) => step.elapsed_ms), [1200, 25, null]);
  assert.equal(technicalStepLabel(steps[1]), 'team · action 1/2');
});

test('incremental projection preserves nested pairing, orphan finishes, and narrative order', () => {
  const events = [
    { seq: 1, origin: 'team', phase: 'model', state: 'started' },
    { seq: 2, origin: 'team', phase: 'model', state: 'started' },
    { seq: 3, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 2 },
    { seq: 4, origin: 'team', phase: 'action', state: 'started',
      assistant_id: 'helper', action: 'lookup', index: 1, total: 1 },
    { seq: 5, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 4 },
    { seq: 6, origin: 'team', phase: 'action', state: 'finished', elapsed_ms: 6,
      assistant_id: 'helper', action: 'lookup', index: 1, total: 1 },
    { seq: 7, origin: 'team', phase: 'action', state: 'finished', elapsed_ms: 7,
      assistant_id: 'helper', action: 'lookup', index: 1, total: 1 },
  ];
  const projection = createExecutionProjection();
  for (const [index, event] of events.entries()) {
    extendExecutionProjection(projection, event);
    assert.deepEqual(projection.steps, executionSteps(events.slice(0, index + 1)));
    assert.equal(executionStepCount(events.slice(0, index + 1)), projection.steps.length);
    assert.equal(projection.currentIndex,
      projection.steps.findLastIndex((step) => step.elapsed_ms === null));
  }
  assert.deepEqual(projection.steps.map((step) => step.elapsed_ms), [4, 2, 6, 7]);
  assert.deepEqual(projection.steps.map((step) => step.observedModelsBefore), [0, 1, 2, 2]);
  assert.deepEqual(projection.steps.map((step) => step.actionOccurrence),
    [undefined, undefined, 1, 2]);
  const restarted = createExecutionProjection();
  extendExecutionProjection(restarted, events[0]);
  assert.equal(restarted.steps.length, 1);
  assert.equal(restarted.steps[0].observedModelsBefore, 0);
});

test('current step follows the newest surviving phase across overlapping identities', () => {
  const projection = createExecutionProjection();
  const events = [
    { seq: 1, origin: 'team', phase: 'model', state: 'started' },
    { seq: 2, origin: 'team', phase: 'team-context', state: 'started' },
    { seq: 3, origin: 'team', phase: 'model', state: 'started' },
    { seq: 4, origin: 'team', phase: 'action-preparation', state: 'started' },
    { seq: 5, origin: 'team', phase: 'action-preparation', state: 'finished', elapsed_ms: 2 },
    { seq: 6, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 4 },
    { seq: 7, origin: 'team', phase: 'team-context', state: 'finished', elapsed_ms: 6 },
    { seq: 8, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 8 },
  ];
  for (const [index, event] of events.entries()) {
    extendExecutionProjection(projection, event);
    assert.equal(projection.currentIndex, [0, 1, 2, 3, 2, 1, 0, -1][index]);
  }
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
        index: phase === 'action' ? 1 : undefined,
        total: phase === 'action' ? 2 : undefined,
        assistant_id: phase === 'action' ? 'shimpz-cloudflare' : undefined,
        action: phase === 'action' ? 'list-zones' : undefined,
        observedActionsBefore: phase === 'team-context' || phase === 'model' ? 0 : undefined,
        actionOccurrence: phase === 'action' ? 1 : undefined,
      };
      const label = localizedStepLabel(step, copy.chatPage.progress, {
        teamName: 'Marketing',
        assistantNames: new Map([['shimpz-cloudflare', 'Shimpz Cloudflare']]),
      });
      assert.doesNotMatch(label, /admin-preparation|reply-validation|team-context|action-preparation/);
      assert.doesNotMatch(label, /\{index\}|\{total\}/);
      assert.ok(label.length > 10, `${locale}: ${label}`);
      assert.doesNotMatch(label, /\{team\}|\{assistant\}|\{action\}/);
    }

    const event = { origin: 'team', phase: 'model', state: 'started' };
    assert.equal(
      localizedEventLabel(event, copy.chatPage.progress, { teamName: 'Marketing' }),
      `${localizedStepLabel(event, copy.chatPage.progress, { teamName: 'Marketing' })} · ${copy.chatPage.progress.states.started}`,
      locale,
    );
    assert.deepEqual(
      Object.keys(copy.chatPage.progress.narrative).sort(),
      Object.keys(messages.en.chatPage.progress.narrative).sort(),
      locale,
    );
  }
});

const TEST_NARRATIVE = {
  narrative: {
    adminPreparation: 'admin-preparation',
    replyValidation: 'reply-validation',
    teamContextInitial: 'context-initial',
    teamContextFinal: 'context-final',
    modelInitial: 'model-initial',
    modelAfterAction: 'model-after-action',
    actionPreparation: 'action-preparation',
    actionPreparationAgain: 'action-preparation-again',
    action: 'action {assistant}/{action}',
    actionAgain: 'action-again {assistant}/{action}',
    actionPosition: '· {index}/{total}',
    actionDelivery: 'action-delivery',
  },
};

test('turns repeated Action calls into one truthful contextual narrative', () => {
  const events = [
    { seq: 1, origin: 'admin', phase: 'admin-preparation', state: 'started' },
    { seq: 2, origin: 'admin', phase: 'admin-preparation', state: 'finished', elapsed_ms: 4 },
    { seq: 3, origin: 'team', phase: 'team-context', state: 'started' },
    { seq: 4, origin: 'team', phase: 'team-context', state: 'finished', elapsed_ms: 12 },
    { seq: 5, origin: 'team', phase: 'model', state: 'started' },
    { seq: 6, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 500 },
    { seq: 7, origin: 'team', phase: 'action-preparation', state: 'started' },
    { seq: 8, origin: 'team', phase: 'action-preparation', state: 'finished', elapsed_ms: 8 },
    {
      seq: 9, origin: 'team', phase: 'action', state: 'started', assistant_id: 'shimpz-cloudflare',
      action: 'list-zones', index: 1, total: 1,
    },
    {
      seq: 10, origin: 'team', phase: 'action', state: 'finished', elapsed_ms: 90,
      assistant_id: 'shimpz-cloudflare', action: 'list-zones', index: 1, total: 1,
    },
    { seq: 11, origin: 'team', phase: 'model', state: 'started' },
    { seq: 12, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 200 },
    { seq: 13, origin: 'team', phase: 'action-delivery', state: 'started' },
    { seq: 14, origin: 'team', phase: 'action-delivery', state: 'finished', elapsed_ms: 1 },
    { seq: 15, origin: 'team', phase: 'action-preparation', state: 'started' },
    {
      seq: 16, origin: 'team', phase: 'action', state: 'started', assistant_id: 'shimpz-cloudflare',
      action: 'list-zones', index: 1, total: 1,
    },
  ];
  const context = {
    teamName: 'Marketing',
    assistantNames: new Map([['shimpz-cloudflare', 'Shimpz Cloudflare']]),
  };
  const narrative = executionSteps(events).map((step) => localizedStepLabel(step, TEST_NARRATIVE, context));

  assert.deepEqual(narrative, [
    'admin-preparation',
    'context-initial',
    'model-initial',
    'action-preparation',
    'action \u2068Shimpz Cloudflare\u2069/\u2068List Zones\u2069',
    'model-after-action',
    'action-delivery',
    'action-preparation-again',
    'action-again \u2068Shimpz Cloudflare\u2069/\u2068List Zones\u2069',
  ]);
});

test('renders a resumed partial stream without inventing an absolute round', () => {
  const steps = executionSteps([
    { seq: 1, origin: 'team', phase: 'action-preparation', state: 'started' },
    {
      seq: 2, origin: 'team', phase: 'action', state: 'started', assistant_id: 'helper',
      action: 'lookup', index: 1, total: 1,
    },
  ]);
  const first = localizedStepLabel(steps[0], TEST_NARRATIVE, { teamName: 'Research' });
  const second = localizedStepLabel(steps[1], TEST_NARRATIVE, { teamName: 'Research' });

  assert.equal(first, 'action-preparation');
  assert.equal(second, 'action \u2068Helper\u2069/\u2068Lookup\u2069');
});

test('narrates the final context check truthfully for a Brain-only turn', () => {
  const steps = executionSteps([
    { seq: 1, origin: 'team', phase: 'team-context', state: 'started' },
    { seq: 2, origin: 'team', phase: 'model', state: 'started' },
    { seq: 3, origin: 'team', phase: 'team-context', state: 'started' },
  ]);
  const narrative = steps.map((step) => localizedStepLabel(step, TEST_NARRATIVE, { teamName: 'Research' }));

  assert.deepEqual(narrative, ['context-initial', 'model-initial', 'context-final']);
});

test('every locale resolves every narrative variant without placeholder remnants', () => {
  const variants = [
    { origin: 'admin', phase: 'admin-preparation' },
    { origin: 'admin', phase: 'reply-validation' },
    { origin: 'team', phase: 'team-context', observedModelsBefore: 0 },
    { origin: 'team', phase: 'team-context', observedModelsBefore: 1 },
    { origin: 'team', phase: 'model', observedActionsBefore: 0 },
    { origin: 'team', phase: 'model', observedActionsBefore: 1 },
    { origin: 'team', phase: 'action-preparation', observedActionsBefore: 0 },
    { origin: 'team', phase: 'action-preparation', observedActionsBefore: 1 },
    {
      origin: 'team', phase: 'action', assistant_id: 'shimpz-cloudflare', action: 'list-zones',
      actionOccurrence: 1, index: 1, total: 2,
    },
    {
      origin: 'team', phase: 'action', assistant_id: 'shimpz-cloudflare', action: 'list-zones',
      actionOccurrence: 2, index: 2, total: 2,
    },
    { origin: 'team', phase: 'action-delivery' },
  ];
  const context = {
    teamName: 'Marketing',
    assistantNames: new Map([['shimpz-cloudflare', 'Shimpz Cloudflare']]),
  };

  for (const [locale, copy] of Object.entries(messages)) {
    for (const step of variants) {
      const label = localizedStepLabel(step, copy.chatPage.progress, context);
      assert.doesNotMatch(label, /[{}]/, `${locale}: ${label}`);
    }
  }
});

test('counts the same observed rows when a finish has no observed start', () => {
  const events = [
    { seq: 1, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 5 },
  ];

  assert.equal(executionStepCount(events), executionSteps(events).length);
  assert.equal(executionStepCount(events), 1);
});
