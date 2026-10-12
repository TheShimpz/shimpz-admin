import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { get } from 'svelte/store';

import { socketReads } from '../src/lib/adminSocket.js';
import {
  clearModelContext,
  configureModelContext,
  loadModelContext,
  modelContext,
  selectTeamBrain,
} from '../src/lib/modelContext.js';
import { RETRY_FIRST_MS } from '../src/lib/synced.js';
import { LocalApiError } from '../src/lib/validate.js';
import { response } from './socketStub.js';

const EPOCH = 'a'.repeat(32);
const flush = async () => {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

function catalog(configured = { openai: true, anthropic: false }) {
  return [
    {
      id: 'openai', title: 'OpenAI', default_model: 'gpt-6-luna',
      configured: configured.openai, masked: configured.openai ? '••••test' : null,
      models: [
        { id: 'gpt-6.1-sol', title: 'GPT-6.1 Sol', input_usd_per_million_cents: 200, output_usd_per_million_cents: 1000 },
        { id: 'gpt-6-luna', title: 'GPT-6 Luna', input_usd_per_million_cents: 10, output_usd_per_million_cents: 50 },
      ],
    },
    {
      id: 'anthropic', title: 'Anthropic', default_model: 'claude-sonnet-5-5',
      configured: configured.anthropic, masked: configured.anthropic ? '••••test' : null,
      models: [
        { id: 'claude-opus-5-5', title: 'Claude Opus 5.5', input_usd_per_million_cents: 400, output_usd_per_million_cents: 2000 },
        { id: 'claude-sonnet-5-5', title: 'Claude Sonnet 5.5', input_usd_per_million_cents: 200, output_usd_per_million_cents: 1000 },
      ],
    },
  ];
}

/**
 * Admin as the model context sees it over the session socket: the Space's keys and each Team's selection, which its
 * saves change and announce on their topics, as Admin does. `hold(method)` keeps the next such call's answer back until
 * the test releases it; `fail(method, error)` makes the next one fail.
 */
function admin({ configured = { openai: true, anthropic: false }, selections = { marketing: { provider: 'openai', model: 'gpt-6.1-sol' } } } = {}) {
  const state = { configured: { ...configured }, selections: { ...selections } };
  const listeners = new Map();
  const revisions = new Map();
  const calls = [];
  const held = new Map();
  const failures = new Map();
  function announce(topic) {
    revisions.set(topic, (revisions.get(topic) ?? 0) + 1);
    for (const listener of [...(listeners.get(topic) ?? [])]) {
      listener(topic, 'changed', { epoch: EPOCH, revision: revisions.get(topic) });
    }
  }
  function answer(method, params) {
    if (method === 'models.list') return response(200, { providers: catalog(state.configured) });
    if (method === 'inference.read') {
      const selection = state.selections[params.team_id];
      return selection
        ? response(200, { team_id: params.team_id, ...selection })
        : response(409, { detail: 'not configured' });
    }
    if (method === 'models.save') {
      state.configured[params.provider] = true;
      announce('space/models');
      return response(200, catalog(state.configured).find((entry) => entry.id === params.provider));
    }
    if (method === 'inference.save') {
      state.selections[params.team_id] = params.body;
      announce(`team/${params.team_id}/inference`);
      return response(200, { team_id: params.team_id, ...params.body });
    }
    throw new Error(`unexpected call ${method}`);
  }
  socketReads.watch = (topic, listener) => {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(listener);
    queueMicrotask(() => listener(topic, 'open', { epoch: EPOCH, revision: revisions.get(topic) ?? 0 }));
    return () => listeners.get(topic).delete(listener);
  };
  socketReads.call = async (method, params = {}) => {
    calls.push({ method, params });
    if (failures.has(method)) {
      const error = failures.get(method);
      failures.delete(method);
      throw error;
    }
    if (held.has(method)) {
      const gate = held.get(method);
      held.delete(method);
      await gate.promise;
    }
    const answered = answer(method, params);
    if (method === 'models.list') answered.revision = { topic: 'space/models', epoch: EPOCH, revision: revisions.get('space/models') ?? 0 };
    return answered;
  };
  return {
    state,
    calls,
    announce,
    methods: () => calls.map((entry) => entry.method),
    hold(method) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      held.set(method, { promise });
      return release;
    },
    fail(method, error) {
      failures.set(method, error);
    },
  };
}

// The context as a screen shows it: subscribed for the whole test, as the chat page is.
function shown() {
  const seen = [];
  const stop = modelContext.subscribe((value) => seen.push(value));
  return { seen, stop };
}

const lost = () => new LocalApiError('Admin disconnected before it answered.', 0, 'outcome-unknown');

test.beforeEach(() => clearModelContext());

test('a shown Team opens on the selection Admin holds once its provider has a key', async () => {
  const server = admin();
  const { stop } = shown();
  const context = await loadModelContext('marketing');
  assert.deepEqual(context, {
    phase: 'ready', teamId: 'marketing', providers: catalog(), provider: 'openai', model: 'gpt-6.1-sol', ready: true, error: '',
  });
  assert.deepEqual(server.methods().sort(), ['inference.read', 'models.list']);
  stop();
});

