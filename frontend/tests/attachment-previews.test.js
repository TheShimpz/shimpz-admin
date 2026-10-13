import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';

import {
  acquirePreview,
  clearPreviews,
  drawThumbnail,
  MAX_LOADING,
  MAX_PREVIEWS,
  previewable,
  previewUrl,
  thumbnailSize,
} from '../src/lib/chat/attachments/previews.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const fileId = (index) => index.toString(16).padStart(32, '0');

afterEach(() => {
  clearPreviews();
  mock.restoreAll();
});

// A thumbnail drawer whose every draw the test holds until it answers or fails, recording what it was asked for.
function drawer() {
  const draws = [];
  const draw = (url, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    draws.push({
      url,
      signal,
      answer: (width = 480, height = 320) => resolve({ blob: new Blob(['thumbnail']), width, height }),
      fail: () => reject(new Error('unavailable')),
    });
  });
  return { draws, draw };
}

test('a stored image of a valid Team is previewable by its stored media type, live and reloaded alike', () => {
  const image = { id: 'a'.repeat(32), mediaType: 'image/png', size: 1024 };
  assert.equal(previewable('marketing', image), true);
  assert.equal(previewable('marketing', { ...image, mediaType: 'image/jpeg' }), true);
  assert.equal(previewable('marketing', { ...image, mediaType: 'image/webp' }), true);
  assert.equal(previewable('Marketing', image), false);
  assert.equal(previewable('marketing', { ...image, id: undefined }), false);
  assert.equal(previewable('marketing', { ...image, id: 'A'.repeat(32) }), false);
  assert.equal(previewable('marketing', { ...image, mediaType: 'image/gif' }), false);
  assert.equal(previewable('marketing', { ...image, mediaType: 'application/octet-stream' }), false);
  assert.equal(previewable('marketing', { ...image, mediaType: undefined }), false);
  assert.equal(previewable('marketing', { ...image, size: 8 * 1024 * 1024 + 1 }), false);
  assert.equal(previewable('marketing', { ...image, size: 0 }), false);
  assert.equal(previewUrl('marketing', image.id), `/api/teams/marketing/files/${image.id}/preview`);
});

test('a thumbnail keeps the rendition proportions within its long edge and is never upscaled', () => {
  assert.deepEqual(thumbnailSize(1568, 765), { width: 480, height: 234 });
  assert.deepEqual(thumbnailSize(765, 1568), { width: 234, height: 480 });
  assert.deepEqual(thumbnailSize(64, 48), { width: 64, height: 48 });
  assert.deepEqual(thumbnailSize(4000, 1), { width: 480, height: 1 });
});

test('a thumbnail is drawn once from its Team rendition and shown at once to every later message', async () => {
  const { draws, draw } = drawer();
  const first = acquirePreview('marketing', fileId(1), draw);
  assert.equal(first.cached, null);
  assert.equal(draws.length, 1);
  assert.equal(draws[0].url, `/api/teams/marketing/files/${fileId(1)}/preview`);
  draws[0].answer(480, 320);
  const shown = await first.ready;
  assert.match(shown.url, /^blob:/);
  assert.deepEqual([shown.width, shown.height], [480, 320]);
  const again = acquirePreview('marketing', fileId(1), draw);
  assert.equal(again.cached, shown);
  assert.equal(draws.length, 1);
  // The same file of another Team is another thumbnail.
  acquirePreview('sales', fileId(1), draw);
  assert.equal(draws.length, 2);
  first.release();
  first.release();
  again.release();
});

test('at most two renditions load at once, and one no message waits for any more is never loaded', async () => {
  const { draws, draw } = drawer();
  const pins = Array.from({ length: 4 }, (_, index) => acquirePreview('marketing', fileId(index), draw));
  assert.equal(draws.length, MAX_LOADING);
  pins[2].release();
  draws[0].answer();
  await pins[0].ready;
  await flush();
  // The released third never started; the fourth took the free slot.
  assert.deepEqual(draws.map((entry) => entry.url.split('/')[5]), [fileId(0), fileId(1), fileId(3)]);
  draws[1].fail();
  await assert.rejects(pins[1].ready, /unavailable/);
  // A failed thumbnail is remembered for the session: the message keeps its card without asking Team again.
  const failed = acquirePreview('marketing', fileId(1), draw);
  await assert.rejects(failed.ready, /unavailable/);
  assert.equal(draws.length, 3);
});

test('the session keeps at most 48 thumbnails, evicting the least recently used one no message shows', async () => {
  const revoked = [];
  const revoke = URL.revokeObjectURL;
  mock.method(URL, 'revokeObjectURL', (url) => {
    revoked.push(url);
    revoke(url);
  });
  const { draws, draw } = drawer();
  const shown = [];
  for (let index = 0; index < MAX_PREVIEWS; index += 1) {
    const pin = acquirePreview('marketing', fileId(index), draw);
    draws[index].answer();
    shown.push(await pin.ready);
    if (index > 0) pin.release();
  }
  // One more evicts the oldest released thumbnail, never the one a message still shows.
  acquirePreview('marketing', fileId(MAX_PREVIEWS), draw);
  assert.deepEqual(revoked, [shown[1].url]);
  assert.equal(acquirePreview('marketing', fileId(0), draw).cached, shown[0]);
  assert.equal(acquirePreview('marketing', fileId(1), draw).cached, null);
});

