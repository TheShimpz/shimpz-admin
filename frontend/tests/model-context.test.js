import assert from 'node:assert/strict';
import test from 'node:test';

import { get } from 'svelte/store';

import {
  clearModelContext,
  configureModelContext,
  loadModelContext,
  modelContext,
  preloadModelProviders,
  refreshInference,
  selectTeamBrain,
} from '../src/lib/modelContext.js';
import { LocalApiError } from '../src/lib/validate.js';
import { response, via } from './socketStub.js';

// Each operation the model context asks Admin for, named with its subject: `models.list`, `models.save anthropic`,
// `inference.read marketing`, `inference.save marketing`.
function operation(method, params = {}) {
  return [method, params.provider ?? params.team_id].filter(Boolean).join(' ');
}

const load = (stub, teamId) => via(stub, () => loadModelContext(teamId));
const preload = (stub) => via(stub, () => preloadModelProviders());
const select = (stub, ...args) => via(stub, () => selectTeamBrain(...args));
const configure = (stub, ...args) => via(stub, () => configureModelContext(...args));

const providers = [
  {
    id: 'openai', title: 'OpenAI', default_model: 'gpt-6-luna', configured: true, masked: '••••test',
    models: [
      { id: 'gpt-6.1-sol', title: 'GPT-6.1 Sol', input_usd_per_million_cents: 200, output_usd_per_million_cents: 1000 },
      { id: 'gpt-6-luna', title: 'GPT-6 Luna', input_usd_per_million_cents: 10, output_usd_per_million_cents: 50 },
    ],
  },
  {
    id: 'anthropic', title: 'Anthropic', default_model: 'claude-sonnet-5-5', configured: false, masked: null,
    models: [
      { id: 'claude-opus-5-5', title: 'Claude Opus 5.5', input_usd_per_million_cents: 400, output_usd_per_million_cents: 2000 },
      { id: 'claude-sonnet-5-5', title: 'Claude Sonnet 5.5', input_usd_per_million_cents: 200, output_usd_per_million_cents: 1000 },
    ],
  },
];

function fixtureFetcher(
  teamId = 'marketing',
  inference = { provider: 'openai', model: 'gpt-6.1-sol' },
  providerCatalog = providers,
) {
  return async (method, params = {}) => {
    if (method === 'models.list') return response(200, { providers: providerCatalog });
    if (method === 'inference.read' && params.team_id === teamId) {
      return inference
        ? response(200, { team_id: teamId, ...inference })
        : response(409, { detail: 'not configured' });
    }
    if (method === 'inference.save' && params.team_id === teamId) {
      return response(200, { team_id: teamId, ...params.body });
    }
    throw new Error(`Unexpected request: ${operation(method, params)}`);
  };
}

test.beforeEach(clearModelContext);

test('loads one verified provider/model authority for the selected Team', async () => {
  await load(fixtureFetcher(), 'marketing');
  assert.deepEqual(get(modelContext), {
    phase: 'ready', teamId: 'marketing', providers,
    provider: 'openai', model: 'gpt-6.1-sol', ready: true, error: '',
  });
});

test('provider preload is shared with model hydration and cached across Team switches', async () => {
  let releaseProviders;
  const pendingProviders = new Promise((resolve) => { releaseProviders = resolve; });
  let providerRequests = 0;
  let inferenceRequests = 0;
  const fetcher = async (method, params) => {
    if (method === 'models.list') {
      providerRequests += 1;
      return pendingProviders;
    }
    if (method === 'inference.read') {
      inferenceRequests += 1;
      return response(200, { team_id: params.team_id, provider: 'openai', model: 'gpt-6.1-sol' });
    }
    throw new Error(`Unexpected request: ${operation(method, params)}`);
  };

  const preloading = preload(fetcher);
  const marketing = load(fetcher, 'marketing');
  assert.equal(providerRequests, 1);
  assert.equal(inferenceRequests, 1);
  releaseProviders(response(200, { providers }));
  await Promise.all([preloading, marketing]);

  await load(fetcher, 'support');
  assert.equal(providerRequests, 1);
  assert.equal(inferenceRequests, 2);
  assert.equal(get(modelContext).teamId, 'support');
});

