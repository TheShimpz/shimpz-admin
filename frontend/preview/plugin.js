// `vite dev --mode scenarios` only (ADR-0087): the owner's presentation preview. The browser answers the Admin API
// from a scenario (install.js); this server refuses every other `/api` request and socket, so an image, navigation,
// or frame never reaches a backend. Nothing here is part of `vite build`.
import { fileURLToPath } from 'node:url';

export const PREVIEW_MODE = 'scenarios';

const INSTALL = fileURLToPath(new URL('./install.js', import.meta.url));
// Assistant icons load as images, which the browser-side scenario cannot answer; serve one neutral mark instead.
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#1c3b3f"/></svg>';

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
      if (!id.split('?')[0].endsWith('/.svelte-kit/generated/client/app.js')) return null;
      return { code: `import ${JSON.stringify(INSTALL)};\n${code}`, map: null };
    },
  };
}
