import assert from 'node:assert/strict';
import test from 'node:test';

import { listChatHistory } from '../src/lib/chatHistory.js';
import {
  clarificationAnswer,
  clarifiedRequest,
  composeClarifiedRequest,
  MAX_COMPOSED_CHARS,
  matchClarificationAnswers,
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

test('every question recommends one of its options, and the retired unrecommended form is refused', () => {
  assert.equal(renderClarification(ASKED), 'Qual período você quer cobrir?\n\n1. Hoje ✓ — Só lançamentos de hoje.\n2. Esta semana');
  for (const value of [null, undefined, false, -1, 2]) {
    assert.throws(() => parseClarification({ ...ASKED, default_index: value }), /invalid clarification/, String(value));
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

test('a sent message answers a question only when it is exactly the composed request', () => {
  const ENGLISH = { question: 'Question', answer: 'Answer' };
  const SETS = [ENGLISH, LABELS];
  const composed = composeClarifiedRequest(' Quais modelos saíram? ', ASKED.question, ' Esta semana ', LABELS);
  assert.equal(clarificationAnswer(composed, 'Quais modelos saíram?', ASKED.question, SETS), 'Esta semana');
  assert.equal(clarificationAnswer(composed, ' Quais modelos saíram? ', ASKED.question, [LABELS]), 'Esta semana');
  for (const [message, original, question, labelSets] of [
    [composed, 'Outro pedido', ASKED.question, SETS],
    [composed, 'Quais modelos saíram?', 'Outra pergunta?', SETS],
    [composed, 'Quais modelos saíram?', ASKED.question, [ENGLISH]],
    [composed, 'Quais modelos saíram?', ASKED.question, [{ question: 'Pergunta', answer: 'Answer' }]],
    [`${composed}\nE também amanhã`, 'Quais modelos saíram?', ASKED.question, SETS],
    [`${composed} `, 'Quais modelos saíram?', ASKED.question, SETS],
    ['Quais modelos saíram?\n\nPergunta: Qual período você quer cobrir?\nResposta: ', 'Quais modelos saíram?', ASKED.question, SETS],
    ['Esta semana', 'Quais modelos saíram?', ASKED.question, SETS],
    [null, 'Quais modelos saíram?', ASKED.question, SETS],
    [composed, null, ASKED.question, SETS],
  ]) {
    assert.equal(clarificationAnswer(message, original, question, labelSets), null, JSON.stringify(message));
  }
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
  const done = { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: rendered };
  assert.throws(() => parseChatEvent({ ...done, reply: 'I deleted everything.', clarification: ASKED }, 'team_1', 'Marketing'));
  assert.deepEqual(
    parseChatEvent({ ...done, clarification: ASKED }, 'team_1', 'Marketing').clarification,
    ASKED,
  );
  assert.throws(() => parseChatEvent({ ...done, clarification: { ...ASKED, default_index: 7 } }, 'team_1', 'Marketing'));
  assert.throws(() => parseChatEvent(done, 'team_1', 'Marketing'));

  const turn = 'a'.repeat(32);
  const reply = {
    id: `${turn}:reply`,
    created_at: '2026-10-02T21:15:00Z',
    kind: 'message',
    role: 'assistant',
    text: rendered,
    author: 'Marketing',
  };
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  const history = await listChatHistory(page([{ ...reply, clarification: ASKED }]), 'marketing');
  assert.deepEqual(history.entries[0].clarification, ASKED);
  assert.equal((await listChatHistory(page([reply]), 'marketing')).entries[0].clarification, undefined);
  for (const clarification of [null, { ...ASKED, options: [] }]) {
    await assert.rejects(listChatHistory(page([{ ...reply, clarification }]), 'marketing'));
  }
  await assert.rejects(listChatHistory(page([{ ...reply, text: 'Other text', clarification: ASKED }]), 'marketing'));
  await assert.rejects(
    listChatHistory(page([{
      id: `${turn}:user`, created_at: reply.created_at, kind: 'message', role: 'user', text: 'Oi', clarification: ASKED,
    }]), 'marketing'),
  );
});

function exchange(key, text, clarification = null, historyIds = {}) {
  return {
    user: { renderKey: `u${key}`, text, ...(historyIds.user ? { historyId: historyIds.user } : {}) },
    assistant: {
      renderKey: `a${key}`,
      ...(clarification ? { clarification } : {}),
      ...(historyIds.assistant ? { historyId: historyIds.assistant } : {}),
    },
  };
}

const ASK = 'Gerar o relatório';
const answerTo = (answer) => composeClarifiedRequest(ASK, ASKED.question, answer, LABELS);
// An answering message shows the question it answers above the answer, so the person sees what they replied to.
const shown = (answer, question = ASKED.question) => ({ question, answer });

test('a question card needs its exact user request from the same history turn', () => {
  assert.equal(clarifiedRequest(exchange(0, ASK)), null);
  assert.equal(clarifiedRequest({ assistant: { clarification: ASKED } }), null);
  assert.equal(clarifiedRequest(exchange(0, ASK, ASKED)), ASK);
  assert.equal(clarifiedRequest(exchange(0, ASK, ASKED, { user: '7:u', assistant: '7:a' })), ASK);
  assert.equal(clarifiedRequest(exchange(0, ASK, ASKED, { user: '7:u', assistant: '8:a' })), null);
  assert.equal(clarifiedRequest(exchange(0, ASK, ASKED, { assistant: '7:a' })), null);
});

test('an answer closes the nearest earlier unanswered question it composes', () => {
  const history = [
    exchange(0, ASK, ASKED),
    exchange(1, ASK, ASKED),
    exchange(2, 'unrelated'),
    exchange(3, answerTo('Hoje')),
    exchange(4, answerTo('Esta semana')),
    exchange(5, answerTo('Hoje')),
  ];
  const { given, sent } = matchClarificationAnswers(history, new Map(), [LABELS]);
  assert.deepEqual([...given], [[1, 'Hoje'], [0, 'Esta semana']]);
  assert.deepEqual([...sent], [[3, shown('Hoje')], [4, shown('Esta semana')]]);
});

test('an answer skips questions it does not compose and never answers a later question', () => {
  const other = { ...ASKED, question: 'Qual formato?' };
  const history = [
    exchange(0, ASK, ASKED),
    exchange(1, ASK, other),
    exchange(2, answerTo('Hoje')),
    exchange(3, ASK, ASKED),
  ];
  const { given, sent } = matchClarificationAnswers(history, new Map(), [LABELS]);
  assert.deepEqual([...given], [[0, 'Hoje']]);
  assert.deepEqual([...sent], [[2, shown('Hoje')]]);
});

test('an explicit live answer link wins over the nearest open question', () => {
  const history = [
    exchange(0, ASK, ASKED),
    exchange(1, ASK, ASKED),
    exchange(2, answerTo('Hoje')),
    exchange(3, answerTo('Esta semana')),
  ];
  const { given, sent } = matchClarificationAnswers(history, new Map([['u2', 'a0']]), [LABELS]);
  assert.deepEqual([...given], [[0, 'Hoje'], [1, 'Esta semana']]);
  assert.deepEqual([...sent], [[2, shown('Hoje')], [3, shown('Esta semana')]]);

  const ignored = matchClarificationAnswers(
    history,
    new Map([['u0', 'a1'], ['u1', 'missing'], ['u2', 'a2']]),
    [LABELS],
  );
  assert.deepEqual([...ignored.given], [[1, 'Hoje'], [0, 'Esta semana']]);
});

test('each answer keeps the exact question it answers, also across chained Routine questions', () => {
  const first = { question: 'Que trabalho você quer que a rotina repita?', options: [{ label: 'Listar zonas', description: '' }], default_index: null };
  const second = { question: 'Com que frequência devo listar as zonas?', options: [{ label: 'a cada 30 segundos', description: '' }], default_index: null };
  const request = 'Cria uma nova rotina pra mim';
  const named = composeClarifiedRequest(request, first.question, 'Listar zonas', LABELS);
  const timed = composeClarifiedRequest(named, second.question, 'a cada 25 segundos', LABELS);
  const history = [exchange(0, request, first), exchange(1, named, second), exchange(2, timed)];
  const { sent } = matchClarificationAnswers(history, new Map(), [LABELS]);
  assert.deepEqual([...sent], [[1, shown('Listar zonas', first.question)], [2, shown('a cada 25 segundos', second.question)]]);
});

test('history without question cards matches nothing', () => {
  const history = [exchange(0, ASK), exchange(1, answerTo('Hoje')), { assistant: { renderKey: 'a2' } }];
  const { given, sent } = matchClarificationAnswers(history, new Map(), [LABELS]);
  assert.equal(given.size, 0);
  assert.equal(sent.size, 0);
  assert.equal(matchClarificationAnswers([], new Map(), [LABELS]).given.size, 0);
});

test('a question asked in several languages is answered by a message composed with any of them', () => {
  const routine = { question: 'Com que frequência?', questions: ['Com que frequência?', 'How often?'] };
  const english = composeClarifiedRequest(ASK, 'How often?', 'Every hour', LABELS);
  const history = [exchange(0, ASK, routine), exchange(1, english)];
  const { given, sent } = matchClarificationAnswers(history, new Map(), [LABELS]);
  assert.deepEqual([...given], [[0, 'Every hour']]);
  assert.deepEqual([...sent], [[1, { question: 'Com que frequência?', answer: 'Every hour' }]]);
  const unrelated = matchClarificationAnswers([exchange(0, ASK, routine), exchange(1, answerTo('Hoje'))], new Map(), [LABELS]);
  assert.equal(unrelated.given.size, 0);
});

test("every interface language composes answers with exactly the Team protocol's labels", async () => {
  const { readFileSync } = await import('node:fs');
  const { messages } = await import('../src/lib/messages.js');
  // The protocol mirror is the authority (ADR-0101): Team reads the person's own lines out of a composed answer.
  const source = readFileSync(new URL('../../backend/protocol/http/v1/payload.py', import.meta.url), 'utf8');
  const block = source.match(/CLARIFICATION_LABELS = \{\n([\s\S]*?)\n\}/u)[1];
  const protocol = Object.fromEntries(
    [...block.matchAll(/"([a-z]{2})": \{"question": "([^"]+)", "answer": "([^"]+)"\}/gu)]
      .map(([, locale, question, answer]) => [locale, { question, answer }]),
  );
  assert.deepEqual(Object.keys(protocol).sort(), Object.keys(messages).sort());
  for (const [locale, catalog] of Object.entries(messages)) {
    assert.deepEqual(
      { question: catalog.clarify.questionLabel, answer: catalog.clarify.answerLabel },
      protocol[locale],
      locale,
    );
  }
});
