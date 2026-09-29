import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadInstructions,
  MAX_INSTRUCTIONS,
  parseInstructionLines,
  saveInstructions,
  validInstructions,
} from '../src/lib/teamInstructions.js';

const RULES = ['Responda sempre em português do Brasil.', 'Use listas curtas, sem tabelas.'];

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('parses one trimmed rule per non-empty line and reports the first problem with its line', () => {
  assert.deepEqual(parseInstructionLines(`  ${RULES[0]}  \n\n${RULES[1]}\n`), { rules: RULES });
  assert.deepEqual(parseInstructionLines(''), { rules: [] });
  const many = Array.from({ length: MAX_INSTRUCTIONS + 1 }, (_, index) => `Regra ${index}`).join('\n');
  assert.deepEqual(parseInstructionLines(many), { error: 'tooMany', line: 17 });
  assert.deepEqual(parseInstructionLines(`ok\n${'x'.repeat(281)}`), { error: 'tooLong', line: 2 });
  assert.deepEqual(parseInstructionLines('Invisível\u200b'), { error: 'invalid', line: 1 });
  assert.deepEqual(parseInstructionLines('Use listas.\nuse LISTAS.'), { error: 'duplicate', line: 2 });
  assert.deepEqual(parseInstructionLines('Cafe\u0301'), { rules: ['Café'] });
});

test('only the exact protocol list is valid', () => {
  assert.equal(validInstructions([]), true);
  assert.equal(validInstructions(RULES), true);
  for (const value of [null, 'one', [''], [' a'], ['a\nb'], ['a\u2028b'], [3], ['A', 'a'], ['x'.repeat(281)]]) {
    assert.equal(validInstructions(value), false, JSON.stringify(value));
  }
});

test('loads and saves the exact list and rejects foreign or drifted responses', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    return response(200, { team_id: 'marketing', instructions: RULES });
  };
  assert.deepEqual(await loadInstructions(fetcher, 'marketing'), RULES);
  assert.deepEqual(await saveInstructions(fetcher, 'marketing', RULES), RULES);
  assert.equal(calls[0].url, '/api/teams/marketing/instructions');
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), { instructions: RULES });

  for (const body of [
    { team_id: 'other', instructions: RULES },
    { team_id: 'marketing', instructions: ['a\nb'] },
    { team_id: 'marketing', instructions: RULES, extra: true },
  ]) {
    await assert.rejects(loadInstructions(async () => response(200, body), 'marketing'), /invalid/);
  }
  await assert.rejects(
    saveInstructions(async () => response(200, { team_id: 'marketing', instructions: RULES.slice(1) }), 'marketing', RULES),
    /invalid/,
  );
  await assert.rejects(
    saveInstructions(async () => response(200, { team_id: 'marketing', instructions: ['Outra.', RULES[1]] }), 'marketing', RULES),
    /invalid/,
  );
  await assert.rejects(loadInstructions(async () => response(503, { detail: 'down' }), 'marketing'), /down/);
  await assert.rejects(saveInstructions(async () => response(400, { detail: 'bad' }), 'marketing', RULES), /bad/);
});

test('invalid requests never reach the network', async () => {
  const fetcher = async () => { throw new Error('must not fetch'); };
  await assert.rejects(loadInstructions(fetcher, 'Bad Team'), /Invalid/);
  await assert.rejects(loadInstructions(null, 'marketing'), /Invalid/);
  await assert.rejects(saveInstructions(fetcher, 'marketing', ['a\nb']), /Invalid/);
});
