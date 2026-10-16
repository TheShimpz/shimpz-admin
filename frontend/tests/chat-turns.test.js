import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cardAnswers,
  expiredTurns,
  friendlyChatError,
  groupExchanges,
  historyTurn,
  installPlanIconStatus,
  installPlanStatus,
  installPlanTurns,
  installPlanVisualState,
  installText,
  lifecycleStatus,
  lifecycleTurnIndex,
  lifecycleTurns,
  lifecycleVisualState,
  projectedChatError,
  replyFields,
  shownUsage,
} from '../src/lib/chat/turns.js';
import { messages } from '../src/lib/i18n/catalogs.js';

const WORDS = { ...messages.en.chatPage, limit: 'This Team already has the maximum of 16 Assistants.' };
const ASSISTANT = {
  id: 'shimpz-cloudflare',
  name: 'Shimpz Cloudflare',
  summary: 'Safely manage Cloudflare DNS records.',
  creator: '@shimpz',
  version: '0.4.5',
  providers: ['cloudflare'],
  provenance: 'published',
  status: 'pending',
};
const PLAN_ID = 'c'.repeat(32);
const PROPOSAL_ID = 'd'.repeat(32);

function plan(state, statuses, extra = {}) {
  return {
    type: 'assistant-install-plan',
    state,
    plan_id: PLAN_ID,
    team_id: 'marketing',
    team_name: 'Marketing',
    assistants: statuses.map((status) => ({ ...ASSISTANT, status })),
    ...extra,
  };
}

test('groups each user message with the reply that answered it, and a lone reply on its own', () => {
  const turns = [
    { renderKey: 1, role: 'assistant' },
    { renderKey: 2, role: 'user' },
    { renderKey: 3, role: 'assistant' },
    { renderKey: 4, role: 'user' },
  ];
  assert.deepEqual(groupExchanges(turns).map(({ key, user, assistant }) => [key, user?.renderKey, assistant?.renderKey]), [
    [1, undefined, 1],
    [2, 2, 3],
    [4, 4, undefined],
  ]);
});

test("a card's answer hides a card's empty reply once its Routine exists, and only a change shows the answer itself", () => {
  const card = (id) => ({ proposal_id: id.repeat(32) });
  // A card Team records from the person's answer, or the Brain records saying it, comes with no text.
  const fixed = '';
  const answer = (id, status) => ({ routineAnswer: { proposalId: id.repeat(32), status, name: 'X' } });
  const turns = [
    { renderKey: 1, role: 'user' },
    { renderKey: 2, role: 'assistant', text: fixed, routineProposal: card('a') },
    { renderKey: 3, role: 'assistant', ...answer('a', 'created') },
    { renderKey: 4, role: 'user' },
    // A reply of the agent's own words keeps them; a cancelled card keeps its reply.
    { renderKey: 5, role: 'assistant', text: 'Listei os jogos.', routineProposal: card('b') },
    { renderKey: 6, role: 'assistant', ...answer('b', 'changed') },
    { renderKey: 7, role: 'user' },
    { renderKey: 8, role: 'assistant', text: fixed, routineProposal: card('c') },
    { renderKey: 9, role: 'assistant', ...answer('c', 'revoked') },
  ];
  const answers = cardAnswers(turns);
  assert.deepEqual([...answers.values()], ['created', 'changed', 'revoked']);
  const shown = groupExchanges(turns, answers).map(({ user, assistant }) => [user?.renderKey, assistant?.renderKey]);
  // A creation is said by its Routine's own creation notice; a change by the answer; a cancel by the card.
  assert.deepEqual(shown, [[1, undefined], [4, 5], [undefined, 6], [7, 8]]);
});

