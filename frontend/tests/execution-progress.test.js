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
  const labels = messages.pt.chatPage.progress;
  const context = {
    teamName: 'Marketing',
    assistantNames: new Map([['shimpz-cloudflare', 'Shimpz Cloudflare']]),
  };
  const visible = (value) => value.replaceAll(/[\u2068\u2069]/gu, '');
  const narrative = executionSteps(events).map((step) => visible(localizedStepLabel(step, labels, context)));

  assert.equal(narrative[0], 'O Admin prepara uma solicitação segura para Marketing');
  assert.equal(narrative[2], 'Marketing decide como tratar sua solicitação');
  assert.equal(narrative[4], 'Shimpz Cloudflare executa List Zones para Marketing');
  assert.equal(narrative[5], 'Marketing avalia os resultados devolvidos pelos Assistants');
  assert.equal(narrative[6], 'Marketing registra os resultados de Actions aceitos pelo modelo');
  assert.equal(narrative[7], 'Marketing prepara as próximas ações de Assistants solicitadas pelo modelo');
  assert.equal(narrative[8], 'Shimpz Cloudflare executa List Zones novamente para Marketing');
  assert.ok(narrative.every((label) => !label.includes('Action 1')));
});

test('renders a resumed partial stream without inventing an absolute round', () => {
  const steps = executionSteps([
    { seq: 1, origin: 'team', phase: 'action-preparation', state: 'started' },
    {
      seq: 2, origin: 'team', phase: 'action', state: 'started', assistant_id: 'helper',
      action: 'lookup', index: 1, total: 1,
    },
  ]);
  const labels = messages.en.chatPage.progress;
  const first = localizedStepLabel(steps[0], labels, { teamName: 'Research' });
  const second = localizedStepLabel(steps[1], labels, { teamName: 'Research' });

  assert.match(first, /prepares the Assistant actions/);
  assert.match(second, /runs.*Lookup.*Research/);
  assert.doesNotMatch(`${first} ${second}`, /round|cycle/i);
});

test('narrates the final context check truthfully for a Brain-only turn', () => {
  const steps = executionSteps([
    { seq: 1, origin: 'team', phase: 'team-context', state: 'started' },
    { seq: 2, origin: 'team', phase: 'model', state: 'started' },
    { seq: 3, origin: 'team', phase: 'team-context', state: 'started' },
  ]);
  const labels = messages.en.chatPage.progress;
  const narrative = steps.map((step) => localizedStepLabel(step, labels, { teamName: 'Research' }));

  assert.match(narrative[0], /assembles the context/);
  assert.match(narrative[1], /decides how to handle/);
  assert.match(narrative[2], /verifies that its context still matches/);
  assert.doesNotMatch(narrative[2], /assembles/);
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
