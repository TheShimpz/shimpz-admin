import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

import { adminPreview, PREVIEW_MODE } from './preview/plugin.js';
import { buildRevision, buildVersion } from './src/lib/space/version.js';

// The owner's presentation preview (ADR-0087) names one fixed build, so its version line and the notice a tab built
// from another commit shows (`?version=stale`, preview/install.js) can be reviewed there.
const PREVIEW_BUILD = { epoch: '1790000000', revision: 'a'.repeat(40) };

export default defineConfig(({ mode }) => {
  const { epoch, revision } = mode === PREVIEW_MODE
    ? PREVIEW_BUILD
    : { epoch: process.env.SOURCE_DATE_EPOCH, revision: process.env.SOURCE_REVISION };
  return {
    // The version the sidebar shows, from the commit the image build names, and that commit, which the page compares
    // with the one Admin's session socket names.
    define: {
      __ADMIN_VERSION__: JSON.stringify(buildVersion(epoch, revision)),
      __ADMIN_REVISION__: JSON.stringify(buildRevision(epoch, revision)),
    },
    plugins: [
      adminPreview(),
      sveltekit({
        // SPA: everything falls back to index.html; FastAPI serves the build dir and owns /api. Each text file also
        // gets its brotli and gzip siblings, which Admin sends in its place to a browser that accepts them.
        adapter: adapter({ fallback: 'index.html', precompress: true }),
        // The build is bound to the release epoch, and nothing reads `updated`, so the client never polls for a
        // release.
        version: { name: process.env.SOURCE_DATE_EPOCH || '0', pollInterval: 0 },
      }),
    ],
    server: mode === PREVIEW_MODE
      // The owner's presentation preview (ADR-0087): loopback only, one fixed port for the SSH tunnel, no backend.
      ? { host: '127.0.0.1', port: 5173, strictPort: true }
      : {
          // Dev-mode only (production is served by FastAPI): proxy API calls to the backend.
          proxy: {
            '/api': { target: 'http://127.0.0.1:4600', changeOrigin: false, ws: true },
          },
        },
  };
});
