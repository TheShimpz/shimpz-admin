// Serve the built Admin UI for the browser tests the way Admin's backend does: a real asset when the path maps to
// one, otherwise the SPA's index.html; `/api` is never served here (the tests answer it). In CI, `build/` is the UI
// copied out of the Admin image, so the suite exercises the shipping artifact.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../build/', import.meta.url));
const TYPES = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function asset(pathname) {
  const target = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (!target.startsWith(ROOT) && `${target}${sep}` !== ROOT) return null;
  try {
    return statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    response.writeHead(404).end();
    return;
  }
  const file = asset(pathname) ?? join(ROOT, 'index.html');
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(4173, '127.0.0.1');
