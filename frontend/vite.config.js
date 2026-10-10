import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

import { adminPreview, PREVIEW_MODE } from './preview/plugin.js';

export default defineConfig(({ mode }) => ({
  plugins: [
    adminPreview(),
    sveltekit({
      // SPA: everything falls back to index.html; FastAPI serves the build dir and owns /api.
      adapter: adapter({ fallback: 'index.html' }),
      // The build is bound to the release epoch, and nothing reads `updated`, so the client never polls for a release.
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
}));
