import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';

import {
  acquirePreview,
  clearPreviews,
  drawThumbnail,
  MAX_LOADING,
  MAX_PREVIEWS,
  pageUrl,
  paged,
  previewable,
  previewUrl,
  stored,
  thumbnailSize,
} from '../src/lib/chat/attachments/previews.js';
import { downloadUrl, fetchFileBytes, saveFile } from '../src/lib/chat/attachments/files.js';

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

test('only a stored file of a valid Team is served, and only a PDF within Team\'s PDF ceiling has pages', () => {
  const pdf = { id: 'c'.repeat(32), mediaType: 'application/pdf', size: 1024 };
  assert.equal(stored('marketing', pdf), true);
  assert.equal(stored('Marketing', pdf), false);
  assert.equal(stored('marketing', { ...pdf, id: undefined }), false);
  assert.equal(stored('marketing', null), false);
  assert.equal(paged('marketing', pdf), true);
  assert.equal(paged('marketing', { ...pdf, size: 8 * 1024 * 1024 + 1 }), false);
  assert.equal(paged('marketing', { ...pdf, size: 0 }), false);
  assert.equal(paged('marketing', { ...pdf, mediaType: 'image/png' }), false);
  assert.equal(paged('Marketing', pdf), false);
  assert.equal(pageUrl('marketing', pdf.id, 2), `/api/teams/marketing/files/${pdf.id}/pages/2/preview`);
  assert.equal(downloadUrl('marketing', pdf.id), `/api/teams/marketing/files/${pdf.id}/download`);
});

test('a file\'s bytes are read with the session, waiting out a busy Team a bounded number of times', async () => {
  const answers = [];
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return answers.shift();
  });
  mock.method(globalThis, 'setTimeout', (resolve) => {
    resolve();
    return 0;
  });
  const busy = () => new Response(JSON.stringify({ code: 'file-download-busy', retry_after_ms: 250 }), { status: 503 });
  answers.push(busy(), new Response('bytes'));
  assert.equal(await (await fetchFileBytes('/api/x')).text(), 'bytes');
  assert.deepEqual(calls[0].init, { signal: undefined, cache: 'no-store', credentials: 'same-origin' });
  assert.equal(calls.length, 2);
  // Beyond the retries, a refusal, or a busy answer without a bounded delay, the read fails.
  answers.push(busy(), busy(), busy(), busy());
  await assert.rejects(fetchFileBytes('/api/x'), /could not be read/);
  answers.push(new Response('{}', { status: 404 }));
  await assert.rejects(fetchFileBytes('/api/x'), /could not be read/);
  answers.push(new Response(JSON.stringify({ retry_after_ms: 60_000 }), { status: 503 }));
  await assert.rejects(fetchFileBytes('/api/x'), /could not be read/);
  answers.push(new Response('not json', { status: 503 }));
  await assert.rejects(fetchFileBytes('/api/x'), /could not be read/);
});

test('a wait for a busy Team ends with its read\'s abort', async () => {
  const controller = new AbortController();
  mock.method(globalThis, 'fetch', async () => {
    controller.abort(new Error('closed'));
    return new Response(JSON.stringify({ retry_after_ms: 250 }), { status: 503 });
  });
  await assert.rejects(fetchFileBytes('/api/x', controller.signal), /closed/);
});

test('a saved file is the original read through the download route, under its own name', async () => {
  const clicked = [];
  const revoked = [];
  const pending = [];
  mock.method(globalThis, 'fetch', async (url) => new Response(`bytes of ${url}`));
  mock.method(URL, 'createObjectURL', () => 'blob:saved');
  mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  mock.method(globalThis, 'setTimeout', (callback, ms) => {
    pending.push({ callback, ms });
    return 0;
  });
  globalThis.document = {
    createElement: () => ({
      click() {
        clicked.push({ href: this.href, download: this.download });
      },
    }),
  };
  try {
    await saveFile('marketing', { id: 'c'.repeat(32), name: 'Launch brief.pdf' });
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(clicked, [{ href: 'blob:saved', download: 'Launch brief.pdf' }]);
  // The object URL outlives the save, then is revoked.
  assert.deepEqual(revoked, []);
  pending[0].callback();
  assert.deepEqual(revoked, ['blob:saved']);
});

test('the page holds at most two saved originals at once, and a failed save lets its slot go', async () => {
  const pending = [];
  mock.method(globalThis, 'fetch', async () => new Response('bytes'));
  mock.method(URL, 'createObjectURL', () => 'blob:saved');
  mock.method(URL, 'revokeObjectURL', () => {});
  mock.method(globalThis, 'setTimeout', (callback) => {
    pending.push(callback);
    return 0;
  });
  globalThis.document = { createElement: () => ({ click() {} }) };
  const file = { id: 'c'.repeat(32), name: 'brief.pdf' };
  try {
    await saveFile('marketing', file);
    await saveFile('marketing', file);
    await assert.rejects(saveFile('marketing', file), /Too many files/);
    pending.shift()();
    await saveFile('marketing', file);
    while (pending.length) pending.shift()();
    mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(saveFile('marketing', file), /could not be read/);
      pending.shift()();
    }
  } finally {
    delete globalThis.document;
  }
});

test('a thumbnail keeps the rendition\'s proportions within its edge and is never upscaled', () => {
  assert.deepEqual(thumbnailSize(1568, 765), { width: 640, height: 312 });
  assert.deepEqual(thumbnailSize(765, 1568), { width: 312, height: 640 });
  assert.deepEqual(thumbnailSize(64, 48), { width: 64, height: 48 });
  assert.deepEqual(thumbnailSize(1568, 1), { width: 640, height: 1 });
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
  globalThis.createImageBitmap = async (image, ...args) => {
    const options = args.at(-1);
    const bitmap = { image, crop: args.slice(0, 4), options, closed: false, close() { this.closed = true; } };
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

test('a thumbnail is the rendition decoded once at its reduced size, and nothing else is kept', async () => {
  const made = browser();
  const drawn = await drawThumbnail('/api/teams/marketing/files/a/preview', new AbortController().signal);
  // The rendition's own size stays for the viewer; the thumbnail keeps its proportions.
  assert.deepEqual([drawn.width, drawn.height], [1341, 894]);
  assert.equal(drawn.blob.type, 'image/webp');
  const [bitmap] = made.bitmaps;
  assert.deepEqual(bitmap.options, { resizeWidth: 640, resizeHeight: 427, resizeQuality: 'high' });
  assert.equal(bitmap.closed, true);
  assert.deepEqual([made.canvases[0].width, made.canvases[0].height], [640, 427]);
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
