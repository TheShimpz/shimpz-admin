// `vite dev --mode scenarios` only (ADR-0087): the owner's presentation preview. The browser answers the Admin API
// from a scenario (install.js); this server answers only the images a page loads (icons and sent images' renditions,
// from fixtures, and a stand-in for a downloaded file) and refuses every other `/api` request and socket, so an image or
// navigation never reaches a backend. Nothing here is part of `vite build`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PREVIEW_IMAGES } from '../e2e/attachmentScenarios.js';
import { png } from '../e2e/png.js';

export const PREVIEW_MODE = 'scenarios';

const INSTALL = fileURLToPath(new URL('./install.js', import.meta.url));
// Assistant icons load as images, which the browser-side scenario cannot answer; serve one neutral mark instead.
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#1c3b3f"/></svg>';
// The Cloudflare Assistant shows its own mark, so a scenario shows a step exactly as a real Team draws it.
const CLOUDFLARE_ICON = readFileSync(new URL('./cloudflare-icon.png', import.meta.url));

// A sent image's rendition loads as an image too: each preview file shows its own proportions, any other image file a
// landscape one, and the image Team already collected answers 404, so its message keeps the card.
const PREVIEW_RE = /^\/api\/teams\/[a-z0-9_]{1,40}\/files\/([0-9a-f]{32})\/preview$/u;
const RENDITIONS = new Map();

function rendition(fileId) {
  if (fileId === PREVIEW_IMAGES.collected) return null;
  if (!RENDITIONS.has(fileId)) {
    RENDITIONS.set(fileId, {
      [PREVIEW_IMAGES.landscape]: () => png(1568, 765, [24, 54, 88], [232, 140, 72]),
      [PREVIEW_IMAGES.portrait]: () => png(765, 1568, [40, 92, 70], [210, 214, 160]),
    }[fileId]?.() ?? png(1200, 900, [60, 60, 96], [180, 200, 220]));
  }
  return RENDITIONS.get(fileId);
}

// A PDF's page renditions: three pages, each a sheet in its own shade, the page count on every answer.
const PAGE_RE = /^\/api\/teams\/[a-z0-9_]{1,40}\/files\/[0-9a-f]{32}\/pages\/([1-9][0-9]?)\/preview$/u;
const PAGE_COUNT = 3;
const PAGES = new Map();

function pageRendition(page) {
  if (page > PAGE_COUNT) return null;
  if (!PAGES.has(page)) PAGES.set(page, png(1100, 1556, [248, 248, 244], [200 - page * 30, 210, 230]));
  return PAGES.get(page);
}

// A download answers a stand-in file the browser saves under the card's own name.
const DOWNLOAD_RE = /^\/api\/teams\/[a-z0-9_]{1,40}\/files\/[0-9a-f]{32}\/download$/u;
const DOWNLOAD = [
  '# Campaign notes',
  '',
  'Launch post: the harbour photo, wide frame.',
  'Caption: "Out on the water at dusk."',
  '',
  '- Post on Tuesday, 9:00',
  '- Tag the photography team',
  '',
].join('\n');

function apiPath(url) {
  const path = new URL(url ?? '/', 'http://preview.invalid').pathname;
  return path === '/api' || path.startsWith('/api/') ? path : null;
}

export function adminPreview() {
  return {
    name: 'shimpz-admin-preview',
    apply: (_config, { command, mode }) => command === 'serve' && mode === PREVIEW_MODE,
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = apiPath(request.url);
        if (!path) return next();
        const preview = request.method === 'GET' ? PREVIEW_RE.exec(path) : null;
        const image = preview ? rendition(preview[1]) : null;
        if (image) {
          response.setHeader('content-type', 'image/png');
          response.setHeader('cache-control', 'no-store');
          response.end(image);
          return;
        }
        const pageMatch = request.method === 'GET' ? PAGE_RE.exec(path) : null;
        const sheet = pageMatch ? pageRendition(Number(pageMatch[1])) : null;
        if (sheet) {
          response.setHeader('content-type', 'image/png');
          response.setHeader('cache-control', 'no-store');
          response.setHeader('x-page-count', String(PAGE_COUNT));
          response.end(sheet);
          return;
        }
        if (request.method === 'GET' && DOWNLOAD_RE.test(path)) {
          response.setHeader('content-type', 'application/octet-stream');
          response.setHeader('content-disposition', 'attachment');
          response.setHeader('cache-control', 'no-store');
          response.end(DOWNLOAD);
          return;
        }
        if (request.method === 'GET' && /\/shimpz-cloudflare\/(?:catalog-)?icon$/u.test(path)) {
          response.setHeader('content-type', 'image/png');
          response.end(CLOUDFLARE_ICON);
          return;
        }
        if (request.method === 'GET' && /\/(?:catalog-)?icon$/u.test(path)) {
          response.setHeader('content-type', 'image/svg+xml');
          response.end(ICON);
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      server.httpServer?.on('upgrade', (request, socket) => {
        if (apiPath(request.url)) socket.destroy();
      });
    },
    // Install the scenario before SvelteKit starts: the generated client app module loads before the router runs.
    transform(code, id) {
      if (!id.split('?')[0].endsWith('/.svelte-kit/generated/dev/client/app.js')) return null;
      return { code: `import ${JSON.stringify(INSTALL)};\n${code}`, map: null };
    },
  };
}
