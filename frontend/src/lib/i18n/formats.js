// One Intl formatter per kind, locale, and options. Constructing one costs about a hundred times formatting with it
// (a date formatter ~215 µs against ~2 µs), and transcripts and Routine lists format every row on each render.
const formats = new Map();
// How long the viewer's own timezone is trusted before it is resolved again, so a date formatter that names no zone
// follows a device that changed zone; resolving it costs about as much as constructing a formatter.
const VIEWER_ZONE_MS = 60_000;
let viewerZone = '';
let viewerZoneAt = -Infinity;

function cached(Kind, locale, options) {
  const key = `${Kind.name}\u0000${locale}\u0000${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) {
    format = new Kind(locale, options);
    formats.set(key, format);
  }
  return format;
}

function currentViewerZone() {
  const now = Date.now();
  // A clock set back is no reason to keep an older zone longer.
  if (now < viewerZoneAt || now - viewerZoneAt >= VIEWER_ZONE_MS) {
    viewerZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    viewerZoneAt = now;
  }
  return viewerZone;
}

export function dateFormat(locale, options) {
  const zoned = options !== null && options?.timeZone === undefined ? { ...options, timeZone: currentViewerZone() } : options;
  return cached(Intl.DateTimeFormat, locale, zoned);
}

export const numberFormat = (locale, options) => cached(Intl.NumberFormat, locale, options);
export const relativeFormat = (locale, options) => cached(Intl.RelativeTimeFormat, locale, options);
export const pluralRules = (locale, options) => cached(Intl.PluralRules, locale, options);
export const listFormat = (locale, options) => cached(Intl.ListFormat, locale, options);
