import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTALL_ACK_TYPE,
  INSTALL_INTENT,
  STORE_CONTEXT_TYPE,
  STORE_FRAME_MAX_HEIGHT,
  STORE_FRAME_MIN_HEIGHT,
  STORE_FRAME_TYPE,
  STORE_LIFECYCLE_PROTOCOL_VERSION,
  STORE_ORIGIN,
  STORE_STATE_MAX_ASSISTANTS,
  STORE_STATE_TYPE,
  UNINSTALL_ACK_TYPE,
  UNINSTALL_INTENT,
  acknowledgeStoreFrame,
  acknowledgeStoreInstallIntent,
  acknowledgeStoreUninstallIntent,
  acceptsStoreInstallIntent,
  acceptsStoreUninstallIntent,
  assistantStoreHref,
  createStoreActionLatch,
  postStoreAssistantState,
  projectReleasedStoreAssistantIds,
  storeFrameHeight,
} from '../src/lib/assistantIntent.js';

test('pins the embedded Store lifecycle protocol cache key', () => {
  assert.equal(STORE_LIFECYCLE_PROTOCOL_VERSION, 1);
});

test('builds only canonical Assistant detail links on the Store origin', () => {
  assert.equal(
    assistantStoreHref('en', 'shimpz-cloudflare'),
    'https://shimpz.com/en/assistants/shimpz-cloudflare',
  );
  assert.equal(
    assistantStoreHref('pt', 'salesnator'),
    'https://shimpz.com/pt/assistants/salesnator',
  );
  for (const [locale, assistant] of [
    ['es', 'hello-pulse'], ['en', '../escape'], ['en', 'Hello-Pulse'], ['en', 'hello--pulse'],
  ]) {
    assert.equal(assistantStoreHref(locale, assistant), null);
  }
});

test('accepts only exact released Assistant intents from the embedded Store window', () => {
  const iframeWindow = {};
  const event = { origin: STORE_ORIGIN, source: iframeWindow, data: { ...INSTALL_INTENT } };

  assert.equal(acceptsStoreInstallIntent(event, iframeWindow), true);
  assert.equal(
    acceptsStoreInstallIntent(
      { ...event, data: { ...INSTALL_INTENT, assistant: 'shimpz-cloudflare' } },
      iframeWindow,
    ),
    true,
  );
});

test('rejects every untrusted origin, source, type, version, id, and extra field', () => {
  const iframeWindow = {};
  const exact = { origin: STORE_ORIGIN, source: iframeWindow, data: { ...INSTALL_INTENT } };
  const cases = [
    { ...exact, origin: 'https://www.shimpz.com' },
    { ...exact, origin: 'http://shimpz.com' },
    { ...exact, source: {} },
    { ...exact, data: { ...INSTALL_INTENT, type: 'shimpz:assistant-uninstall' } },
    { ...exact, data: { ...INSTALL_INTENT, version: '1' } },
    { ...exact, data: { ...INSTALL_INTENT, version: 2 } },
    { ...exact, data: { ...INSTALL_INTENT, assistant: 'salesnator' } },
    { ...exact, data: { ...INSTALL_INTENT, team: 'team_1' } },
    { ...exact, data: null },
    { ...exact, data: ['shimpz:assistant-install', 1, 'hello-pulse'] },
  ];

  for (const candidate of cases) assert.equal(acceptsStoreInstallIntent(candidate, iframeWindow), false);
  assert.equal(acceptsStoreInstallIntent(exact, null), false);
});

test('acknowledges an accepted intent without exposing any local state', () => {
  const acknowledgements = [];
  const iframeWindow = {
    postMessage(message, targetOrigin) { acknowledgements.push({ message, targetOrigin }); },
  };
  const event = { origin: STORE_ORIGIN, source: iframeWindow, data: { ...INSTALL_INTENT } };

  assert.equal(acknowledgeStoreInstallIntent(event, iframeWindow), true);
  assert.deepEqual(acknowledgements, [{
    message: {
      type: INSTALL_ACK_TYPE,
      version: 1,
      assistant: 'shimpz-cloudflare',
      accepted: true,
    },
    targetOrigin: STORE_ORIGIN,
  }]);
  assert.deepEqual(Object.keys(acknowledgements[0].message).sort(), [
    'accepted',
    'assistant',
    'type',
    'version',
  ]);
});

test('never acknowledges a rejected Store message', () => {
  const acknowledgements = [];
  const iframeWindow = {
    postMessage(message, targetOrigin) { acknowledgements.push({ message, targetOrigin }); },
  };
  const event = {
    origin: 'https://lookalike.invalid',
    source: iframeWindow,
    data: { ...INSTALL_INTENT },
  };

  assert.equal(acknowledgeStoreInstallIntent(event, iframeWindow), false);
  assert.deepEqual(acknowledgements, []);
});