test('opens Chat by persisting the default Brain when its provider key already exists', async () => {
  const calls = [];
  const base = fixtureFetcher('marketing', null);
  const fetcher = async (method, params = {}) => {
    calls.push({ method, params });
    return base(method, params);
  };

  await load(fetcher, 'marketing');

  assert.deepEqual(calls.map((entry) => operation(entry.method, entry.params)), [
    'models.list',
    'inference.read marketing',
    'inference.save marketing',
  ]);
  assert.deepEqual(calls[2].params.body, {
    provider: 'openai',
    model: 'gpt-6-luna',
  });
  assert.equal(get(modelContext).provider, 'openai');
  assert.equal(get(modelContext).model, 'gpt-6-luna');
  assert.equal(get(modelContext).ready, true);
});

test('keeps Chat locked when no provider key exists', async () => {
  const unconfigured = providers.map((provider) => ({ ...provider, configured: false, masked: null }));
  await load(fixtureFetcher('marketing', null, unconfigured), 'marketing');
  assert.equal(get(modelContext).ready, false);
});

test('persists one atomic Brain change when its provider key is verified', async () => {
  const calls = [];
  const base = fixtureFetcher();
  const fetcher = async (method, params = {}) => {
    calls.push({ method, params });
    return base(method, params);
  };
  await load(fetcher, 'marketing');
  calls.length = 0;
  await select(fetcher, 'marketing', 'openai', 'gpt-6-luna');

  assert.equal(calls.length, 1);
  assert.equal(operation(calls[0].method, calls[0].params), 'inference.save marketing');
  assert.deepEqual(calls[0].params.body, { provider: 'openai', model: 'gpt-6-luna' });
  assert.equal(get(modelContext).model, 'gpt-6-luna');
  assert.equal(get(modelContext).ready, true);
});

test('selecting the current Brain is a true no-op that preserves ready authority', async () => {
  let calls = 0;
  const base = fixtureFetcher();
  const fetcher = async (...args) => { calls += 1; return base(...args); };
  await load(fetcher, 'marketing');
  calls = 0;
  const before = get(modelContext);

  const result = await select(fetcher, 'marketing', 'openai', 'gpt-6.1-sol');

  assert.equal(calls, 0);
  assert.strictEqual(result, before);
  assert.strictEqual(get(modelContext), before);
  assert.equal(get(modelContext).ready, true);
});

test('selecting an unverified Brain preserves its exact model without writing inference', async () => {
  let calls = 0;
  const base = fixtureFetcher();
  const fetcher = async (...args) => { calls += 1; return base(...args); };
  await load(fetcher, 'marketing');
  calls = 0;
  await select(fetcher, 'marketing', 'anthropic', 'claude-opus-5-5');

  assert.equal(calls, 0);
  assert.equal(get(modelContext).provider, 'anthropic');
  assert.equal(get(modelContext).model, 'claude-opus-5-5');
  assert.equal(get(modelContext).ready, false);
});

test('validated credential is saved before inference and unlocks the Team', async () => {
  const calls = [];
  const base = fixtureFetcher();
  const fetcher = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'models.save' && params.provider === 'anthropic') {
      return response(200, { ...providers[1], configured: true, masked: '••••test' });
    }
    return base(method, params);
  };
  await load(fetcher, 'marketing');
  await select(fetcher, 'marketing', 'anthropic', 'claude-opus-5-5');
  calls.length = 0;
  await configure(fetcher, 'marketing', 'sk-ant-test-0123456789');

  assert.deepEqual(calls.map((entry) => operation(entry.method, entry.params)), [
    'models.save anthropic',
    'inference.save marketing',
  ]);
  assert.deepEqual(calls[1].params.body, {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
  });
  assert.equal(get(modelContext).ready, true);
  assert.equal(get(modelContext).providers[1].configured, true);
});

test('rejected credential never reaches the Team inference endpoint', async () => {
  let inferenceWrites = 0;
  const base = fixtureFetcher();
  const fetcher = async (method, params = {}) => {
    if (method === 'models.save' && params.provider === 'anthropic') return response(400, { detail: 'API key was rejected by Anthropic' });
    if (method === 'inference.save' && params.team_id === 'marketing') inferenceWrites += 1;
    return base(method, params);
  };
  await load(fetcher, 'marketing');
  await select(fetcher, 'marketing', 'anthropic', 'claude-sonnet-5-5');
  await assert.rejects(configure(fetcher, 'marketing', 'sk-ant-invalid-0123456789'), /rejected/i);
  assert.equal(inferenceWrites, 0);
  assert.equal(get(modelContext).ready, false);
});

