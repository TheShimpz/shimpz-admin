import { exactKeys, jsonObject } from './validate.js';

// The Team protocol's resource signal (`resources.canonical_space_resources`): its closed fields and bounds.
const FIELDS = [
  'memory_total_bytes',
  'memory_used_bytes',
  'services_running',
  'services_total',
  'storage_total_bytes',
  'storage_used_bytes',
];
const MAX_SERVICES = 32;
const GIB = 2 ** 30;

function count(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

// Both null, or a used and a positive total byte count; `within` also bounds the use by the total.
function pair(used, total, within) {
  if (used === null && total === null) return true;
  return count(used, Number.MAX_SAFE_INTEGER) && count(total, Number.MAX_SAFE_INTEGER) && total > 0
    && (!within || used <= total);
}

/** The Space's resource signal Team measured now, or null when it is unavailable or leaves its closed shape. */
export async function fetchSpaceResources(fetcher) {
  const response = await fetcher('/api/space/resources', { cache: 'no-store' });
  if (!response.ok) return null;
  const body = await jsonObject(response);
  if (
    !exactKeys(body, FIELDS)
    || !count(body.services_total, MAX_SERVICES)
    || body.services_total < 1
    || !count(body.services_running, body.services_total)
    || !pair(body.memory_used_bytes, body.memory_total_bytes, false)
    || !pair(body.storage_used_bytes, body.storage_total_bytes, true)
  ) return null;
  return body;
}

/**
 * The signal's three segments in one interface language: running services out of all of them, then memory and the
 * storage filesystem in GiB with at most one fraction digit, or only the label when that pair is unknown.
 */
export function resourceSegments(resources, locale, t) {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const amount = (used, total) => (used === null
    ? null
    : `${number.format(used / GIB)}/${number.format(total / GIB)} ${t('shell.resourceUnit')}`);
  return [
    { label: t('shell.resourceServices'), value: `${number.format(resources.services_running)}/${number.format(resources.services_total)}` },
    { label: t('shell.resourceMemory'), value: amount(resources.memory_used_bytes, resources.memory_total_bytes) },
    { label: t('shell.resourceStorage'), value: amount(resources.storage_used_bytes, resources.storage_total_bytes) },
  ];
}