test('a receipt\'s rows set the usage duration shown, never below Team\'s own', () => {
  const usage = { durationMs: 1000, seconds: 1 };
  assert.deepEqual(shownUsage({ usage }), { usage, steps: [] });
  const receipt = [
    { seq: 1, origin: 'team', phase: 'model', state: 'started' },
    { seq: 2, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 1500 },
  ];
  const shown = shownUsage({ usage, receipt });
  assert.deepEqual(shown.usage, { durationMs: 1000, seconds: 1.5 });
  assert.deepEqual(shown.steps.map((step) => step.elapsed_ms), [1500]);
  assert.deepEqual(shownUsage({ receipt }), { usage: undefined, steps: [] });
});

test('a reply carries the same fields from a live frame and from its stored row', () => {
  const usage = { duration_ms: 1200, models: [] };
  const receipt = [{ segment: 0, seq: 1, origin: 'team', phase: 'model', state: 'started' }];
  const source = {
    clarification: { question: 'Which zone?' },
    usage,
    receipt,
    routine_proposal: { proposal_id: 'p' },
    routine_refusal: { code: 'x' },
    routine_question: { code: 'y' },
  };
  const fields = replyFields(source);
  assert.deepEqual(Object.keys(fields), [
    'clarification', 'usage', 'receipt', 'routineProposal', 'routineRefusal', 'routineQuestion',
  ]);
  assert.equal(fields.receipt, receipt);
  assert.equal(fields.usage.durationMs, 1200);
  assert.deepEqual(replyFields({}), {});
});

test('a stored reply restores the receipt its live turn showed', () => {
  const usage = { duration_ms: 6240, models: [] };
  // The live page's receipt: Admin's own step, Team's model call, and, after a human request, the Action it ran.
  const live = [
    { type: 'progress', seq: 1, origin: 'admin', phase: 'admin-preparation', state: 'started', segment: 0 },
    { type: 'progress', seq: 2, origin: 'team', phase: 'model', state: 'started', segment: 0 },
    { type: 'progress', seq: 3, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 1240, segment: 0 },
    {
      type: 'progress', seq: 1, origin: 'team', phase: 'action', state: 'finished', elapsed_ms: 70, segment: 1,
      assistant_id: 'shimpz-cloudflare', action: 'list-zones', index: 1, total: 1,
    },
  ];
  // What Admin stores of it: Team's steps, each with its delivery and sequence.
  const stored = live.filter((event) => event.origin === 'team').map(({ type: _type, ...event }) => event);
  const liveTurn = { role: 'assistant', text: 'Two zones.', author: 'Marketing', receipt: live, ...replyFields({ usage }) };
  const restored = historyTurn({
    id: 'r', createdAt: '2026-10-02T21:15:00Z', kind: 'message', role: 'assistant', text: 'Two zones.',
    author: 'Marketing', usage, receipt: stored,
  }, 'Marketing', 4, WORDS);
  assert.deepEqual(restored.receipt, stored);
  assert.deepEqual(shownUsage(restored).usage, shownUsage(liveTurn).usage);
  const steps = (turn) => shownUsage(turn).steps.map(({ key: _key, ...step }) => step);
  assert.deepEqual(steps(restored), steps(liveTurn));
  assert.equal(steps(restored).length, 3);
});

test('an install ends in words: installed or already installed, refused at the limit or otherwise, or cut off', () => {
  assert.equal(installText('installed', undefined, undefined, WORDS), WORDS.install.complete);
  assert.equal(installText('installed', 'already-installed', undefined, WORDS), WORDS.install.already);
  assert.equal(installText('failed', undefined, 'assistant_limit_reached', WORDS), WORDS.limit);
  assert.equal(installText('failed', undefined, undefined, WORDS), WORDS.install.failed);
  assert.equal(installText('stopped', undefined, undefined, WORDS), WORDS.disconnected);
});

