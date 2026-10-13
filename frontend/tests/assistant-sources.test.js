import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { get } from 'svelte/store';

import { socketReads } from '../src/lib/session/socket.js';
import {
  clearAssistantSources,
  installedDetails,
  installedSummary,
  publicCatalog,
  snapshotDetails,
  snapshotSummary,
  stagedSnapshots,
  syncedFamily,
  warmAssistantSources,
} from '../src/lib/assistantSources.js';
import { response } from './socketStub.js';

const EPOCH = 'a'.repeat(32);
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

const SNAPSHOT = {
  assistant_id: 'hello-pulse',
  assistant_version: '1.2.3',
  name: 'Hello Pulse',
  summary: 'Says hello from a Local snapshot.',
  actions: ['say-hello'],
  integrations: [],
  declared_creators: ['@shimpz'],
  created_at: '2026-08-28T17:00:00Z',
  image_id: IMAGE_ID,
  platform: 'linux/amd64',
  provenance: 'local',
  unpublished: true,
  admission: 'admissible',
  reason: null,
};

// The socket as the Assistants pages' synced values see it: each watched topic's listeners, and every call held until
// the test answers it with the revision of the topic its result reflects.
function harness() {
  const listeners = new Map();
  const calls = [];
  socketReads.watch = (topic, listener) => {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(listener);
    return () => listeners.get(topic).delete(listener);
  };
  socketReads.call = (method, params) => new Promise((resolve) => calls.push({ method, params, resolve }));
  return {
    calls,
    listeners,
    announce(topic, cause, revision) {
      for (const listener of [...(listeners.get(topic) ?? [])]) listener(topic, cause, { epoch: EPOCH, revision });
    },
    answer(method, body, topic, revision) {
      const index = calls.findIndex((item) => item.method === method && !item.answered);
      const answered = response(200, body);
      answered.revision = topic ? { topic, epoch: EPOCH, revision } : null;
      calls[index].answered = true;
      calls[index].resolve(answered);
    },
  };
}

function show(store) {
  return store.subscribe(() => {});
}

// Every test is a session of its own: nothing a previous one read is kept, and nothing it starts outlives it.
beforeEach(() => clearAssistantSources());
afterEach(() => clearAssistantSources());

test('a stale snapshot list is never taken as current because a newer summary of the same topic was read', async () => {
  const socket = harness();
  const list = stagedSnapshots();
  const summary = snapshotSummary(IMAGE_ID, 'pt');
  const stops = [show(list), show(summary)];
  socket.announce('local-assistants', 'open', 2);
  // A staged snapshot's reads share Team's two-slot preview queue, so they go out a moment later.
  await flush();
  assert.deepEqual(socket.calls.map((item) => item.method), ['snapshots.list', 'snapshots.summary']);
  assert.deepEqual(socket.calls[1].params, { image_id: IMAGE_ID, locale: 'pt' });
  socket.answer('snapshots.list', { assistants: [], trace_id: 'c'.repeat(32) }, 'local-assistants', 2);
  socket.answer('snapshots.summary', { locale: 'pt', summary: 'Diz olá.' }, 'local-assistants', 3);
  await flush();
  assert.deepEqual(get(list).value, []);
  assert.equal(get(summary).value, 'Diz olá.');
  // Admin is at revision 3: the list's own read reflected 2, so the list alone is read again.
  socket.announce('local-assistants', 'reopen', 3);
  await flush();
  assert.deepEqual(socket.calls.map((item) => item.method), ['snapshots.list', 'snapshots.summary', 'snapshots.list']);
  socket.answer('snapshots.list', { assistants: [SNAPSHOT], trace_id: 'c'.repeat(32) }, 'local-assistants', 3);
  await flush();
  assert.deepEqual(get(list).value, [SNAPSHOT]);
  for (const stop of stops) stop();
});

test('each read asks for exactly its own Assistant, Team, and language under its own topic', async () => {
  const socket = harness();
  const stops = [
    show(snapshotDetails(IMAGE_ID, 'hello-pulse', 'en')),
    show(installedSummary('marketing', 'shimpz-cloudflare', 'ja')),
    show(installedDetails('marketing', 'shimpz-cloudflare', 'ja')),
    show(publicCatalog('pt')),
  ];
  // The catalog no topic announces is read at once; the others once their topic's subscription is in place.
  assert.deepEqual(socket.calls.map((item) => [item.method, item.params]), [['store.catalog', { locale: 'pt' }]]);
  assert.deepEqual([...socket.listeners.keys()], ['local-assistants', 'team/marketing/inventory']);
  socket.announce('local-assistants', 'open', 0);
  socket.announce('team/marketing/inventory', 'open', 0);
  await flush();
  const asked = socket.calls.slice(1).map((item) => [item.method, item.params]);
  assert.deepEqual(asked.sort(([left], [right]) => left.localeCompare(right)), [
    ['assistants.details', { team_id: 'marketing', assistant_id: 'shimpz-cloudflare', locale: 'ja' }],
    ['assistants.summary', { team_id: 'marketing', assistant_id: 'shimpz-cloudflare', locale: 'ja' }],
    ['snapshots.details', { image_id: IMAGE_ID, locale: 'en' }],
  ]);
  for (const stop of stops) stop();
});

