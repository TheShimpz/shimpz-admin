// SPA mode: the wizard talks to the local FastAPI over fetch/WS; nothing is prerendered
// with data and nothing is server-rendered (adapter-static fallback serves index.html).
export const ssr = false;
export const prerender = false;
export const csr = true;