test('a Team with no selection stores the default model of a provider with a key, once, and then opens', async () => {
  const server = admin({ selections: {} });
  const { stop } = shown();
  await loadModelContext('marketing');
  await flush();
  assert.deepEqual(server.calls.filter((entry) => entry.method === 'inference.save'), [
    { method: 'inference.save', params: { team_id: 'marketing', body: { provider: 'openai', model: 'gpt-6-luna' } } },
  ]);
  assert.equal(get(modelContext).ready, true);
  stop();
});

test('a Team stays locked while no provider has a key, and stores nothing', async () => {
  const server = admin({ configured: { openai: false, anthropic: false }, selections: {} });
  const { stop } = shown();
  const context = await loadModelContext('marketing');
  assert.equal(context.ready, false);
  assert.equal(context.provider, 'openai');
  assert.ok(!server.methods().includes('inference.save'));
  stop();
});

test('a configured Brain is stored at once; a Brain without a key waits for it; the current one changes nothing', async () => {
  const server = admin({ configured: { openai: true, anthropic: false } });
  const { stop } = shown();
  await loadModelContext('marketing');
  assert.equal((await selectTeamBrain('marketing', 'openai', 'gpt-6.1-sol')).model, 'gpt-6.1-sol');
  assert.ok(!server.methods().includes('inference.save'));
  await selectTeamBrain('marketing', 'openai', 'gpt-6-luna');
  await flush();
  assert.deepEqual(server.state.selections.marketing, { provider: 'openai', model: 'gpt-6-luna' });
  assert.equal(get(modelContext).ready, true);
  const held = await selectTeamBrain('marketing', 'anthropic', 'claude-opus-5-5');
  assert.deepEqual([held.provider, held.model, held.ready], ['anthropic', 'claude-opus-5-5', false]);
  assert.equal(server.methods().filter((method) => method === 'inference.save').length, 1);
  await assert.rejects(selectTeamBrain('marketing', 'openai', 'claude-opus-5-5'), /Invalid Team model request/);
  await assert.rejects(selectTeamBrain('support', 'openai', 'gpt-6-luna'), /Invalid Team model request/);
  stop();
});

test('a saved key opens the Team on the selection it was saved for, shown from what Admin holds afterwards', async () => {
  const server = admin({ configured: { openai: false, anthropic: false } });
  const { seen, stop } = shown();
  await loadModelContext('marketing');
  const saving = configureModelContext('marketing', '  test-api-key-word  ');
  await flush();
  assert.ok(seen.some((value) => value.phase === 'saving'));
  const context = await saving;
  assert.deepEqual(server.calls.filter((entry) => entry.method.endsWith('.save')), [
    { method: 'models.save', params: { provider: 'openai', body: { api_key: 'test-api-key-word' } } },
    { method: 'inference.save', params: { team_id: 'marketing', body: { provider: 'openai', model: 'gpt-6.1-sol' } } },
  ]);
  assert.equal(context.ready, true);
  stop();
});

test('a refused key is shown and never reaches the selection', async () => {
  const server = admin({ configured: { openai: false, anthropic: false } });
  const { stop } = shown();
  await loadModelContext('marketing');
  server.fail('models.save', new LocalApiError('API key was rejected by OpenAI', 400));
  await assert.rejects(configureModelContext('marketing', 'test-api-key-word'), /rejected/);
  await flush();
  assert.ok(!server.methods().includes('inference.save'));
  assert.deepEqual([get(modelContext).phase, get(modelContext).error], ['error', 'API key was rejected by OpenAI']);
  stop();
});

test('an older save answer arriving last never shows a state Admin no longer holds', async () => {
  const server = admin({ configured: { openai: false, anthropic: false } });
  const { stop } = shown();
  await loadModelContext('marketing');
  const release = server.hold('models.save');
  const saving = configureModelContext('marketing', 'test-api-key-word');
  await flush();
  // Meanwhile the key is removed elsewhere; Admin's late answer to the save still says it is configured.
  server.state.configured.openai = false;
  release();
  await saving.catch(() => {});
  server.state.configured.openai = false;
  server.announce('space/models');
  await flush();
  const provider = get(modelContext).providers.find((entry) => entry.id === 'openai');
  assert.equal(provider.configured, false);
  assert.equal(get(modelContext).ready, false);
  stop();
});

test('a key Admin stored although the save answer was lost opens the Team once Admin announces it', async () => {
  const server = admin({ configured: { openai: false, anthropic: false } });
  const { stop } = shown();
  await loadModelContext('marketing');
  server.fail('models.save', lost());
  await assert.rejects(configureModelContext('marketing', 'test-api-key-word'), /disconnected/);
  await flush();
  assert.deepEqual([get(modelContext).phase, get(modelContext).errorCode], ['error', 'outcome-unknown']);
  // The save finished on Admin afterwards: the providers are read again and the errored context recovers by itself.
  server.state.configured.openai = true;
  server.announce('space/models');
  await flush();
  assert.deepEqual([get(modelContext).phase, get(modelContext).ready], ['ready', true]);
  assert.equal(server.methods().filter((method) => method === 'models.save').length, 1);
  stop();
});