for (const [name, inferenceResponse] of [
  ['refused', () => response(502, { detail: 'The Team model selection could not be saved.' })],
  ['invalid', () => response(200, { team_id: 'marketing', provider: 'openai', model: 'gpt-6.1-sol' })],
  ['unreachable', () => { throw new TypeError('Failed to fetch'); }],
]) {
  test(`a saved credential survives a ${name} Team selection so only the selection is retried`, async () => {
    const base = fixtureFetcher();
    let failSelection = true;
    const fetcher = async (method, params = {}) => {
      if (method === 'models.save' && params.provider === 'anthropic') {
        return response(200, { ...providers[1], configured: true, masked: '••••test' });
      }
      if (method === 'inference.save' && params.team_id === 'marketing' && failSelection) {
        failSelection = false;
        return inferenceResponse();
      }
      return base(method, params);
    };
    await load(fetcher, 'marketing');
    await select(fetcher, 'marketing', 'anthropic', 'claude-opus-5-5');
    await assert.rejects(configure(fetcher, 'marketing', 'sk-ant-test-0123456789'));
    assert.equal(get(modelContext).phase, 'error');
    assert.equal(get(modelContext).ready, false);
    assert.equal(get(modelContext).providers[1].configured, true);

    await configure(fetcher, 'marketing', '');
    assert.equal(get(modelContext).ready, true);
    assert.equal(get(modelContext).provider, 'anthropic');
  });
}

test('switching to another verified provider writes only the selected Brain once', async () => {
  const configuredProviders = [
    providers[0],
    { ...providers[1], configured: true, masked: '••••test' },
  ];
  const calls = [];
  const base = fixtureFetcher(
    'marketing',
    { provider: 'openai', model: 'gpt-6.1-sol' },
    configuredProviders,
  );
  const fetcher = async (method, params = {}) => {
    calls.push({ method, params });
    return base(method, params);
  };
  await load(fetcher, 'marketing');
  calls.length = 0;

  await select(fetcher, 'marketing', 'anthropic', 'claude-opus-5-5');

  assert.equal(calls.length, 1);
  assert.equal(operation(calls[0].method, calls[0].params), 'inference.save marketing');
  assert.deepEqual(calls[0].params.body, {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
  });
  assert.equal(get(modelContext).ready, true);
});

test('rejects an invalid Brain pair before making a network request', async () => {
  let calls = 0;
  const base = fixtureFetcher();
  const fetcher = async (...args) => { calls += 1; return base(...args); };
  await load(fetcher, 'marketing');
  calls = 0;

  await assert.rejects(
    select(fetcher, 'marketing', 'openai', 'claude-sonnet-5-5'),
    /Invalid Team model request/,
  );
  assert.equal(calls, 0);
  assert.equal(get(modelContext).provider, 'openai');
  assert.equal(get(modelContext).model, 'gpt-6.1-sol');
});

test('late model responses from the previous Team cannot replace current authority', async () => {
  let releaseOld;
  const delayed = new Promise((resolve) => { releaseOld = resolve; });
  const oldFetcher = async (method) => {
    if (method === 'models.list') return response(200, { providers });
    return delayed;
  };
  const oldLoad = load(oldFetcher, 'marketing');
  await load(fixtureFetcher('support'), 'support');
  releaseOld(response(200, {
    team_id: 'marketing',
    provider: 'openai',
    model: 'gpt-6.1-sol',
  }));
  await oldLoad;
  assert.equal(get(modelContext).teamId, 'support');
  assert.equal(get(modelContext).ready, true);
});

