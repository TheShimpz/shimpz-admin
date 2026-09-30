import assert from 'node:assert/strict';
import test from 'node:test';

import { listChatHistory } from '../src/lib/chatHistory.js';
import {
  composeClarifiedRequest,
  MAX_COMPOSED_CHARS,
  parseClarification,
  renderClarification,
} from '../src/lib/clarification.js';
import { parseChatEvent } from '../src/lib/localChat.js';

const ASKED = {
  question: 'Qual período você quer cobrir?',
  options: [
    { label: 'Hoje', description: 'Só lançamentos de hoje.' },
    { label: 'Esta semana', description: '' },
  ],
  default_index: 0,
};
const LABELS = { question: 'Pergunta', answer: 'Resposta' };

test('only the exact closed clarification shape parses', () => {
  assert.equal(parseClarification(null), null);
  assert.deepEqual(parseClarification(ASKED), ASKED);
  for (const value of [
    undefined,
    [],
    { ...ASKED, extra: 1 },
    { ...ASKED, question: 'Linha 1\nLinha 2' },
    { ...ASKED, question: 'Pergunta quebrada' },
    { ...ASKED, question: ' Hoje?' },
    { ...ASKED, question: 'x'.repeat(241) },
    { ...ASKED, question: 'é' },
    { ...ASKED, options: ASKED.options.slice(0, 1) },
    { ...ASKED, options: Array.from({ length: 6 }, (_, i) => ({ label: `O${i}`, description: '' })) },
    { ...ASKED, options: [{ label: 'Hoje', description: '' }, { label: 'hoje', description: '' }] },
    { ...ASKED, options: [{ label: 'Hoje', description: '' }, { label: 'B​', description: '' }] },
    { ...ASKED, options: [{ label: 'Hoje' }, { label: 'B', description: '' }] },
    { ...ASKED, options: 'Hoje' },
    { ...ASKED, default_index: 2 },
    { ...ASKED, default_index: 0.5 },
    { ...ASKED, default_index: '0' },
  ]) {
    assert.throws(() => parseClarification(value), /invalid clarification/, JSON.stringify(value));
  }
});

test('an answer is combined with the original request without truncation', () => {
  assert.equal(
    composeClarifiedRequest(' Quais modelos saíram? ', ASKED.question, ' Hoje ', LABELS),
    'Quais modelos saíram?\n\nPergunta: Qual período você quer cobrir?\nResposta: Hoje',
  );
  assert.equal(composeClarifiedRequest('Pedido', ASKED.question, '   ', LABELS), null);
  assert.equal(composeClarifiedRequest('x'.repeat(MAX_COMPOSED_CHARS), ASKED.question, 'Hoje', LABELS), null);
});

test('clarification text is bounded by Unicode code points, as Team counts it', () => {
  for (const character of ['界', '😀']) {
    const text = (length) => character.repeat(length);
    const longest = {
      question: text(240),
      options: [{ label: text(80), description: text(160) }, { label: 'B', description: '' }],
      default_index: 0,
    };
    assert.deepEqual(parseClarification(longest), longest);
    for (const value of [
      { ...longest, question: text(241) },
      { ...longest, options: [{ label: text(81), description: '' }, longest.options[1]] },
      { ...longest, options: [{ label: 'A', description: text(161) }, longest.options[1]] },
    ]) {
      assert.throws(() => parseClarification(value), /invalid clarification/);
    }

    // '\n\n' + 'Pergunta: ' + 'Q?' + '\n' + 'Resposta: ' + 'A' adds 26 code points after the request.
    const composed = composeClarifiedRequest(text(MAX_COMPOSED_CHARS - 26), 'Q?', 'A', LABELS);
    assert.equal([...composed].length, MAX_COMPOSED_CHARS);
    assert.equal(composeClarifiedRequest(text(MAX_COMPOSED_CHARS - 25), 'Q?', 'A', LABELS), null);
  }
});

test('done events and history replies carry the clarification only in its closed shape', async () => {
  const rendered = 'Qual período você quer cobrir?\n\n1. Hoje ✓ — Só lançamentos de hoje.\n2. Esta semana';
  assert.equal(renderClarification(ASKED), rendered);
  const done = { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: rendered, routine_proposal: null };
  assert.throws(() => parseChatEvent({ ...done, reply: 'I deleted everything.', clarification: ASKED }, 'team_1', 'Marketing'));
  assert.deepEqual(
    parseChatEvent({ ...done, clarification: ASKED }, 'team_1', 'Marketing').clarification,
    ASKED,
  );
  assert.throws(() => parseChatEvent({ ...done, clarification: { ...ASKED, default_index: 7 } }, 'team_1', 'Marketing'));
  assert.throws(() => parseChatEvent(done, 'team_1', 'Marketing'));

  const turn = 'a'.repeat(32);
  const reply = { id: `${turn}:reply`, kind: 'message', role: 'assistant', text: rendered, author: 'Marketing' };
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  const history = await listChatHistory(page([{ ...reply, clarification: ASKED }]), 'marketing');
  assert.deepEqual(history.entries[0].clarification, ASKED);
  assert.equal((await listChatHistory(page([reply]), 'marketing')).entries[0].clarification, undefined);
  for (const clarification of [null, { ...ASKED, options: [] }]) {
    await assert.rejects(listChatHistory(page([{ ...reply, clarification }]), 'marketing'));
  }
  await assert.rejects(listChatHistory(page([{ ...reply, text: 'Other text', clarification: ASKED }]), 'marketing'));
  await assert.rejects(
    listChatHistory(page([{ id: `${turn}:user`, kind: 'message', role: 'user', text: 'Oi', clarification: ASKED }]), 'marketing'),
  );
});
