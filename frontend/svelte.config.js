import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    // SPA: everything falls back to index.html; FastAPI serves the build dir and owns /api.
    adapter: adapter({ fallback: 'index.html' }),
    version: { name: process.env.SOURCE_DATE_EPOCH || '0' },
  },
};
