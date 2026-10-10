import { localeReady } from '$lib/i18n.js';

// SPA mode: the local control panel talks to FastAPI over fetch/WS; nothing is prerendered
// with data and nothing is server-rendered (adapter-static fallback serves index.html).
export const ssr = false;
export const prerender = false;
export const csr = true;

// Nothing renders before the interface language's catalog has arrived, so no screen first shows another language.
export async function load() {
  await localeReady;
}