test('a stored row becomes the turn the live conversation showed, carrying the render identity it is given', () => {
  const at = '2026-10-02T21:15:00Z';
  const user = historyTurn({
    id: 'u', createdAt: at, kind: 'message', role: 'user', text: 'Hi',
    files: [{ id: 'f'.repeat(32), name: 'a.png', size: 3, media_type: 'image/png' }],
  }, 'Marketing', 7, WORDS);
  assert.deepEqual(user, {
    renderKey: 7, historyId: 'u', createdAt: at, role: 'user', text: 'Hi',
    // The reference keeps the stored id and media type beside its render key, so the reloaded image can show again.
    files: [{ key: 'f'.repeat(32), id: 'f'.repeat(32), name: 'a.png', mediaType: 'image/png', size: 3, kind: 'image', note: '' }],
  });
  const reply = historyTurn({ id: 'r', createdAt: at, kind: 'message', role: 'assistant', text: 'Yes', author: 'Neo' },
    'Marketing', 8, WORDS);
  assert.equal(reply.author, 'Neo');
  const guidance = historyTurn({ id: 'g', createdAt: at, kind: 'guidance', reply: 'Use *one*' }, 'Marketing', 9, WORDS);
  assert.equal(guidance.text, 'Use \\*one\\*');
  assert.equal(guidance.author, 'Marketing');
  const install = historyTurn({
    id: 'i', createdAt: at, kind: 'assistant-install', state: 'failed', assistants: [ASSISTANT], status: 409,
    code: 'assistant_limit_reached',
  }, 'Marketing', 10, WORDS);
  assert.equal(install.text, WORDS.limit);
  assert.deepEqual(install.installPlan, {
    plan_id: 'history-i', state: 'failed', assistants: [ASSISTANT], status: 409, code: 'assistant_limit_reached',
  });
  const run = { kind: 'routine-run', id: 'n' };
  assert.equal(historyTurn({ ...run, createdAt: at }, 'Marketing', 11, WORDS).routineRun.id, 'n');
  // A Routine's creation shows what its recording spent, as a reply does.
  const usage = { duration_ms: 6200, models: [{ provider: 'openai', model: 'gpt-6.1-sol', input_tokens: 9, output_tokens: 1 }] };
  const receipt = [{ segment: 0, seq: 1, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 900 }];
  const created = historyTurn({ ...run, outcome: 'created', usage, receipt, createdAt: at }, 'Marketing', 12, WORDS);
  assert.deepEqual([created.usage.tokens, created.usage.durationMs, created.receipt], [10, 6200, receipt]);
  const spentNothing = historyTurn({ ...run, outcome: 'created', usage: null, receipt: [], createdAt: at }, 'Marketing', 13, WORDS);
  assert.equal(Object.hasOwn(spentNothing, 'usage'), false);
  const uninstall = historyTurn({
    id: 'x', createdAt: at, kind: 'assistant-uninstall', state: 'uninstalled', uninstalled: false,
    assistant: { id: 'shimpz-cloudflare' },
  }, 'Marketing', 12, WORDS);
  assert.deepEqual(uninstall.lifecycle, {
    proposal_id: 'history-x', assistant: { id: 'shimpz-cloudflare' }, state: 'uninstalled', completionAnnounced: true,
    uninstalled: false,
  });
  const failed = historyTurn({ id: 'y', createdAt: at, kind: 'assistant-uninstall', state: 'failed', status: 503,
    assistant: { id: 'a' } }, 'Marketing', 13, WORDS);
  assert.equal(failed.lifecycle.status, 503);
});