test('a save that ends after the person opened another Team leaves that Team as Admin holds it', async () => {
  const server = admin({
    configured: { openai: false, anthropic: false },
    selections: { marketing: { provider: 'openai', model: 'gpt-6.1-sol' }, support: { provider: 'openai', model: 'gpt-6-luna' } },
  });
  const { stop } = shown();
  await loadModelContext('marketing');
  const release = server.hold('models.save');
  const saving = configureModelContext('marketing', 'test-api-key-word');
  await flush();
  const support = loadModelContext('support');
  await flush();
  assert.equal(get(modelContext).teamId, 'support');
  release();
  await saving;
  await support.catch(() => {});
  await flush();
  // The key the save stored is the Space's: support opens on its own selection, with nothing of Marketing's save.
  assert.deepEqual(
    [get(modelContext).teamId, get(modelContext).phase, get(modelContext).model, get(modelContext).ready],
    ['support', 'ready', 'gpt-6-luna', true],
  );
  stop();
});

test('a selection changed elsewhere is shown, and the newest read wins over an older one answered last', async () => {
  const server = admin();
  const { stop } = shown();
  await loadModelContext('marketing');
  const release = server.hold('inference.read');
  server.state.selections.marketing = { provider: 'openai', model: 'gpt-6-luna' };
  server.announce('team/marketing/inference');
  await flush();
  // A second change lands while the first read is held: it is read once that read ends, and its answer is shown.
  server.state.selections.marketing = { provider: 'openai', model: 'gpt-6.1-sol' };
  server.announce('team/marketing/inference');
  release();
  await flush();
  assert.equal(get(modelContext).model, 'gpt-6.1-sol');
  stop();
});

test('a failed selection read is shown; a transient one is read again on its own until the Team opens', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const server = admin();
    const { stop } = shown();
    server.fail('inference.read', new LocalApiError('Team is unavailable', 503));
    await assert.rejects(loadModelContext('marketing'), /Team is unavailable/);
    assert.deepEqual([get(modelContext).phase, get(modelContext).error], ['error', 'Team is unavailable']);
    mock.timers.tick(RETRY_FIRST_MS);
    await flush();
    assert.deepEqual([get(modelContext).phase, get(modelContext).ready], ['ready', true]);
    clearModelContext();
    server.fail('inference.read', new LocalApiError('Team not found', 404));
    await assert.rejects(loadModelContext('marketing'), /Team not found/);
    assert.equal(get(modelContext).phase, 'error');
    mock.timers.tick(60_000);
    await flush();
    assert.equal(get(modelContext).phase, 'error');
    stop();
  } finally {
    mock.timers.reset();
  }
});

test('a selection outside the catalog is refused, and an invalid Team is refused before any call', async () => {
  const server = admin({ selections: { marketing: { provider: 'anthropic', model: 'claude-sonnet-5-5' } } });
  const { stop } = shown();
  await loadModelContext('marketing');
  await assert.rejects(configureModelContext('Not A Team', 'test-api-key-word'), /Invalid Team model request/);
  assert.throws(() => loadModelContext('Not A Team'), /Invalid Team model request/);
  await assert.rejects(configureModelContext('support', ''), /Invalid Team model request/);
  assert.equal(server.methods().filter((method) => method.endsWith('.save')).length, 0);
  stop();
});

test('showing the same Team again reads it again, and clearing it forgets what was read', async () => {
  const server = admin();
  const { stop } = shown();
  await loadModelContext('marketing');
  const before = server.calls.length;
  await loadModelContext('marketing');
  await flush();
  assert.ok(server.calls.length > before);
  clearModelContext();
  assert.deepEqual(get(modelContext), {
    phase: 'idle', teamId: '', providers: [], provider: '', model: '', ready: false, error: '',
  });
  stop();
});

test('a refused selection read is shown even while an earlier selection is known', async () => {
  const server = admin();
  const { stop } = shown();
  await loadModelContext('marketing');
  assert.equal(get(modelContext).ready, true);
  server.fail('inference.read', new LocalApiError('Team not found', 404));
  server.announce('team/marketing/inference');
  await flush();
  assert.equal(get(modelContext).phase, 'error');
  assert.equal(get(modelContext).ready, false);
  assert.equal(get(modelContext).error, 'Team not found');
  stop();
});

test('after the context was cleared, the next Team view reads the providers again and opens', async () => {
  const server = admin({ selections: { marketing: { provider: 'openai', model: 'gpt-6.1-sol' }, support: { provider: 'openai', model: 'gpt-6-luna' } } });
  const { stop } = shown();
  await loadModelContext('marketing');
  const before = server.methods().filter((method) => method === 'models.list').length;
  // The last Team was deleted, and a new one is shown while the shell stays subscribed.
  clearModelContext();
  const context = await loadModelContext('support');
  assert.equal(context.ready, true);
  assert.equal(context.model, 'gpt-6-luna');
  assert.equal(server.methods().filter((method) => method === 'models.list').length, before + 1);
  stop();
});