test('keeps exactly one Store action latched until its matching release', () => {
  const latch = createStoreActionLatch();

  assert.equal(latch.acquire('install'), true);
  assert.equal(latch.acquire('install'), false);
  assert.equal(latch.acquire('uninstall'), false);
  assert.equal(latch.release('uninstall'), false);
  assert.equal(latch.acquire('uninstall'), false);
  assert.equal(latch.release('install'), true);
  assert.equal(latch.acquire('uninstall'), true);
  assert.equal(latch.release('uninstall'), true);
  assert.equal(latch.acquire('unknown'), false);
});

test('accepts and acknowledges only exact released Assistant uninstall intents', () => {
  const acknowledgements = [];
  const iframeWindow = {
    postMessage(message, targetOrigin) { acknowledgements.push({ message, targetOrigin }); },
  };
  const exact = { origin: STORE_ORIGIN, source: iframeWindow, data: { ...UNINSTALL_INTENT } };

  assert.equal(acceptsStoreUninstallIntent(exact, iframeWindow), true);
  assert.equal(acknowledgeStoreUninstallIntent(exact, iframeWindow), true);
  assert.deepEqual(acknowledgements, [{
    message: {
      type: UNINSTALL_ACK_TYPE,
      version: 1,
      assistant: 'shimpz-cloudflare',
      accepted: true,
    },
    targetOrigin: STORE_ORIGIN,
  }]);

  const rejected = [
    { ...exact, origin: 'https://www.shimpz.com' },
    { ...exact, source: {} },
    { ...exact, data: { ...UNINSTALL_INTENT, type: INSTALL_INTENT.type } },
    { ...exact, data: { ...UNINSTALL_INTENT, version: 2 } },
    { ...exact, data: { ...UNINSTALL_INTENT, assistant: 'salesnator' } },
    { ...exact, data: { ...UNINSTALL_INTENT, team: 'team_1' } },
    { ...exact, data: null },
  ];
  for (const candidate of rejected) {
    assert.equal(acceptsStoreUninstallIntent(candidate, iframeWindow), false);
    assert.equal(acknowledgeStoreUninstallIntent(candidate, iframeWindow), false);
  }
  assert.equal(acknowledgements.length, 1);

  const cloudflare = {
    ...exact,
    data: { ...UNINSTALL_INTENT, assistant: 'shimpz-cloudflare' },
  };
  assert.equal(acknowledgeStoreUninstallIntent(cloudflare, iframeWindow), true);
  assert.equal(acknowledgements[1].message.assistant, 'shimpz-cloudflare');
});

test('accepts only exact bounded integer Store frame measurements', () => {
  const iframeWindow = {};
  const exact = {
    origin: STORE_ORIGIN,
    source: iframeWindow,
    data: { type: STORE_FRAME_TYPE, version: 1, height: 640 },
  };

  assert.equal(storeFrameHeight(exact, iframeWindow), 640);
  assert.equal(storeFrameHeight({ ...exact, data: { ...exact.data, height: STORE_FRAME_MIN_HEIGHT } }, iframeWindow), 320);
  assert.equal(storeFrameHeight({ ...exact, data: { ...exact.data, height: STORE_FRAME_MAX_HEIGHT } }, iframeWindow), 5000);

  const cases = [
    { ...exact, origin: 'https://www.shimpz.com' },
    { ...exact, source: {} },
    { ...exact, data: { ...exact.data, type: 'shimpz:assistant-store-ready' } },
    { ...exact, data: { ...exact.data, version: '1' } },
    { ...exact, data: { ...exact.data, height: STORE_FRAME_MIN_HEIGHT - 1 } },
    { ...exact, data: { ...exact.data, height: STORE_FRAME_MAX_HEIGHT + 1 } },
    { ...exact, data: { ...exact.data, height: 640.5 } },
    { ...exact, data: { ...exact.data, height: '640' } },
    { ...exact, data: { ...exact.data, team: 'private_team' } },
    { ...exact, data: null },
    { ...exact, data: [STORE_FRAME_TYPE, 1, 640] },
  ];

  for (const candidate of cases) assert.equal(storeFrameHeight(candidate, iframeWindow), null);
  assert.equal(storeFrameHeight(exact, null), null);
});

