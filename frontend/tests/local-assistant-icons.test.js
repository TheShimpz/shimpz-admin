import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLocalAssistantIcon } from '../src/lib/localAssistantIcons.js';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

function pngResponse() {
  return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

test('bounds Local icon requests to two concurrent fetches without caching', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return pngResponse();
  };

  await Promise.all(Array.from({ length: 5 }, () => loadLocalAssistantIcon(fetcher, IMAGE_ID)));

  assert.equal(maximum, 2);
  assert.equal(calls, 5);
});

test('honors one bounded busy retry response before accepting the PNG', async () => {
  let calls = 0;
  const delays = [];
  const fetcher = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        code: 'local-assistant-preview-busy',
        retry_after_ms: 25,
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    return pngResponse();
  };

  const icon = await loadLocalAssistantIcon(fetcher, IMAGE_ID, async (delay) => delays.push(delay));

  assert.equal(icon.type, 'image/png');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [25]);
});

test('rejects invalid identities and invalid successful assets', async () => {
  let calls = 0;
  await assert.rejects(loadLocalAssistantIcon(async () => {
    calls += 1;
    return pngResponse();
  }, 'latest'), /Invalid Local Assistant icon request/);
  assert.equal(calls, 0);

  await assert.rejects(
    loadLocalAssistantIcon(
      async () => new Response('not an icon', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      IMAGE_ID,
    ),
    /icon is invalid/,
  );
});
