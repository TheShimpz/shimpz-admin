import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTALL_ACK_TYPE,
  INSTALL_INTENT_TYPE,
  STORE_CONTEXT_TYPE,
  STORE_FRAME_MAX_HEIGHT,
  STORE_FRAME_MIN_HEIGHT,
  STORE_FRAME_TYPE,
  STORE_LIFECYCLE_PROTOCOL_VERSION,
  STORE_ORIGIN,
  STORE_STATE_MAX_ASSISTANTS,
  STORE_STATE_TYPE,
  UNINSTALL_ACK_TYPE,
  UNINSTALL_INTENT_TYPE,
  acknowledgeStoreFrame,
  acknowledgeStoreInstallIntent,
  acknowledgeStoreUninstallIntent,
  createStoreActionLatch,
  postStoreAssistantState,
  projectInstalledAssistantIds,
  storeFrameHeight,
} from '../src/lib/assistantIntent.js';

const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const INSTALL_INTENT = Object.freeze({
  type: INSTALL_INTENT_TYPE,
  version: STORE_LIFECYCLE_PROTOCOL_VERSION,
  assistant: 'example-assistant',
  source_digest: SOURCE_DIGEST,
});
const UNINSTALL_INTENT = Object.freeze({
  type: UNINSTALL_INTENT_TYPE,
  version: STORE_LIFECYCLE_PROTOCOL_VERSION,
  assistant: 'example-assistant',
});

test('pins the exact publication lifecycle protocol', () => {
  assert.equal(STORE_LIFECYCLE_PROTOCOL_VERSION, 2);
});

test('acknowledges any canonical exact publication intent from only the Store frame', () => {
  const iframeWindow = { postMessage() {} };
  const event = { origin: STORE_ORIGIN, source: iframeWindow, data: INSTALL_INTENT };
  assert.equal(acknowledgeStoreInstallIntent(event, iframeWindow), true);

  for (const data of [
    { ...INSTALL_INTENT, source_digest: 'sha256:bad' },
    { ...INSTALL_INTENT, assistant: '../escape' },
    { ...INSTALL_INTENT, version: 1 },
    { ...INSTALL_INTENT, type: UNINSTALL_INTENT_TYPE },
    { ...INSTALL_INTENT, team: 'private_team' },
    null,
  ]) {
    assert.equal(acknowledgeStoreInstallIntent({ ...event, data }, iframeWindow), false);
  }
  assert.equal(
    acknowledgeStoreInstallIntent({ ...event, origin: 'https://shimpz.com.evil' }, iframeWindow),
    false,
  );
  assert.equal(acknowledgeStoreInstallIntent({ ...event, source: {} }, iframeWindow), false);
});

test('acknowledges accepted install and uninstall intents without local state', () => {
  const messages = [];
  const iframeWindow = {
    postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); },
  };
  const install = { origin: STORE_ORIGIN, source: iframeWindow, data: INSTALL_INTENT };
  const uninstall = { origin: STORE_ORIGIN, source: iframeWindow, data: UNINSTALL_INTENT };

  assert.equal(acknowledgeStoreInstallIntent(install, iframeWindow), true);
  assert.equal(acknowledgeStoreUninstallIntent(uninstall, iframeWindow), true);
  assert.deepEqual(messages, [
    {
      message: {
        type: INSTALL_ACK_TYPE,
        version: 2,
        assistant: 'example-assistant',
        accepted: true,
      },
      targetOrigin: STORE_ORIGIN,
    },
    {
      message: {
        type: UNINSTALL_ACK_TYPE,
        version: 2,
        assistant: 'example-assistant',
        accepted: true,
      },
      targetOrigin: STORE_ORIGIN,
    },
  ]);
  assert.equal(
    acknowledgeStoreUninstallIntent(
      { ...uninstall, data: { ...UNINSTALL_INTENT, source_digest: SOURCE_DIGEST } },
      iframeWindow,
    ),
    false,
  );
});

