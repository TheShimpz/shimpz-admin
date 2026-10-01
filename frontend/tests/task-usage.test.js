import assert from 'node:assert/strict';
import test from 'node:test';

import { parseChatEvent } from '../src/lib/localChat.js';
import { formatTaskUsage, formatTaskUsageDetail, parseTaskUsage, taskUsageSummary } from '../src/lib/taskUsage.js';

const COPY = { tokens: 'tokens', input: 'input', output: 'output' };
const USAGE = {
  duration_ms: 6240,
  models: [
    { provider: 'anthropic', model: 'claude-opus-5-5', input_tokens: 1_000, output_tokens: 200 },
    { provider: 'openai', model: 'gpt-6-luna', input_tokens: 11_900, output_tokens: 580 },
  ],
};
const DONE = { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: 'Hello!', clarification: null, routine_proposal: null };

function model(overrides = {}) {
  return { provider: 'openai', model: 'gpt-6-luna', input_tokens: 1, output_tokens: 1, ...overrides };
}

test('a done frame without usage carries none, and one with exact usage keeps it', () => {
  assert.equal(parseTaskUsage(undefined), null);
  assert.equal(Object.hasOwn(parseChatEvent(DONE, 'team_1', 'Marketing'), 'usage'), false);
  assert.deepEqual(parseChatEvent({ ...DONE, usage: USAGE }, 'team_1', 'Marketing').usage, USAGE);
});

test('any usage outside the closed Team shape refuses the whole done frame', () => {
  for (const usage of [
    null,
    [],
    'usage',
    { duration_ms: 1 },
    { ...USAGE, extra: true },
    { duration_ms: -1, models: USAGE.models },
    { duration_ms: 1.5, models: USAGE.models },
    { duration_ms: 86_400_001, models: USAGE.models },
    { duration_ms: '6240', models: USAGE.models },
    { duration_ms: 1, models: [] },
    { duration_ms: 1, models: {} },
    { duration_ms: 1, models: Array.from({ length: 17 }, (_, index) => model({ model: `m${String(index).padStart(2, '0')}` })) },
    { duration_ms: 1, models: [null] },
    { duration_ms: 1, models: [model({ extra: 1 })] },
    { duration_ms: 1, models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 1 }] },
    { duration_ms: 1, models: [model({ provider: ['openai'] })] },
    { duration_ms: 1, models: [model({ model: 'GPT' })] },
    { duration_ms: 1, models: [model({ model: '' })] },
    { duration_ms: 1, models: [model({ input_tokens: -1 })] },
    { duration_ms: 1, models: [model({ output_tokens: 1_000_000_001 })] },
    { duration_ms: 1, models: [model({ output_tokens: '1' })] },
    { duration_ms: 1, models: [model(), model()] },
    { duration_ms: 1, models: [USAGE.models[1], USAGE.models[0]] },
    { duration_ms: 1, models: [model({ model: 'gpt-6.1-sol' }), model({ model: 'gpt-6-luna' })] },
  ]) {
    assert.throws(() => parseTaskUsage(usage), /invalid task usage/, JSON.stringify(usage));
    assert.throws(() => parseChatEvent({ ...DONE, usage }, 'team_1', 'Marketing'), /response is invalid/);
  }
});

test('the summary prices catalog models, counts every token, and formats per locale', () => {
  const summary = taskUsageSummary(USAGE);
  assert.equal(summary.tokens, 13_680);
  // Opus 5.5: 1000 × 400 + 200 × 2000 cents per million; Luna: 11900 × 10 + 580 × 50.
  assert.ok(Math.abs(summary.usd - (400_000 + 400_000 + 119_000 + 29_000) / 1_000_000 / 100) < 1e-12);
  assert.equal(summary.seconds, 6.24);
  assert.equal(formatTaskUsage(summary, 'en', COPY), '≈ $0.0095 · 13,680 tokens · 6.2 s');
  assert.equal(formatTaskUsage(summary, 'pt', COPY), '≈ US$\u00a00,0095 · 13.680 tokens · 6,2 s');
  assert.equal(
    formatTaskUsageDetail(summary, 'en', COPY),
    'Claude Opus 5.5: 1,000 input · 200 output\nGPT-6 Luna: 11,900 input · 580 output',
  );

  const costly = taskUsageSummary({ duration_ms: 1000, models: [model({ model: 'gpt-6.1-sol', input_tokens: 1_000_000, output_tokens: 0 })] });
  assert.equal(formatTaskUsage(costly, 'en', COPY), '≈ $2.00 · 1,000,000 tokens · 1 s');
});

test('a model the catalog does not price shows tokens and time but no cost', () => {
  const summary = taskUsageSummary({ duration_ms: 500, models: [model({ provider: 'local', model: 'unknown' })] });
  assert.equal(summary.usd, null);
  assert.equal(formatTaskUsage(summary, 'en', COPY), '2 tokens · 0.5 s');
  assert.equal(formatTaskUsageDetail(summary, 'en', COPY), 'unknown: 1 input · 1 output');
});
