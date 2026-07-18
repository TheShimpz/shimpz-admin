import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listModelProviders,
  loadInference,
  removeModelKey,
  saveModelSetup,
} from '../src/lib/modelProviders.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

const providers = [
  {
    id: 'openai',
    title: 'OpenAI',
    default_model: 'gpt-5.6-terra',
    models: [
      { id: 'gpt-5.6-sol', title: 'GPT-5.6 Sol', input_usd_per_million_cents: 500, output_usd_per_million_cents: 3000 },
      { id: 'gpt-5.6-terra', title: 'GPT-5.6 Terra', input_usd_per_million_cents: 250, output_usd_per_million_cents: 1500 },
      { id: 'gpt-5.6-luna', title: 'GPT-5.6 Luna', input_usd_per_million_cents: 100, output_usd_per_million_cents: 600 },
      { id: 'gpt-5.5', title: 'GPT-5.5', input_usd_per_million_cents: 500, output_usd_per_million_cents: 3000 },
    ],
    configured: false,
    masked: null,
  },
  {
    id: 'anthropic',
    title: 'Anthropic',
    default_model: 'claude-sonnet-5',
    models: [
      { id: 'claude-fable-5', title: 'Claude Fable 5', input_usd_per_million_cents: 1000, output_usd_per_million_cents: 5000 },
      { id: 'claude-opus-4-8', title: 'Claude Opus 4.8', input_usd_per_million_cents: 500, output_usd_per_million_cents: 2500 },
      { id: 'claude-sonnet-5', title: 'Claude Sonnet 5', input_usd_per_million_cents: 300, output_usd_per_million_cents: 1500 },
      { id: 'claude-haiku-4-5-20251001', title: 'Claude Haiku 4.5', input_usd_per_million_cents: 100, output_usd_per_million_cents: 500 },
    ],
    configured: true,
    masked: '••••test',
  },
];

test('loads masked provider state and rejects a secret-bearing response', async () => {
  assert.deepEqual(await listModelProviders(async () => response(200, { providers })), providers);

  await assert.rejects(
    listModelProviders(async () => response(200, {
      providers: [{ ...providers[0], api_key: 'must-not-enter-ui' }, providers[1]],
    })),
    /invalid/i,
  );

  await assert.rejects(
    listModelProviders(async () => response(200, {
      providers: [
        { ...providers[0], models: [{ ...providers[0].models[0], input_usd_per_million_cents: 1 }, ...providers[0].models.slice(1)] },
        providers[1],
      ],
    })),
    /invalid/,
  );
});

test('saves the key only to Admin and provider/model only to inference', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? response(200, { ...providers[0], configured: true, masked: '••••test' })
      : response(200, { team_id: 'team_1', provider: 'openai', model: 'gpt-5.5' });
  };

  await saveModelSetup(
    fetcher,
    'team_1',
    { provider: 'openai', model: 'gpt-5.5', apiKey: 'sk-test-0123456789' },
    providers,
  );

  assert.deepEqual(JSON.parse(calls[0].options.body), { api_key: 'sk-test-0123456789' });
  assert.deepEqual(JSON.parse(calls[1].options.body), { provider: 'openai', model: 'gpt-5.5' });
  assert.doesNotMatch(calls[1].options.body, /api_key|sk-test/);
});

test('reuses a configured key without a credential write', async () => {
  const calls = [];
  await saveModelSetup(
    async (url, options) => {
      calls.push({ url, options });
      return response(200, { team_id: 'team_1', provider: 'anthropic', model: 'claude-sonnet-5' });
    },
    'team_1',
    { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: '' },
    providers,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/teams/team_1/inference');
});

test('rejects inference models outside the provider catalog before saving', async () => {
  await assert.rejects(
    loadInference(
      async () => response(200, { team_id: 'team_1', provider: 'openai', model: 'claude-sonnet-5' }),
      'team_1',
    ),
    /invalid/,
  );

  let called = false;
  await assert.rejects(
    saveModelSetup(
      async () => { called = true; },
      'team_1',
      { provider: 'openai', model: 'gpt-5.7', apiKey: 'sk-test-0123456789' },
      providers,
    ),
    /invalid/i,
  );
  assert.equal(called, false);
});

test('treats unconfigured inference as empty and removes keys through the fixed route', async () => {
  assert.equal(await loadInference(async () => response(409, { detail: 'not configured' }), 'team_1'), null);
  const removed = await removeModelKey(
    async (url, options) => {
      assert.equal(url, '/api/model-providers/openai');
      assert.equal(options.method, 'DELETE');
      return response(200, providers[0]);
    },
    'openai',
  );
  assert.equal(removed.configured, false);
});
