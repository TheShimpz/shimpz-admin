import assert from 'node:assert/strict';
import test from 'node:test';

import { get } from 'svelte/store';

import {
  clearModelContext,
  configureModelContext,
  loadModelContext,
  modelContext,
  selectTeamBrain,
} from '../src/lib/modelContext.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

const providers = [
  {
    id: 'openai', title: 'OpenAI', default_model: 'gpt-5.6-terra', configured: true, masked: '••••test',
    models: [
      { id: 'gpt-5.6-sol', title: 'GPT-5.6 Sol', input_usd_per_million_cents: 500, output_usd_per_million_cents: 3000 },
      { id: 'gpt-5.6-terra', title: 'GPT-5.6 Terra', input_usd_per_million_cents: 250, output_usd_per_million_cents: 1500 },
      { id: 'gpt-5.6-luna', title: 'GPT-5.6 Luna', input_usd_per_million_cents: 100, output_usd_per_million_cents: 600 },
      { id: 'gpt-5.5', title: 'GPT-5.5', input_usd_per_million_cents: 500, output_usd_per_million_cents: 3000 },
    ],
  },
  {
    id: 'anthropic', title: 'Anthropic', default_model: 'claude-sonnet-5', configured: false, masked: null,
    models: [
      { id: 'claude-fable-5', title: 'Claude Fable 5', input_usd_per_million_cents: 1000, output_usd_per_million_cents: 5000 },
      { id: 'claude-opus-4-8', title: 'Claude Opus 4.8', input_usd_per_million_cents: 500, output_usd_per_million_cents: 2500 },
      { id: 'claude-sonnet-5', title: 'Claude Sonnet 5', input_usd_per_million_cents: 300, output_usd_per_million_cents: 1500 },
      { id: 'claude-haiku-4-5-20251001', title: 'Claude Haiku 4.5', input_usd_per_million_cents: 100, output_usd_per_million_cents: 500 },
    ],
  },
];

function fixtureFetcher(
  teamId = 'marketing',
  inference = { provider: 'openai', model: 'gpt-5.6-terra' },
  providerCatalog = providers,
) {
  return async (url, options = {}) => {
    if (url === '/api/model-providers') return response(200, { providers: providerCatalog });
    if (url === `/api/teams/${teamId}/inference` && !options.method) {
      return inference
        ? response(200, { team_id: teamId, ...inference })
        : response(409, { detail: 'not configured' });
    }
    if (url === `/api/teams/${teamId}/inference` && options.method === 'PUT') {
      return response(200, { team_id: teamId, ...JSON.parse(options.body) });
    }
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
  };
}

test.beforeEach(clearModelContext);

test('loads one verified provider/model authority for the selected Team', async () => {
  await loadModelContext(fixtureFetcher(), 'marketing');
  assert.deepEqual(get(modelContext), {
    phase: 'ready', teamId: 'marketing', providers,
    provider: 'openai', model: 'gpt-5.6-terra', ready: true, error: '',
  });
});

test('keeps Chat locked when the Team has no inference selection', async () => {
  await loadModelContext(fixtureFetcher('marketing', null), 'marketing');
  assert.equal(get(modelContext).provider, 'openai');
  assert.equal(get(modelContext).model, 'gpt-5.6-terra');
  assert.equal(get(modelContext).ready, false);
});

test('persists one atomic Brain change when its provider key is verified', async () => {
  const calls = [];
  const base = fixtureFetcher();
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    return base(url, options);
  };
  await loadModelContext(fetcher, 'marketing');
  calls.length = 0;
  await selectTeamBrain(fetcher, 'marketing', 'openai', 'gpt-5.5');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/teams/marketing/inference');
  assert.deepEqual(JSON.parse(calls[0].options.body), { provider: 'openai', model: 'gpt-5.5' });
  assert.equal(get(modelContext).model, 'gpt-5.5');
  assert.equal(get(modelContext).ready, true);
});

test('selecting the current Brain is a true no-op that preserves ready authority', async () => {
  let calls = 0;
  const base = fixtureFetcher();
  const fetcher = async (...args) => { calls += 1; return base(...args); };
  await loadModelContext(fetcher, 'marketing');
  calls = 0;
  const before = get(modelContext);

  const result = await selectTeamBrain(fetcher, 'marketing', 'openai', 'gpt-5.6-terra');

  assert.equal(calls, 0);
  assert.strictEqual(result, before);
  assert.strictEqual(get(modelContext), before);
  assert.equal(get(modelContext).ready, true);
});

