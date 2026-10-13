import { exactKeys, jsonObject } from './api.js';
import { isCount } from './grammar.js';

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

// Both null, or a used and a positive total byte count; `within` also bounds the use by the total.
function pair(used, total, within) {
  if (used === null && total === null) return true;
  return isCount(used, Number.MAX_SAFE_INTEGER) && isCount(total, Number.MAX_SAFE_INTEGER) && total > 0
    && (!within || used <= total);
}

/** The Space's resource signal Team measured now, or null when it is unavailable or leaves its closed shape. */
export async function fetchSpaceResources(read) {
  const response = await read('space.resources', {});
  if (!response.ok) return null;
  const body = await jsonObject(response);
  if (
    !exactKeys(body, FIELDS)
    || !isCount(body.services_total, MAX_SERVICES)
    || body.services_total < 1
    || !isCount(body.services_running, body.services_total)
    || !pair(body.memory_used_bytes, body.memory_total_bytes, false)
    || !pair(body.storage_used_bytes, body.storage_total_bytes, true)
  ) return null;
  return body;
}

// Use at or above these shares of a total reads as close to full: first a warning, then an alert.
const WARN = 0.8;
const ALERT = 0.9;

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

/**
 * The Space's one status: its level (ok, warn, alert) and the message key of its worst condition. A stopped service is
 * the worst, then a resource at its total, then one at or above the alert or warning share; unknown pairs count as ok.
 */
export function resourceStatus(resources) {
  const share = (used, total) => (used === null ? 0 : used / total);
  const memory = share(resources.memory_used_bytes, resources.memory_total_bytes);
  const storage = share(resources.storage_used_bytes, resources.storage_total_bytes);
  if (resources.services_running < resources.services_total) return { level: 'alert', message: 'shell.resourceServiceStopped' };
  const worst = storage >= memory
    ? { share: storage, full: 'shell.resourceStorageFull', near: 'shell.resourceStorageNearlyFull' }
    : { share: memory, full: 'shell.resourceMemoryFull', near: 'shell.resourceMemoryNearlyFull' };
  if (worst.share >= 1) return { level: 'alert', message: worst.full };
  if (worst.share >= ALERT) return { level: 'alert', message: worst.near };
  if (worst.share >= WARN) return { level: 'warn', message: worst.near };
  return { level: 'ok', message: 'shell.resourceOk' };
}
