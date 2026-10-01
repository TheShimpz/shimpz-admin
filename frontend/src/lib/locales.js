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

/** Whether a value is one of the closed interface languages a chat turn may name (ADR-0090). */
export function isLocale(value) {
  return LOCALES.some((entry) => entry.code === value);
}