test('acknowledges each valid Store frame without exposing local context', () => {
  const acknowledgements = [];
  const iframeWindow = {
    postMessage(message, targetOrigin) { acknowledgements.push({ message, targetOrigin }); },
  };
  const event = {
    origin: STORE_ORIGIN,
    source: iframeWindow,
    data: { type: STORE_FRAME_TYPE, version: 1, height: 712 },
  };

  assert.equal(acknowledgeStoreFrame(event, iframeWindow), 712);
  assert.deepEqual(acknowledgements, [{
    message: { type: STORE_CONTEXT_TYPE, version: 1 },
    targetOrigin: STORE_ORIGIN,
  }]);
  assert.deepEqual(Object.keys(acknowledgements[0].message).sort(), ['type', 'version']);

  assert.equal(
    acknowledgeStoreFrame({ ...event, data: { ...event.data, token: 'secret' } }, iframeWindow),
    null,
  );
  assert.equal(acknowledgements.length, 1);
});

test('posts only exact bounded Assistant Store state to the canonical iframe origin', () => {
  const messages = [];
  const iframeWindow = {
    postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); },
  };

  assert.equal(postStoreAssistantState(iframeWindow, 'loading', []), true);
  assert.equal(postStoreAssistantState(iframeWindow, 'ready', ['shimpz-cloudflare']), true);
  assert.equal(postStoreAssistantState(iframeWindow, 'ready', ['shimpz-cloudflare']), true);
  assert.equal(postStoreAssistantState(iframeWindow, 'error', []), true);
  assert.deepEqual(messages, [
    {
      message: { type: STORE_STATE_TYPE, version: 1, status: 'loading', installed: [] },
      targetOrigin: STORE_ORIGIN,
    },
    {
      message: {
        type: STORE_STATE_TYPE,
        version: 1,
        status: 'ready',
        installed: ['shimpz-cloudflare'],
      },
      targetOrigin: STORE_ORIGIN,
    },
    {
      message: {
        type: STORE_STATE_TYPE,
        version: 1,
        status: 'ready',
        installed: ['shimpz-cloudflare'],
      },
      targetOrigin: STORE_ORIGIN,
    },
    {
      message: { type: STORE_STATE_TYPE, version: 1, status: 'error', installed: [] },
      targetOrigin: STORE_ORIGIN,
    },
  ]);
  for (const { message } of messages) {
    assert.deepEqual(Object.keys(message).sort(), ['installed', 'status', 'type', 'version']);
    assert.equal('team' in message, false);
    assert.equal('token' in message, false);
    assert.equal('credentials' in message, false);
  }
});

test('rejects malformed, ambiguous, and oversized Assistant Store state', () => {
  const messages = [];
  const iframeWindow = {
    postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); },
  };
  const tooMany = Array.from(
    { length: STORE_STATE_MAX_ASSISTANTS + 1 },
    (_value, index) => `assistant-${index}`,
  );

  const cases = [
    [null, 'ready', []],
    [{}, 'ready', []],
    [iframeWindow, 'unknown', []],
    [iframeWindow, 'loading', ['shimpz-cloudflare']],
    [iframeWindow, 'error', ['shimpz-cloudflare']],
    [iframeWindow, 'ready', null],
    [iframeWindow, 'ready', ['Hello-Pulse']],
    [iframeWindow, 'ready', ['shimpz-cloudflare', 'shimpz-cloudflare']],
    [iframeWindow, 'ready', tooMany],
  ];
  for (const [target, status, installed] of cases) {
    assert.equal(postStoreAssistantState(target, status, installed), false);
  }
  assert.deepEqual(messages, []);

  assert.equal(postStoreAssistantState(iframeWindow, 'ready', ['private-assistant']), false);
  assert.deepEqual(messages, []);
});

test('rejects consecutive and trailing hyphens in Assistant Store state ids', () => {
  const iframeWindow = { postMessage() { throw new Error('must not post'); } };

  assert.equal(postStoreAssistantState(iframeWindow, 'ready', ['hello--pulse']), false);
  assert.equal(postStoreAssistantState(iframeWindow, 'ready', ['hello-pulse-']), false);
});

test('projects only released Store Assistants from private local inventory', () => {
  const inventory = [
    { assistant: 'private-captain-tool', status: 'running' },
    { assistant: 'shimpz-cloudflare', status: 'running' },
    { assistant: 'retired-assistant', status: 'running' },
    { assistant: 'custom-customer-agent', status: 'created' },
  ];

  assert.deepEqual(projectReleasedStoreAssistantIds(inventory), ['shimpz-cloudflare']);
  assert.deepEqual(
    projectReleasedStoreAssistantIds(inventory.filter((entry) => entry.assistant !== 'shimpz-cloudflare')),
    [],
  );
  assert.deepEqual(projectReleasedStoreAssistantIds(null), []);
});
