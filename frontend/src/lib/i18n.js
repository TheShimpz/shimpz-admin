// Tiny i18n: a locale store, a dotted-key t() with English fallback, browser detection, and dir.
// English (en) is the canonical baseline — every other locale falls back to it key-by-key, so a
// partial translation never shows a blank; it shows English. Only English ships with the app; each other language is
// its own chunk, fetched when it becomes the interface language, and the locale changes only once it has arrived.
import { writable, derived } from 'svelte/store';
import en from './messages/en.js';
import { LOCALES } from './locales.js';

export { LOCALES };

const CODES = new Set(LOCALES.map((l) => l.code));
const catalogs = { en };
const loaders = import.meta.glob(['./messages/*.js', '!./messages/en.js'], { import: 'default' });

async function load(code) {
  catalogs[code] ??= await loaders[`./messages/${code}.js`]();
}

function detect() {
  if (typeof navigator === 'undefined') return 'en';
  const stored = typeof localStorage !== 'undefined' && localStorage.getItem('shimpz_lang');
  if (stored && CODES.has(stored)) return stored;
  for (const l of navigator.languages ?? [navigator.language ?? 'en']) {
    const base = l.toLowerCase().split('-')[0];
    if (CODES.has(base)) return base;
  }
  return 'en';
}

const initial = detect();
export const locale = writable(initial);
// The starting language's catalog; the root layout awaits it before anything renders. Should it fail to arrive, Admin
// starts in English.
export const localeReady = load(initial).catch(() => locale.set('en'));

let requested = initial;

export async function setLocale(code) {
  if (!CODES.has(code)) return;
  requested = code;
  try {
    await load(code);
  } catch {
    return;
  }
  // A later choice made while this language was arriving wins.
  if (requested !== code) return;
  locale.set(code);
  if (typeof localStorage !== 'undefined') localStorage.setItem('shimpz_lang', code);
  if (typeof document !== 'undefined') {
    const l = LOCALES.find((x) => x.code === code);
    document.documentElement.lang = code;
    document.documentElement.dir = l?.dir ?? 'ltr';
  }
}

function lookup(code, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), catalogs[code]);
}

// resolve a dotted key for a given locale, English-fallback, then the raw key as last resort.
function resolve(code, key) {
  const v = lookup(code, key);
  if (v !== undefined) return v;
  const en = lookup('en', key);
  return en !== undefined ? en : key;
}

export const t = derived(locale, ($locale) => (key, params) => {
  let s = resolve($locale, key);
  if (typeof s === 'string' && params) {
    for (const [k, val] of Object.entries(params)) s = s.replaceAll(`{${k}}`, val);
  }
  return s;
});
