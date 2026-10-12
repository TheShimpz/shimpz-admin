import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listModelProviders,
  loadInference,
  saveModelSetup,
} from '../src/lib/modelProviders.js';
import { response, via } from './socketStub.js';

const providers = [
  {
    id: 'openai',
    title: 'OpenAI',
    default_model: 'gpt-6-luna',
    models: [
      { id: 'gpt-6.1-sol', title: 'GPT-6.1 Sol', input_usd_per_million_cents: 200, output_usd_per_million_cents: 1000 },
      { id: 'gpt-6-luna', title: 'GPT-6 Luna', input_usd_per_million_cents: 10, output_usd_per_million_cents: 50 },
    ],
    configured: false,
    masked: null,
  },
  {
    id: 'anthropic',
    title: 'Anthropic',
    default_model: 'claude-sonnet-5-5',
    models: [
      { id: 'claude-opus-5-5', title: 'Claude Opus 5.5', input_usd_per_million_cents: 400, output_usd_per_million_cents: 2000 },
      { id: 'claude-sonnet-5-5', title: 'Claude Sonnet 5.5', input_usd_per_million_cents: 200, output_usd_per_million_cents: 1000 },
    ],
    configured: true,
    masked: '••••test',
  },
];

test('loads masked provider state and rejects a secret-bearing response', async () => {
  const listed = [];
  const answer = (body) => async (method, params) => {
    listed.push({ method, params });
    return response(200, body);
  };
  assert.deepEqual(await via(answer({ providers }), listModelProviders), providers);
  assert.deepEqual(listed, [{ method: 'models.list', params: {} }]);

  await assert.rejects(
    via(answer({ providers: [{ ...providers[0], api_key: 'must-not-enter-ui' }, providers[1]] }), listModelProviders),
    /invalid/i,
  );

  await assert.rejects(
    via(answer({
      providers: [
        { ...providers[0], models: [{ ...providers[0].models[0], input_usd_per_million_cents: 1 }, ...providers[0].models.slice(1)] },
        providers[1],
      ],
    }), listModelProviders),
    /invalid/,
  );
});

test('saves the key only to Admin and provider/model only to inference', async () => {
  const calls = [];
  const fetcher = async (method, params) => {
    calls.push({ method, params });
    return calls.length === 1
      ? response(200, { ...providers[0], configured: true, masked: '••••test' })
      : response(200, { team_id: 'team_1', provider: 'openai', model: 'gpt-6-luna' });
  };

  await via(fetcher, () => saveModelSetup(
    'team_1',
    { provider: 'openai', model: 'gpt-6-luna', apiKey: 'test-api-key' },
    providers,
  ));

  assert.deepEqual(calls, [
    { method: 'models.save', params: { provider: 'openai', body: { api_key: 'test-api-key' } } },
    { method: 'inference.save', params: { team_id: 'team_1', body: { provider: 'openai', model: 'gpt-6-luna' } } },
  ]);
  assert.doesNotMatch(JSON.stringify(calls[1]), /api_key|test-api-key/);
});

test('reuses a configured key without a credential write', async () => {
  const calls = [];
  const fetcher = async (method, params) => {
    calls.push({ method, params });
    return response(200, { team_id: 'team_1', provider: 'anthropic', model: 'claude-sonnet-5-5' });
  };
  await via(fetcher, () => saveModelSetup(
    'team_1',
    { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: '' },
    providers,
  ));
  assert.deepEqual(calls.map((entry) => entry.method), ['inference.save']);
});

test('rejects inference models outside the provider catalog before saving', async () => {
  await assert.rejects(
    via(
      async () => response(200, { team_id: 'team_1', provider: 'openai', model: 'claude-sonnet-5-5' }),
      () => loadInference('team_1'),
    ),
    /invalid/,
  );

  let called = false;
  await assert.rejects(
    via(
      async () => { called = true; },
      () => saveModelSetup('team_1', { provider: 'openai', model: 'gpt-5.7', apiKey: 'test-api-key' }, providers),
    ),
    /invalid/i,
  );
  assert.equal(called, false);
});

test('treats unconfigured inference as empty', async () => {
  assert.equal(await via(async () => response(409, { detail: 'not configured' }), () => loadInference('team_1')), null);
});