test('selecting an unverified Brain preserves its exact model without writing inference', async () => {
  let calls = 0;
  const base = fixtureFetcher();
  const fetcher = async (...args) => { calls += 1; return base(...args); };
  await loadModelContext(fetcher, 'marketing');
  calls = 0;
  await selectTeamBrain(fetcher, 'marketing', 'anthropic', 'claude-opus-4-8');

  assert.equal(calls, 0);
  assert.equal(get(modelContext).provider, 'anthropic');
  assert.equal(get(modelContext).model, 'claude-opus-4-8');
  assert.equal(get(modelContext).ready, false);
});

test('validated credential is saved before inference and unlocks the Team', async () => {
  const calls = [];
  const base = fixtureFetcher();
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/model-providers/anthropic') {
      return response(200, { ...providers[1], configured: true, masked: '••••test' });
    }
    return base(url, options);
  };
  await loadModelContext(fetcher, 'marketing');
  await selectTeamBrain(fetcher, 'marketing', 'anthropic', 'claude-opus-4-8');
  calls.length = 0;
  await configureModelContext(fetcher, 'marketing', 'sk-ant-test-0123456789');

  assert.deepEqual(calls.map((entry) => entry.url), [
    '/api/model-providers/anthropic',
    '/api/teams/marketing/inference',
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    provider: 'anthropic',
    model: 'claude-opus-4-8',
  });
  assert.equal(get(modelContext).ready, true);
  assert.equal(get(modelContext).providers[1].configured, true);
});

test('rejected credential never reaches the Team inference endpoint', async () => {
  let inferenceWrites = 0;
  const base = fixtureFetcher();
  const fetcher = async (url, options = {}) => {
    if (url === '/api/model-providers/anthropic') return response(400, { detail: 'API key was rejected by Anthropic' });
    if (url === '/api/teams/marketing/inference' && options.method === 'PUT') inferenceWrites += 1;
    return base(url, options);
  };
  await loadModelContext(fetcher, 'marketing');
  await selectTeamBrain(fetcher, 'marketing', 'anthropic', 'claude-haiku-4-5-20251001');
  await assert.rejects(configureModelContext(fetcher, 'marketing', 'sk-ant-invalid-0123456789'), /rejected/i);
  assert.equal(inferenceWrites, 0);
  assert.equal(get(modelContext).ready, false);
});

test('switching to another verified provider writes only the selected Brain once', async () => {
  const configuredProviders = [
    providers[0],
    { ...providers[1], configured: true, masked: '••••test' },
  ];
  const calls = [];
  const base = fixtureFetcher(
    'marketing',
    { provider: 'openai', model: 'gpt-5.6-terra' },
    configuredProviders,
  );
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    return base(url, options);
  };
  await loadModelContext(fetcher, 'marketing');
  calls.length = 0;

  await selectTeamBrain(fetcher, 'marketing', 'anthropic', 'claude-fable-5');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/teams/marketing/inference');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    provider: 'anthropic',
    model: 'claude-fable-5',
  });
  assert.equal(get(modelContext).ready, true);
});

test('rejects an invalid Brain pair before making a network request', async () => {
  let calls = 0;
  const base = fixtureFetcher();
  const fetcher = async (...args) => { calls += 1; return base(...args); };
  await loadModelContext(fetcher, 'marketing');
  calls = 0;

  await assert.rejects(
    selectTeamBrain(fetcher, 'marketing', 'openai', 'claude-sonnet-5'),
    /Invalid Team model request/,
  );
  assert.equal(calls, 0);
  assert.equal(get(modelContext).provider, 'openai');
  assert.equal(get(modelContext).model, 'gpt-5.6-terra');
});

test('late model responses from the previous Team cannot replace current authority', async () => {
  let releaseOld;
  const delayed = new Promise((resolve) => { releaseOld = resolve; });
  const oldFetcher = async (url) => {
    if (url === '/api/model-providers') return delayed;
    return response(200, { team_id: 'marketing', provider: 'openai', model: 'gpt-5.6-terra' });
  };
  const oldLoad = loadModelContext(oldFetcher, 'marketing');
  await loadModelContext(fixtureFetcher('support'), 'support');
  releaseOld(response(200, { providers }));
  await oldLoad;
  assert.equal(get(modelContext).teamId, 'support');
  assert.equal(get(modelContext).ready, true);
});