test('a key save that finishes after the session cleared never repopulates the provider cache', async () => {
  let releasePut;
  const putHeld = new Promise((resolve) => { releasePut = resolve; });
  let providerRequests = 0;
  const base = fixtureFetcher('marketing', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const fetcher = async (method, params = {}) => {
    if (method === 'models.list') providerRequests += 1;
    if (method === 'models.save' && params.provider === 'anthropic') {
      await putHeld;
      return response(200, { ...providers[1], configured: true, masked: '••••late' });
    }
    return base(method, params);
  };
  await load(fetcher, 'marketing');
  assert.equal(providerRequests, 1);
  const saving = configure(fetcher, 'marketing', 'sk-ant-late-0123456789');
  clearModelContext();
  // The next session loads provider state afresh, then the previous session's save finishes late.
  await load(fetcher, 'marketing');
  assert.equal(providerRequests, 2);
  releasePut();
  await saving.catch(() => {});

  await load(fetcher, 'marketing');
  assert.equal(providerRequests, 2);
  assert.equal(get(modelContext).providers.find((entry) => entry.id === 'anthropic').masked, null);
});

test('a key saved while switching Teams stays in the provider cache for the next load', async () => {
  let releasePut;
  const putHeld = new Promise((resolve) => { releasePut = resolve; });
  let providerRequests = 0;
  const marketing = fixtureFetcher('marketing', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const support = fixtureFetcher('support', { provider: 'openai', model: 'gpt-6-luna' });
  const fetcher = async (method, params = {}) => {
    if (method === 'models.list') providerRequests += 1;
    if (method === 'models.save' && params.provider === 'anthropic') {
      await putHeld;
      return response(200, { ...providers[1], configured: true, masked: '••••kept' });
    }
    return params.team_id === 'support' ? support(method, params) : marketing(method, params);
  };
  await load(fetcher, 'marketing');
  const saving = configure(fetcher, 'marketing', 'sk-ant-kept-0123456789');
  // Switching Teams is a new Team view, not a new session: the saved key must still reach the shared cache.
  await load(fetcher, 'support');
  releasePut();
  await saving.catch(() => {});
  await load(fetcher, 'marketing');
  assert.equal(providerRequests, 1);
  assert.equal(get(modelContext).providers.find((entry) => entry.id === 'anthropic').masked, '••••kept');
});

// Team marketing saves an Anthropic key while Team support, whose persisted Brain is Anthropic, becomes active.
function teamSwitchFetcher({ releaseKey, failMarketingSelection = false, writes = [] }) {
  const marketing = fixtureFetcher('marketing', { provider: 'openai', model: 'gpt-6.1-sol' });
  const support = fixtureFetcher('support', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  return async (method, params = {}) => {
    if (method.endsWith('.save')) writes.push(operation(method, params));
    if (method === 'models.save' && params.provider === 'anthropic') {
      await releaseKey;
      return response(200, { ...providers[1], configured: true, masked: '••••late' });
    }
    if (method === 'inference.save' && params.team_id === 'marketing' && failMarketingSelection) {
      return response(502, { detail: 'The Team model selection could not be saved.' });
    }
    return params.team_id === 'support' ? support(method, params) : marketing(method, params);
  };
}

for (const [name, failMarketingSelection] of [['completed', false], ['partially failed', true]]) {
  test(`a ${name} key save from the previous Team opens the active Team that persisted its provider`, async () => {
    let releasePut;
    const releaseKey = new Promise((resolve) => { releasePut = resolve; });
    const writes = [];
    const fetcher = teamSwitchFetcher({ releaseKey, failMarketingSelection, writes });
    await load(fetcher, 'marketing');
    await select(fetcher, 'marketing', 'anthropic', 'claude-opus-5-5');
    const saving = configure(fetcher, 'marketing', 'sk-ant-late-0123456789');
    await load(fetcher, 'support');
    assert.equal(get(modelContext).ready, false);

    releasePut();
    await saving.catch(() => {});

    const current = get(modelContext);
    assert.equal(current.phase, 'ready');
    assert.equal(current.teamId, 'support');
    assert.equal(current.provider, 'anthropic');
    assert.equal(current.model, 'claude-sonnet-5-5');
    assert.equal(current.ready, true);
    assert.equal(current.providers.find((entry) => entry.id === 'anthropic').masked, '••••late');
    // Reconciling the active Team never writes its selection; only marketing's own save reached the network.
    assert.deepEqual(writes, ['models.save anthropic', 'inference.save marketing']);
  });
}

test('a late key save keeps an unpersisted active selection locked but shows the configured provider', async () => {
  let releasePut;
  const releaseKey = new Promise((resolve) => { releasePut = resolve; });
  const fetcher = teamSwitchFetcher({ releaseKey });
  await load(fetcher, 'marketing');
  await select(fetcher, 'marketing', 'anthropic', 'claude-opus-5-5');
  const saving = configure(fetcher, 'marketing', 'sk-ant-late-0123456789');
  await load(fetcher, 'support');
  await select(fetcher, 'support', 'anthropic', 'claude-opus-5-5');

  releasePut();
  await saving;

  const current = get(modelContext);
  assert.equal(current.model, 'claude-opus-5-5');
  assert.equal(current.ready, false);
  assert.equal(current.providers.find((entry) => entry.id === 'anthropic').configured, true);
  await configure(fetcher, 'support', '');
  assert.equal(get(modelContext).ready, true);
  assert.equal(get(modelContext).model, 'claude-opus-5-5');
});

test('a key save that lands while the next Team is loading opens it when that load settles', async () => {
  let releasePut;
  const releaseKey = new Promise((resolve) => { releasePut = resolve; });
  let releaseInference;
  const inferenceHeld = new Promise((resolve) => { releaseInference = resolve; });
  const base = teamSwitchFetcher({ releaseKey });
  const fetcher = async (method, params = {}) => {
    if (method === 'inference.read' && params.team_id === 'support') await inferenceHeld;
    return base(method, params);
  };
  await load(fetcher, 'marketing');
  await select(fetcher, 'marketing', 'anthropic', 'claude-opus-5-5');
  const saving = configure(fetcher, 'marketing', 'sk-ant-late-0123456789');
  const loading = load(fetcher, 'support');
  releasePut();
  await saving;
  assert.equal(get(modelContext).phase, 'loading');
  releaseInference();
  await loading;

  assert.equal(get(modelContext).teamId, 'support');
  assert.equal(get(modelContext).ready, true);
  assert.equal(get(modelContext).providers.find((entry) => entry.id === 'anthropic').masked, '••••late');
});

test('a selection changed elsewhere is shown, and an unchanged one leaves the context as it is', async () => {
  let inference = { provider: 'openai', model: 'gpt-6.1-sol' };
  const fetcher = async (method, params = {}) => fixtureFetcher('marketing', inference)(method, params);
  await load(fetcher, 'marketing');
  const before = get(modelContext);
  assert.strictEqual(await via(fetcher, () => refreshInference('marketing')), before);

  inference = { provider: 'openai', model: 'gpt-6-luna' };
  await via(fetcher, () => refreshInference('marketing'));
  assert.equal(get(modelContext).model, 'gpt-6-luna');
  assert.equal(get(modelContext).ready, true);

  // A selection outside the catalog fails closed, and one for a Team that is not shown changes nothing.
  inference = { provider: 'openai', model: 'claude-opus-5-5' };
  await assert.rejects(via(fetcher, () => refreshInference('marketing')), /invalid/);
  assert.equal(get(modelContext).model, 'gpt-6-luna');
  assert.equal((await via(fetcher, () => refreshInference('support'))).teamId, 'marketing');
});

test('a save whose answer was lost reads the whole context again once Admin is back', async () => {
  const base = fixtureFetcher();
  let reachable = false;
  const fetcher = async (method, params = {}) => {
    if (method === 'inference.save' && !reachable) {
      throw new LocalApiError('Admin disconnected before it answered.', 0, 'outcome-unknown');
    }
    return base(method, params);
  };
  await load(fetcher, 'marketing');
  await assert.rejects(select(fetcher, 'marketing', 'openai', 'gpt-6-luna'), (error) => error.code === 'outcome-unknown');
  assert.equal(get(modelContext).phase, 'error');
  assert.equal(get(modelContext).errorCode, 'outcome-unknown');

  reachable = true;
  await via(fetcher, () => refreshInference('marketing'));
  assert.equal(get(modelContext).phase, 'ready');
  assert.equal(get(modelContext).model, 'gpt-6.1-sol');
});

test('a key save whose answer was lost reads the providers again on recovery and never sends the key again', async () => {
  let keySaved = false;
  const saves = [];
  const base = fixtureFetcher();
  const fetcher = async (method, params = {}) => {
    if (method === 'models.list') {
      return response(200, { providers: providers.map((entry) => (
        entry.id === 'anthropic' && keySaved ? { ...entry, configured: true, masked: '••••test' } : entry
      )) });
    }
    if (method === 'models.save') {
      saves.push(params);
      // Admin stored the key, and the connection dropped before its answer arrived.
      keySaved = true;
      throw new LocalApiError('Admin disconnected before it answered.', 0, 'outcome-unknown');
    }
    return base(method, params);
  };
  await load(fetcher, 'marketing');
  await select(fetcher, 'marketing', 'anthropic', 'claude-opus-5-5');
  await assert.rejects(configure(fetcher, 'marketing', 'sk-ant-test-0123456789'), (error) => error.code === 'outcome-unknown');
  assert.equal(get(modelContext).errorCode, 'outcome-unknown');

  await via(fetcher, () => refreshInference('marketing'));
  assert.equal(get(modelContext).phase, 'ready');
  assert.equal(get(modelContext).providers.find((entry) => entry.id === 'anthropic').configured, true);
  assert.equal(saves.length, 1);
});

test('a key save whose answer was lost after a Team switch reads the providers again for the Team shown', async () => {
  let keySaved = false;
  let providerReads = 0;
  let lose;
  const marketing = fixtureFetcher('marketing', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const support = fixtureFetcher('support', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const fetcher = async (method, params = {}) => {
    if (method === 'models.list') {
      providerReads += 1;
      return response(200, { providers: providers.map((entry) => (
        entry.id === 'anthropic' && keySaved ? { ...entry, configured: true, masked: '••••test' } : entry
      )) });
    }
    if (method === 'models.save') {
      keySaved = true;
      return new Promise((_resolve, reject) => {
        lose = () => reject(new LocalApiError('Admin disconnected before it answered.', 0, 'outcome-unknown'));
      });
    }
    return params.team_id === 'support' ? support(method, params) : marketing(method, params);
  };
  await load(fetcher, 'marketing');
  const saving = configure(fetcher, 'marketing', 'sk-ant-test-0123456789');
  await load(fetcher, 'support');
  assert.equal(get(modelContext).ready, false);
  lose();
  await assert.rejects(saving, (error) => error.code === 'outcome-unknown');
  // The support view never saw the lost save, yet its providers are read again when Admin says what changed.
  assert.equal(get(modelContext).phase, 'ready');
  await via(fetcher, () => refreshInference('support'));
  assert.equal(providerReads, 2);
  assert.equal(get(modelContext).ready, true);
  // Once read again, the providers are trusted until another save's answer is lost.
  await via(fetcher, () => refreshInference('support'));
  assert.equal(providerReads, 2);
});

test('a key save whose answer is lost while the next Team still loads reads the providers again as that load ends', async () => {
  let keySaved = false;
  let providerReads = 0;
  let lose;
  let releaseSupport;
  const marketing = fixtureFetcher('marketing', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const support = fixtureFetcher('support', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const fetcher = async (method, params = {}) => {
    if (method === 'models.list') {
      providerReads += 1;
      return response(200, { providers: providers.map((entry) => (
        entry.id === 'anthropic' && keySaved ? { ...entry, configured: true, masked: '••••test' } : entry
      )) });
    }
    if (method === 'models.save') {
      keySaved = true;
      return new Promise((_resolve, reject) => {
        lose = () => reject(new LocalApiError('Admin disconnected before it answered.', 0, 'outcome-unknown'));
      });
    }
    if (params.team_id === 'support' && method === 'inference.read' && !releaseSupport) {
      // The support Team's first selection read answers only after the save's answer was lost.
      await new Promise((resolve) => { releaseSupport = resolve; });
    }
    return params.team_id === 'support' ? support(method, params) : marketing(method, params);
  };
  await load(fetcher, 'marketing');
  const saving = configure(fetcher, 'marketing', 'sk-ant-test-0123456789');
  const loading = load(fetcher, 'support');
  lose();
  await assert.rejects(saving, (error) => error.code === 'outcome-unknown');
  // Admin reopens while the support view still loads: nothing reads its selection yet.
  await via(fetcher, () => refreshInference('support'));
  releaseSupport();
  await loading;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(get(modelContext).phase, 'ready');
  assert.equal(get(modelContext).ready, true);
  assert.equal(providerReads, 2);
});
