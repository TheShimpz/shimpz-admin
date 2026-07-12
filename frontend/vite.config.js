import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // Dev-mode only (production is served by FastAPI): proxy API calls to the backend.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4600', changeOrigin: false, ws: true },
    },
  },
});
