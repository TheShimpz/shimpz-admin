import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

import { adminPreview, PREVIEW_MODE } from './preview/plugin.js';

export default defineConfig(({ mode }) => ({
  plugins: [adminPreview(), sveltekit()],
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
