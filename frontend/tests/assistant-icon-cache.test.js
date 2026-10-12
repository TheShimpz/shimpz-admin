import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { afterEach, mock } from 'node:test';

import {
  acquireIcon,
  clearIconCache,
  localIcon,
  MAX_CACHED_ICONS,
  preloadIcons,
  publicIcon,
} from '../src/lib/assistantIconCache.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const PNG = new Uint8Array([137, 80, 78, 71]);
const DIGEST = `sha256:${createHash('sha256').update(PNG).digest('hex')}`;

// The browser's decoder as the cache uses it: an image decodes at the size the test sets, or fails when asked to.
let decodedSide = 1;
let decodeFails = false;
globalThis.Image = class {
  decode() {
    this.naturalWidth = decodedSide;
    this.naturalHeight = decodedSide;
    return decodeFails ? Promise.reject(new Error('undecodable')) : Promise.resolve();
  }
};

afterEach(() => {
  clearIconCache();
  decodedSide = 1;
  decodeFails = false;
  mock.restoreAll();
});

// One icon whose fetch the test counts, and holds until it answers when `held` is set.
function counted(key, { held = false } = {}) {
  const icon = { key, fetches: 0, signals: [], release: null };
  icon.fetch = (signal) => {
    icon.fetches += 1;
    icon.signals.push(signal);
    const blob = new Blob([PNG], { type: 'image/png' });
    if (!held) return Promise.resolve(blob);
    return new Promise((resolve) => { icon.release = () => resolve(blob); });
  };
  return icon;
}

test('an icon is loaded once, then shown at once to every screen while the session lasts', async () => {
  const icon = counted('local:one');
  const first = acquireIcon(icon);
  assert.equal(first.cached, '');
  const url = await first.url;
  assert.match(url, /^blob:/);
  first.release();
  first.release();
  const again = acquireIcon(icon);
  assert.equal(again.cached, url);
  assert.equal(await again.url, url);
  assert.equal(icon.fetches, 1);
  again.release();
});

test('icons no screen shows are evicted least recently used first, and an evicted icon is revoked', async () => {
  const revoked = [];
  const revoke = URL.revokeObjectURL;
  mock.method(URL, 'revokeObjectURL', (url) => {
    revoked.push(url);
    revoke(url);
  });
  const pinned = acquireIcon(counted('local:pinned'));
  const pinnedUrl = await pinned.url;
  const icons = Array.from({ length: MAX_CACHED_ICONS }, (_, index) => counted(`local:${index}`));
  const urls = [];
  for (const icon of icons) {
    const pin = acquireIcon(icon);
    urls.push(await pin.url);
    pin.release();
  }
  // One over the bound: the oldest unpinned icon goes, never the one a screen shows.
  assert.deepEqual(revoked, [urls[0]]);
  assert.equal(acquireIcon(counted('local:pinned')).cached, pinnedUrl);
  assert.equal(acquireIcon(icons[0]).cached, '');
});

test('decoded size bounds the icons no screen shows', async () => {
  // A decoded 2048-pixel image counts 16 MiB: the 192 MiB bound holds 12 of them, so a 13th evicts the oldest.
  decodedSide = 2048;
  const icons = Array.from({ length: 13 }, (_, index) => counted(`local:big-${index}`));
  for (const icon of icons) {
    const pin = acquireIcon(icon);
    await pin.url;
    pin.release();
  }
  assert.equal(acquireIcon(icons[0]).cached, '');
  assert.notEqual(acquireIcon(icons[12]).cached, '');
});

test('a failed icon is not kept, so the next screen asks for it again', async () => {
  decodeFails = true;
  const icon = counted('local:broken');
  await assert.rejects(acquireIcon(icon).url, /undecodable/);
  decodeFails = false;
  await acquireIcon(icon).url;
  assert.equal(icon.fetches, 2);
});

test('the session ending revokes every icon and drops the loads under way, which then never show', async () => {
  const loaded = counted('local:loaded');
  const loadedPin = acquireIcon(loaded);
  await loadedPin.url;
  const waiting = counted('local:waiting', { held: true });
  const waitingPin = acquireIcon(waiting);
  await flush();
  clearIconCache();
  assert.equal(waiting.signals[0].aborted, true);
  waiting.release();
  await assert.rejects(waitingPin.url, /aborted/);
  // Nothing of the ended session is shown again: the next one loads anew.
  assert.equal(acquireIcon(loaded).cached, '');
  loadedPin.release();
});

test('a preload keeps the icon for a later screen without pinning it', async () => {
  const icon = counted('local:preloaded');
  preloadIcons([icon]);
  await flush();
  await flush();
  const pin = acquireIcon(icon);
  assert.match(pin.cached, /^blob:/);
  assert.equal(icon.fetches, 1);
  pin.release();
});

test('an icon is keyed by exactly what the server names, and a publication\'s bytes must have its digest', async () => {
  const snapshot = { image_id: `sha256:${'a'.repeat(64)}` };
  assert.equal(localIcon(snapshot).key, `local:${snapshot.image_id}`);
  const assistant = { assistant_id: 'hello-pulse', source_digest: `sha256:${'b'.repeat(64)}`, icon_digest: DIGEST };
  assert.equal(publicIcon(assistant).key, `public:hello-pulse:${assistant.source_digest}:${DIGEST}`);
  const requests = [];
  mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    return new Response(new Blob([PNG], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } });
  });
  assert.match(await acquireIcon(publicIcon(assistant)).url, /^blob:/);
  assert.match(await acquireIcon(localIcon(snapshot)).url, /^blob:/);
  await assert.rejects(acquireIcon(publicIcon({ ...assistant, icon_digest: `sha256:${'c'.repeat(64)}` })).url, /changed/);
  assert.deepEqual(requests, [
    '/api/assistants/hello-pulse/catalog-icon',
    `/api/local-assistants/${'a'.repeat(64)}/icon`,
    '/api/assistants/hello-pulse/catalog-icon',
  ]);
});