test('keeps exactly one Store action latched until its matching release', () => {
  const latch = createStoreActionLatch();
  assert.equal(latch.acquire('install'), true);
  assert.equal(latch.acquire('uninstall'), false);
  assert.equal(latch.release('uninstall'), false);
  assert.equal(latch.release('install'), true);
  assert.equal(latch.acquire('uninstall'), true);
  assert.equal(latch.release('uninstall'), true);
  assert.equal(latch.acquire('unknown'), false);
});

test('accepts and acknowledges only exact bounded Store frame measurements', () => {
  const messages = [];
  const iframeWindow = {
    postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); },
  };
  const exact = {
    origin: STORE_ORIGIN,
    source: iframeWindow,
    data: { type: STORE_FRAME_TYPE, version: 2, height: 640 },
  };
  assert.equal(storeFrameHeight(exact, iframeWindow), 640);
  assert.equal(
    storeFrameHeight({ ...exact, data: { ...exact.data, height: STORE_FRAME_MIN_HEIGHT } }, iframeWindow),
    320,
  );
  assert.equal(
    storeFrameHeight({ ...exact, data: { ...exact.data, height: STORE_FRAME_MAX_HEIGHT } }, iframeWindow),
    5000,
  );
  assert.equal(acknowledgeStoreFrame(exact, iframeWindow), 640);
  assert.deepEqual(messages, [{
    message: { type: STORE_CONTEXT_TYPE, version: 2 },
    targetOrigin: STORE_ORIGIN,
  }]);
  for (const candidate of [
    { ...exact, origin: 'https://www.shimpz.com' },
    { ...exact, source: {} },
    { ...exact, data: { ...exact.data, version: 1 } },
    { ...exact, data: { ...exact.data, height: 640.5 } },
    { ...exact, data: { ...exact.data, token: 'secret' } },
  ]) {
    assert.equal(storeFrameHeight(candidate, iframeWindow), null);
  }
});

test('posts only bounded canonical installed IDs to the Store frame', () => {
  const messages = [];
  const iframeWindow = {
    postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); },
  };
  assert.equal(postStoreAssistantState(iframeWindow, 'loading', []), true);
  assert.equal(
    postStoreAssistantState(iframeWindow, 'ready', ['example-assistant', 'private-assistant']),
    true,
  );
  assert.equal(postStoreAssistantState(iframeWindow, 'error', []), true);
  assert.deepEqual(messages[1], {
    message: {
      type: STORE_STATE_TYPE,
      version: 2,
      status: 'ready',
      installed: ['example-assistant', 'private-assistant'],
    },
    targetOrigin: STORE_ORIGIN,
  });

  const tooMany = Array.from(
    { length: STORE_STATE_MAX_ASSISTANTS + 1 },
    (_value, index) => `assistant-${index}`,
  );
  for (const [status, installed] of [
    ['loading', ['example-assistant']],
    ['ready', ['example-assistant', 'example-assistant']],
    ['ready', ['Hello-Assistant']],
    ['ready', tooMany],
  ]) {
    assert.equal(postStoreAssistantState(iframeWindow, status, installed), false);
  }
});

test('projects every valid installed Assistant without a product allowlist', () => {
  const inventory = [
    { assistant: 'example-assistant', assistant_version: '1.2.3', status: 'running' },
    { assistant: 'private-assistant', assistant_version: '2.0.0', status: 'created' },
  ];
  assert.deepEqual(
    projectInstalledAssistantIds(inventory),
    ['example-assistant', 'private-assistant'],
  );
  assert.deepEqual(projectInstalledAssistantIds(null), []);
  assert.deepEqual(
    projectInstalledAssistantIds([...inventory, { assistant: 'example-assistant' }]),
    [],
  );
  assert.deepEqual(projectInstalledAssistantIds([{ assistant: '../escape' }]), []);
});
