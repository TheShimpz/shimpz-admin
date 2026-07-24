// Tiny i18n: a locale store, a dotted-key t() with English fallback, browser detection, and dir.
// English (en) is the canonical baseline — every other locale falls back to it key-by-key, so a
// partial translation never shows a blank; it shows English.
import { writable, derived } from 'svelte/store';
import { messages } from './messages.js';

export const LOCALES = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'pt', name: 'Português', dir: 'ltr' },
  { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'zh', name: '中文', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', dir: 'ltr' },
  { code: 'ja', name: '日本語', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
];
const CODES = new Set(LOCALES.map((l) => l.code));

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

export const locale = writable(detect());

export function setLocale(code) {
  if (!CODES.has(code)) return;
  locale.set(code);
  if (typeof localStorage !== 'undefined') localStorage.setItem('shimpz_lang', code);
  if (typeof document !== 'undefined') {
    const l = LOCALES.find((x) => x.code === code);
    document.documentElement.lang = code;
    document.documentElement.dir = l?.dir ?? 'ltr';
  }
}

function lookup(code, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), messages[code]);
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