test('beyond 48 thumbnails that messages still show, a further message keeps its card', async () => {
  const { draws, draw } = drawer();
  for (let index = 0; index < MAX_PREVIEWS; index += 1) {
    const pin = acquirePreview('marketing', fileId(index), draw);
    draws.at(-1).answer();
    await pin.ready;
  }
  const refused = acquirePreview('marketing', fileId(MAX_PREVIEWS), draw);
  await assert.rejects(refused.ready, /Too many/);
  refused.release();
  assert.equal(draws.length, MAX_PREVIEWS);
});

test('a session check revokes every thumbnail and drops a load that settles after it', async () => {
  const revoked = [];
  const revoke = URL.revokeObjectURL;
  mock.method(URL, 'revokeObjectURL', (url) => {
    revoked.push(url);
    revoke(url);
  });
  const created = [];
  const create = URL.createObjectURL;
  mock.method(URL, 'createObjectURL', (blob) => {
    const url = create(blob);
    created.push(url);
    return url;
  });
  const { draws, draw } = drawer();
  const kept = acquirePreview('marketing', fileId(1), draw);
  draws[0].answer();
  const shown = await kept.ready;
  const late = acquirePreview('marketing', fileId(2), draw);
  const waiting = [acquirePreview('marketing', fileId(3), draw), acquirePreview('marketing', fileId(4), draw)];
  clearPreviews();
  assert.deepEqual(revoked, [shown.url]);
  assert.equal(draws[1].signal.aborted, true);
  // The load under way answers after the check: nothing it drew is kept, and no slot of the new session is taken.
  draws[1].answer();
  await assert.rejects(late.ready, { name: 'AbortError' });
  assert.equal(created.length, 1);
  await flush();
  assert.equal(draws.length, 3);
  for (const pin of waiting) pin.release();
  // The new session starts empty with both of its loading slots free.
  const fresh = [acquirePreview('marketing', fileId(1), draw), acquirePreview('marketing', fileId(2), draw)];
  assert.equal(fresh[0].cached, null);
  assert.equal(draws.length, 5);
});

// The browser's image, bitmap, and canvas as drawThumbnail uses them: an image loads at the size the test sets, or fails.
function browser({ width = 1341, height = 894, fails = false, empty = false } = {}) {
  const made = { images: [], bitmaps: [], canvases: [] };
  globalThis.Image = class {
    constructor() {
      made.images.push(this);
    }

    set src(value) {
      this.source = value;
      if (!value) return;
      queueMicrotask(() => {
        this.naturalWidth = width;
        this.naturalHeight = height;
        if (fails) this.onerror?.();
        else this.onload?.();
      });
    }

    get src() {
      return this.source;
    }
  };
  globalThis.createImageBitmap = async (image, options) => {
    const bitmap = { image, options, closed: false, close() { this.closed = true; } };
    made.bitmaps.push(bitmap);
    return bitmap;
  };
  globalThis.document = {
    createElement: () => {
      const canvas = {
        drawn: [],
        getContext: () => ({ drawImage: (...args) => canvas.drawn.push(args) }),
        toBlob: (done, type) => done(empty ? null : new Blob(['thumbnail'], { type })),
      };
      made.canvases.push(canvas);
      return canvas;
    },
  };
  return made;
}

test('a thumbnail is the rendition decoded once at its own reduced size, and nothing else is kept', async () => {
  const made = browser();
  const drawn = await drawThumbnail('/api/teams/marketing/files/a/preview', new AbortController().signal);
  assert.deepEqual([drawn.width, drawn.height], [480, 320]);
  assert.equal(drawn.blob.type, 'image/webp');
  const [bitmap] = made.bitmaps;
  assert.deepEqual(bitmap.options, { resizeWidth: 480, resizeHeight: 320, resizeQuality: 'high' });
  assert.equal(bitmap.closed, true);
  assert.deepEqual([made.canvases[0].width, made.canvases[0].height], [480, 320]);
  // The full rendition is let go once its thumbnail is drawn.
  assert.equal(made.images[0].src, '');
});

test('a rendition that fails, is larger than Team sends, or is aborted draws no thumbnail', async () => {
  const signal = () => new AbortController().signal;
  browser({ fails: true });
  await assert.rejects(drawThumbnail('/preview', signal()), /unavailable/);
  browser({ width: 1569, height: 10 });
  await assert.rejects(drawThumbnail('/preview', signal()), /invalid/);
  browser({ width: 1200, height: 1200 });
  await assert.rejects(drawThumbnail('/preview', signal()), /invalid/);
  browser({ width: 0, height: 10 });
  await assert.rejects(drawThumbnail('/preview', signal()), /invalid/);
  const before = new AbortController();
  before.abort();
  await assert.rejects(drawThumbnail('/preview', before.signal), { name: 'AbortError' });
  const made = browser();
  const during = new AbortController();
  const drawing = drawThumbnail('/preview', during.signal);
  during.abort();
  await assert.rejects(drawing, { name: 'AbortError' });
  assert.equal(made.bitmaps.length, 0);
  const late = browser();
  const after = new AbortController();
  const original = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (...args) => {
    after.abort();
    return original(...args);
  };
  await assert.rejects(drawThumbnail('/preview', after.signal), { name: 'AbortError' });
  assert.equal(late.bitmaps[0].closed, true);
  browser({ empty: true });
  await assert.rejects(drawThumbnail('/preview', signal()), /encoded/);
});
