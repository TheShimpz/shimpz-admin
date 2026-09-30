import assert from 'node:assert/strict';
import test from 'node:test';

import { listChatHistory } from '../src/lib/chatHistory.js';
import { parseChatEvent } from '../src/lib/localChat.js';
import { isQuote, isSchedule, isTimezone, parseRoutineProposal } from '../src/lib/routine.js';

// The same closed proposal Team's protocol vectors admit (ADR-0086).
const PROPOSAL = {
  proposal_id: 'c'.repeat(32),
  op: 'propose',
  quote: 'Toda segunda às 9h, confira o DNS',
  schedule: { kind: 'weekly', weekday: 0, time: '09:00' },
  timezone: null,
  routine_id: null,
  assistant_ids: ['shimpz-cloudflare'],
  expires_in: 900,
};
const CANCEL = {
  proposal_id: 'd'.repeat(32),
  op: 'cancel',
  quote: 'pode parar o resumo diário',
  schedule: null,
  timezone: null,
  routine_id: 'a'.repeat(32),
  assistant_ids: [],
  expires_in: 0,
};

test('admits exactly the closed proposal and cancel forms', () => {
  assert.equal(parseRoutineProposal(null), null);
  assert.deepEqual(parseRoutineProposal(PROPOSAL), PROPOSAL);
  assert.deepEqual(parseRoutineProposal({ ...PROPOSAL, timezone: 'Europe/Lisbon' }).timezone, 'Europe/Lisbon');
  assert.deepEqual(parseRoutineProposal(CANCEL), CANCEL);
  const parsed = parseRoutineProposal(PROPOSAL);
  parsed.schedule.time = '10:00';
  assert.equal(PROPOSAL.schedule.time, '09:00');
  for (const invalid of [
    [],
    { ...PROPOSAL, extra: 1 },
    { ...PROPOSAL, proposal_id: 'x' },
    { ...PROPOSAL, expires_in: 901 },
    { ...PROPOSAL, expires_in: 1.5 },
    { ...PROPOSAL, quote: ' padded ' },
    { ...PROPOSAL, assistant_ids: [] },
    { ...PROPOSAL, assistant_ids: ['b-x', 'a-x'] },
    { ...PROPOSAL, assistant_ids: ['Bad'] },
    { ...PROPOSAL, routine_id: 'a'.repeat(32) },
    { ...PROPOSAL, timezone: '../etc' },
    { ...PROPOSAL, schedule: { kind: 'daily' } },
    { ...PROPOSAL, op: 'run' },
    { ...CANCEL, schedule: { kind: 'daily', time: '09:00' } },
    { ...CANCEL, routine_id: null },
  ]) {
    assert.throws(() => parseRoutineProposal(invalid), TypeError);
  }
});

test('mirrors the schedule, quote, and timezone grammar', () => {
  for (const schedule of [
    { kind: 'hourly', every: 1 },
    { kind: 'hourly', every: 24 },
    { kind: 'daily', time: '23:59' },
    { kind: 'weekly', weekday: 6, time: '00:00' },
    { kind: 'monthly', day: 28, time: '12:30' },
  ]) {
    assert.equal(isSchedule(schedule), true, JSON.stringify(schedule));
  }
  for (const schedule of [
    null,
    'daily',
    { kind: 'yearly', time: '09:00' },
    { kind: 'hourly', every: 25 },
    { kind: 'hourly', every: 0 },
    { kind: 'daily', time: '24:00' },
    { kind: 'daily', time: 900 },
    { kind: 'weekly', weekday: 7, time: '09:00' },
    { kind: 'monthly', day: 29, time: '09:00' },
    { kind: 'daily', time: '09:00', extra: 1 },
  ]) {
    assert.equal(isSchedule(schedule), false, JSON.stringify(schedule));
  }
  assert.equal(isQuote('a'.repeat(500)), true);
  assert.equal(isQuote('😀'.repeat(500)), true);
  for (const quote of ['', 'a'.repeat(501), 'line\nbreak', 'é', 'x y', 7]) {
    assert.equal(isQuote(quote), false, JSON.stringify(quote));
  }
  assert.equal(isTimezone('America/Argentina/Buenos_Aires'), true);
  assert.equal(isTimezone('UTC'), true);
  assert.equal(isTimezone('../etc'), false);
  assert.equal(isTimezone(null), false);
});

test('a chat reply and its stored history carry the proposal for the card', async () => {
  const done = {
    type: 'done',
    team_id: 'team_1',
    team_name: 'Marketing',
    reply: 'Posso agendar isso; confirme no cartão.',
    clarification: null,
    routine_proposal: PROPOSAL,
  };
  assert.deepEqual(parseChatEvent(done, 'team_1', 'Marketing').routine_proposal, PROPOSAL);
  assert.throws(() => parseChatEvent({ ...done, routine_proposal: { ...PROPOSAL, op: 'run' } }, 'team_1', 'Marketing'));
  const { routine_proposal: _omitted, ...withoutProposal } = done;
  assert.throws(() => parseChatEvent(withoutProposal, 'team_1', 'Marketing'));

  const turn = 'b'.repeat(32);
  const reply = {
    id: `${turn}:reply`,
    kind: 'message',
    role: 'assistant',
    text: done.reply,
    author: 'Marketing',
    routine_proposal: PROPOSAL,
  };
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  const history = await listChatHistory(page([reply]), 'marketing');
  assert.deepEqual(history.entries[0].routineProposal, PROPOSAL);
  await assert.rejects(listChatHistory(page([{ ...reply, routine_proposal: null }]), 'marketing'));
  await assert.rejects(listChatHistory(page([{ ...reply, routine_proposal: { ...PROPOSAL, expires_in: -1 } }]), 'marketing'));
  await assert.rejects(
    listChatHistory(page([{ id: `${turn}:user`, kind: 'message', role: 'user', text: 'Oi', routine_proposal: PROPOSAL }]), 'marketing'),
  );
});