test('an install plan adds its turn once and then only moves its Assistants forward', () => {
  let turns = installPlanTurns([], plan('planned', ['pending']), [], 1, WORDS);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].renderKey, 1);
  assert.equal(turns[0].text, WORDS.install.working);
  assert.throws(() => installPlanTurns(turns, plan('planned', ['pending']), [], 2, WORDS), /duplicate install plan/);
  turns = installPlanTurns(turns, plan('installing', ['installing']), [], 2, WORDS);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, WORDS.install.working);
  turns = installPlanTurns(turns, plan('installed', ['installed'], { continuation: 'none' }), [], 3, WORDS);
  assert.equal(turns[0].text, WORDS.install.complete);
  assert.throws(() => installPlanTurns(turns, plan('installing', ['installed']), [], 4, WORDS), /invalid install plan transition/);
  assert.throws(() => installPlanTurns([], plan('installing', ['installing']), [], 4, WORDS), /unknown install plan/);
  const other = { ...plan('installing', ['installing']), assistants: [{ ...ASSISTANT, name: 'Other', status: 'installing' }] };
  const planned = installPlanTurns([], plan('planned', ['pending']), [], 1, WORDS);
  assert.throws(() => installPlanTurns(planned, other, [], 4, WORDS), /mismatched install plan/);
  assert.throws(() => installPlanTurns(planned, plan('installing', ['installed']), [], 4, WORDS), /item transition/);
  const refused = installPlanTurns(planned, plan('failed', ['pending'], { status: 409, code: 'assistant_limit_reached' }),
    [], 4, WORDS);
  assert.equal(refused[0].text, WORDS.limit);
  assert.equal(refused[0].installPlan.code, 'assistant_limit_reached');
  assert.equal(installPlanTurns(planned, plan('stopped', ['pending']), [], 4, WORDS)[0].text, WORDS.disconnected);
  const already = installPlanTurns([], plan('installed', ['installed'], { outcome: 'already-installed' }), ['r'], 5, WORDS);
  assert.equal(already[0].text, WORDS.install.already);
  assert.deepEqual(already[0].receipt, ['r']);
  assert.throws(() => installPlanTurns(already, plan('installed', ['installed'], { outcome: 'already-installed' }), [], 6,
    WORDS), /duplicate install result/);
});

test('an uninstall proposal adds its card, and each later frame moves that card forward or is refused', () => {
  const assistant = { id: 'shimpz-cloudflare', name: 'Shimpz *Cloudflare*', version: '0.4.5' };
  const proposed = lifecycleTurns([], {
    state: 'proposed', proposal_id: PROPOSAL_ID, team_name: 'Marketing', assistant,
  }, [], 3, WORDS);
  assert.equal(proposed.terminal, true);
  assert.equal(proposed.turns[0].renderKey, 3);
  assert.match(proposed.turns[0].text, /Shimpz \\\*Cloudflare\\\*/);
  assert.equal(lifecycleTurnIndex(proposed.turns, PROPOSAL_ID), 0);
  assert.throws(() => lifecycleTurns(proposed.turns, { state: 'proposed', proposal_id: PROPOSAL_ID, assistant }, [], 4,
    WORDS), /duplicate lifecycle proposal/);
  const frame = (state, extra = {}) => ({ state, proposal_id: PROPOSAL_ID, assistant_id: assistant.id, ...extra });
  const working = lifecycleTurns(proposed.turns, frame('uninstalling'), [], 4, WORDS);
  assert.equal(working.terminal, false);
  assert.equal(working.turns[0].lifecycle.state, 'working');
  const done = lifecycleTurns(working.turns, frame('uninstalled', { uninstalled: true }), [], 4, WORDS);
  assert.equal(done.terminal, true);
  assert.equal(done.turns[0].lifecycle.uninstalled, true);
  const failed = lifecycleTurns(working.turns, frame('failed', { status: 503 }), [], 4, WORDS);
  assert.equal(failed.turns[0].lifecycle.status, 503);
  assert.throws(() => lifecycleTurns(done.turns, frame('uninstalling'), [], 4, WORDS), /invalid lifecycle transition/);
  assert.throws(() => lifecycleTurns([], frame('uninstalling'), [], 4, WORDS), /unknown lifecycle proposal/);
  assert.throws(() => lifecycleTurns(proposed.turns, { ...frame('cancelled'), assistant_id: 'other' }, [], 4, WORDS),
    /mismatched lifecycle proposal/);
  const expired = lifecycleTurns(proposed.turns, frame('expired'), [], 4, WORDS);
  assert.equal(lifecycleTurns(expired.turns, frame('expired'), [], 4, WORDS).turns[0].lifecycle.state, 'expired');
});