test('a family keeps the value of a key asked for again and forgets one no longer asked for', async () => {
  const made = [];
  const family = syncedFamily((key) => {
    made.push(key);
    return { subscribe: (run) => { run({ status: 'ready', value: key, error: null }); return () => {}; } };
  });
  assert.deepEqual(get(family.of([])), {});
  assert.deepEqual(get(family.of(['a', 'b'])), {
    a: { status: 'ready', value: 'a', error: null },
    b: { status: 'ready', value: 'b', error: null },
  });
  get(family.of(['b']));
  get(family.of(['a', 'b']));
  assert.deepEqual(made, ['a', 'b', 'a']);
});

const CATALOG_PAGE = (locale) => ({ version: 1, locale, assistants: [], next: null });

test('the Store\'s values belong to the session: every screen shares them and a later one shows them at once', async () => {
  const socket = harness();
  assert.equal(stagedSnapshots(), stagedSnapshots());
  assert.equal(publicCatalog('pt'), publicCatalog('pt'));
  assert.equal(snapshotSummary(IMAGE_ID, 'pt'), snapshotSummary(IMAGE_ID, 'pt'));
  let stop = show(publicCatalog('pt'));
  socket.answer('store.catalog', CATALOG_PAGE('pt'));
  await flush();
  stop();
  stop = show(publicCatalog('pt'));
  assert.deepEqual(get(publicCatalog('pt')), { status: 'ready', value: [], error: null, failing: null });
  assert.equal(socket.calls.length, 1);
  stop();
  // The session ends: nothing it read shows again, and the next screen reads anew.
  clearAssistantSources();
  stop = show(publicCatalog('pt'));
  assert.equal(get(publicCatalog('pt')).status, 'loading');
  assert.equal(socket.calls.length, 2);
  stop();
});

test('catalogs no screen shows are kept for two languages at most, the least recently shown going first', async () => {
  const socket = harness();
  for (const locale of ['pt', 'es', 'fr']) {
    const stop = show(publicCatalog(locale));
    socket.answer('store.catalog', CATALOG_PAGE(locale));
    await flush();
    stop();
  }
  // Portuguese was evicted; Spanish and French show at once.
  assert.equal(get(publicCatalog('es')).status, 'ready');
  assert.equal(get(publicCatalog('fr')).status, 'ready');
  const stop = show(publicCatalog('pt'));
  assert.equal(get(publicCatalog('pt')).status, 'loading');
  stop();
});

test('the warm-up reads what the Store shows, then lets go of it, and the session keeps it', async () => {
  const socket = harness();
  warmAssistantSources('pt');
  assert.deepEqual(socket.calls.map((item) => item.method), ['store.catalog']);
  socket.announce('local-assistants', 'open', 1);
  socket.answer('snapshots.list', { assistants: [SNAPSHOT], trace_id: 'c'.repeat(32) }, 'local-assistants', 1);
  socket.answer('store.catalog', CATALOG_PAGE('pt'));
  await flush();
  // The summary the Store shows in Portuguese is read too, once its subscription is in place, before the warm-up lets go.
  socket.announce('local-assistants', 'subscribed', 1);
  await flush();
  assert.deepEqual(socket.calls.at(-1).params, { image_id: IMAGE_ID, locale: 'pt' });
  assert.equal(socket.listeners.get('local-assistants').size, 2);
  socket.answer('snapshots.summary', { locale: 'pt', summary: 'Diz olá.' }, 'local-assistants', 1);
  await flush();
  await flush();
  assert.equal(socket.listeners.get('local-assistants').size, 0);
  assert.equal(get(snapshotSummary(IMAGE_ID, 'pt')).value, 'Diz olá.');
});

test('the session ending stops a warm-up under way', async () => {
  const socket = harness();
  warmAssistantSources('en');
  assert.equal(socket.listeners.get('local-assistants').size, 1);
  clearAssistantSources();
  assert.equal(socket.listeners.get('local-assistants').size, 0);
  // A second warm-up replaces the first.
  warmAssistantSources('en');
  warmAssistantSources('en');
  assert.equal(socket.listeners.get('local-assistants').size, 1);
});

test('a screen that swaps every summary it shows keeps each new one shared, and the session end clears them all', async () => {
  const socket = harness();
  const images = Array.from({ length: 50 }, (_, index) => `sha256:d${index.toString(16).padStart(63, '0')}`);
  const take = (locale) => {
    const values = images.map((imageId) => snapshotSummary(imageId, locale));
    return { values, stops: values.map(show) };
  };
  const portuguese = take('pt');
  // Switching the language lets go of the Portuguese summaries before it takes the Spanish ones, in one turn.
  for (const stop of portuguese.stops) stop();
  const spanish = take('es');
  await flush();
  // Every value the screen shows is still the session's own, so every later screen shares it.
  images.forEach((imageId, index) => assert.equal(snapshotSummary(imageId, 'es'), spanish.values[index]));
  // A value evicted while a screen still held it is the session's again once shown, and the session's end reaches it.
  const evicted = portuguese.values[0];
  assert.notEqual(snapshotSummary(images[0], 'pt'), evicted);
  for (const stop of spanish.stops) stop();
  const shownAgain = show(evicted);
  socket.announce('local-assistants', 'subscribed', 1);
  await flush();
  const read = socket.calls.findIndex((item) => item.params?.image_id === images[0] && item.params?.locale === 'pt');
  socket.calls[read].answered = true;
  const answered = response(200, { locale: 'pt', summary: 'Diz olá.' });
  answered.revision = { topic: 'local-assistants', epoch: EPOCH, revision: 1 };
  socket.calls[read].resolve(answered);
  await flush();
  assert.equal(get(evicted).value, 'Diz olá.');
  clearAssistantSources();
  assert.equal(get(evicted).status, 'loading');
  shownAgain();
});
