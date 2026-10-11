import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchSpaceResources, resourceSegments } from '../src/lib/spaceResources.js';

const GIB = 2 ** 30;
const signal = {
  services_running: 7,
  services_total: 7,
  memory_used_bytes: 429_496_730,
  memory_total_bytes: 4 * GIB,
  storage_used_bytes: 1_395_864_371,
  storage_total_bytes: 64 * GIB,
};

function response(status, body) {
  return { ok: status >= 200 && status < 300, async json() { return body; } };
}

test('reads exactly the closed resource signal without caching', async () => {
  const read = await fetchSpaceResources(async (url, options) => {
    assert.equal(url, '/api/space/resources');
    assert.deepEqual(options, { cache: 'no-store' });
    return response(200, signal);
  });
  assert.deepEqual(read, signal);
  const unknown = { ...signal, memory_used_bytes: null, memory_total_bytes: null, storage_used_bytes: null, storage_total_bytes: null };
  assert.deepEqual(await fetchSpaceResources(async () => response(200, unknown)), unknown);
  const over = { ...signal, memory_used_bytes: 5 * GIB, storage_used_bytes: 64 * GIB, services_running: 0 };
  assert.deepEqual(await fetchSpaceResources(async () => response(200, over)), over);
});

test('refuses an unavailable or malformed signal', async () => {
  assert.equal(await fetchSpaceResources(async () => response(503, signal)), null);
  for (const body of [
    null,
    [],
    {},
    { ...signal, trace_id: 'a'.repeat(32) },
    { ...signal, services_running: 8 },
    { ...signal, services_total: 0, services_running: 0 },
    { ...signal, services_total: 33 },
    { ...signal, services_running: -1 },
    { ...signal, services_running: 6.5 },
    { ...signal, services_running: '7' },
    { ...signal, memory_used_bytes: null },
    { ...signal, memory_total_bytes: 0 },
    { ...signal, memory_used_bytes: 2 ** 53 },
    { ...signal, storage_used_bytes: 64 * GIB + 1 },
    { ...signal, storage_total_bytes: null },
  ]) {
    assert.equal(await fetchSpaceResources(async () => response(200, body)), null, JSON.stringify(body));
  }
});

test('formats each segment in the interface language and leaves an unknown pair without numbers', () => {
  const messages = {
    'shell.resourceServices': 'Serviços',
    'shell.resourceMemory': 'Memória',
    'shell.resourceStorage': 'Armazenamento',
    'shell.resourceUnit': 'GiB',
  };
  const t = (key) => messages[key];
  assert.deepEqual(resourceSegments(signal, 'pt', t), [
    { label: 'Serviços', value: '7/7' },
    { label: 'Memória', value: '0,4/4 GiB' },
    { label: 'Armazenamento', value: '1,3/64 GiB' },
  ]);
  assert.equal(resourceSegments(signal, 'en', t)[1].value, '0.4/4 GiB');
  const unknown = { ...signal, memory_used_bytes: null, memory_total_bytes: null };
  assert.equal(resourceSegments(unknown, 'pt', t)[1].value, null);
});