test('a lost connection leaves no card live', () => {
  const turns = [
    { lifecycle: { state: 'proposed' } },
    { lifecycle: { state: 'working' } },
    { lifecycle: { state: 'uninstalled' } },
    { installPlan: { state: 'installing', assistants: [{ status: 'installed' }, { status: 'installing' }] } },
    { installPlan: { state: 'installed', assistants: [] } },
    { text: 'plain' },
  ];
  const expired = expiredTurns(turns);
  assert.deepEqual(expired.map((turn) => turn.lifecycle?.state ?? turn.installPlan?.state ?? turn.text), [
    'expired', 'unknown', 'uninstalled', 'stopped', 'installed', 'plain',
  ]);
  assert.deepEqual(expired[3].installPlan.assistants.map((item) => item.status), ['installed', 'unknown']);
  assert.equal(expired[5], turns[5]);
});

test('names every card state and status in the chat\'s words', () => {
  assert.deepEqual(['proposed', 'working', 'uninstalled', 'cancelled', 'expired', 'failed'].map(lifecycleVisualState),
    ['pending', 'working', 'complete', 'cancelled', 'cancelled', 'failed']);
  const uninstall = WORDS.uninstall;
  assert.deepEqual([
    { state: 'proposed' }, { state: 'working' }, { state: 'uninstalled', uninstalled: true },
    { state: 'uninstalled', uninstalled: false }, { state: 'cancelled' }, { state: 'expired' }, { state: 'unknown' },
    { state: 'failed' },
  ].map((lifecycle) => lifecycleStatus(lifecycle, WORDS)), [
    uninstall.pending, uninstall.working, uninstall.complete, uninstall.absent, uninstall.cancelled, uninstall.expired,
    uninstall.unknown, uninstall.failed,
  ]);
  assert.deepEqual(['pending', 'installing', 'installed', 'failed'].map(installPlanVisualState),
    ['pending', 'working', 'complete', 'failed']);
  assert.deepEqual(['pending', 'installing', 'installed', 'unknown', 'failed'].map((status) => installPlanStatus(status,
    undefined, WORDS)), [WORDS.install.pending, WORDS.install.working, WORDS.install.complete, WORDS.disconnected,
    WORDS.install.failed]);
  assert.equal(installPlanStatus('installed', 'already-installed', WORDS), WORDS.install.already);
  assert.deepEqual(['pending', 'installing', 'installed', 'failed'].map((status) => installPlanIconStatus({ status })),
    ['loading', 'loading', 'failed', 'failed']);
});

test('a chat error reads as its words, with the technical detail unless the words already say everything', () => {
  assert.deepEqual([409, 429, 503, 500].map((status) => friendlyChatError(status, WORDS)),
    [WORDS.turnFailed, WORDS.capacityFailed, WORDS.runtimeFailed, WORDS.requestFailed]);
  assert.deepEqual(projectedChatError(409, 'assistant_limit_reached', WORDS), { message: WORDS.limit, detail: '' });
  assert.deepEqual(projectedChatError(403, 'authentication was not confirmed', WORDS),
    { message: WORDS.authenticationDenied, detail: '' });
  assert.deepEqual(projectedChatError(503, 'authentication is unavailable', WORDS),
    { message: WORDS.authenticationUnavailable, detail: '' });
  assert.deepEqual(projectedChatError(409, 'space-resetting: reset', WORDS),
    { message: WORDS.spaceResetting, detail: 'HTTP 409 · space-resetting: reset' });
  assert.deepEqual(projectedChatError(502, 'bad gateway', WORDS), { message: WORDS.requestFailed, detail: 'HTTP 502 · bad gateway' });
  const broken = { ...WORDS, credentialRecordInvalid: 'reset' };
  assert.deepEqual(projectedChatError(502, 'credential-record-invalid: broken', broken),
    { message: 'reset', detail: 'HTTP 502 · credential-record-invalid: broken' });
});

test('turns with nothing to expire stay the same array, so nothing derived from them is computed again', () => {
  const turns = [{ role: 'user', text: 'Oi' }, { role: 'assistant', text: 'Olá' }];
  assert.equal(expiredTurns(turns), turns);
});
