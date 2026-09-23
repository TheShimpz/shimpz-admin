// Measure the built Local Assistants page with bounded, deterministic API delays.
import { chromium } from '@playwright/test';
import { performance } from 'node:perf_hooks';
import { preview } from 'vite';
import modelCatalog from '../src/lib/modelCatalog.json' with { type: 'json' };

const samples = positiveInteger(process.env.SHIMPZ_PERF_SAMPLES, 20);
const apiDelayMs = nonnegativeInteger(process.env.SHIMPZ_PERF_API_DELAY_MS, 40);
const snapshotDelayMs = nonnegativeInteger(process.env.SHIMPZ_PERF_SNAPSHOT_DELAY_MS, apiDelayMs);
const iconDelayMs = nonnegativeInteger(process.env.SHIMPZ_PERF_ICON_DELAY_MS, 80);
const composition = process.env.SHIMPZ_PERF_COMPOSITION ?? 'balanced';
if (!['balanced', 'published'].includes(composition)) throw new Error('Invalid Assistant composition.');
const iconPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const teamId = 'perf_team';

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Sample count must be a positive integer.');
  return parsed;
}

function nonnegativeInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (value === '') throw new Error('Delay must be a nonnegative integer.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Delay must be a nonnegative integer.');
  return parsed;
}

function fixture(count) {
  const localCount = composition === 'balanced' ? Math.floor(count / 2) : 0;
  const local = Array.from({ length: localCount }, (_, index) => ({
    assistant_id: `bench-local-${index + 1}`,
    assistant_version: '1.0.0',
    name: `Local Assistant ${index + 1}`,
    summary: 'A measured local snapshot.',
    actions: ['inspect'],
    integrations: [],
    declared_creators: ['@creator'],
    created_at: '2026-09-23T00:00:00Z',
    image_id: `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
    platform: 'linux/amd64',
    provenance: 'local',
    unpublished: true,
  }));
  const published = Array.from({ length: count - localCount }, (_, index) => ({
    assistant_id: `bench-public-${index + 1}`,
    assistant_version: '1.0.0',
    creators: ['@creator'],
    icon_digest: `sha256:${'b'.repeat(64)}`,
    name: `Published Assistant ${index + 1}`,
    source_digest: `sha256:${'a'.repeat(64)}`,
    summary: 'A measured public Assistant.',
  }));
  return { local, published };
}

function apiBody(path, data) {
  if (path === '/api/session') return {
    profile: 'local', authenticated: true, initialized: true,
    authentication_state: 'configured', authentication_method: 'webauthn',
    origin_admitted: true, passkey_enrollment_available: true,
    passkey_registered: true, oauth_completion_mode: 'automatic',
    features: { teamCredentials: true },
  };
  if (path === '/api/notifications') return { notifications: [], unread_count: 0 };
  if (path === '/api/notifications/sync') return {
    notifications: [], unread_count: 0,
    sync: { status: 'ok', updated_assistants: 0, notifications_added: 0, failed_updates: 0 },
  };
  if (path === '/api/model-providers') return {
    providers: modelCatalog.providers.map((provider) => ({
      id: provider.id,
      title: provider.title,
      default_model: provider.default_model,
      models: provider.models,
      configured: provider.id === modelCatalog.default_provider,
      masked: null,
    })),
  };
  if (path === '/api/platform-release') return {
    release: `ghcr.io/theshimpz/shimpz-local-release@sha256:${'d'.repeat(64)}`,
    ordinal: 1,
    checked_at: '2026-09-23T00:00:00Z',
    outcome: 'current',
  };
  if (path === '/api/teams') return {
    teams: [{ team_id: teamId, team_name: 'Performance Team', status: 'running' }],
  };
  if (path === '/api/assistants') return { assistants: [] };
  if (path === `/api/teams/${teamId}/assistants`) return { assistants: [] };
  if (path === `/api/teams/${teamId}/inference`) return {
    team_id: teamId,
    provider: modelCatalog.default_provider,
    model: modelCatalog.providers.find((provider) => provider.id === modelCatalog.default_provider).default_model,
  };
  if (path === `/api/teams/${teamId}/assistant-integrations`) return { integrations: [] };
  if (path === '/api/assistant-catalog') return { version: 1, assistants: data.published };
  if (path === '/api/local-assistants') return { assistants: data.local, trace_id: 'c'.repeat(32) };
  return null;
}

async function mockApi(page, data) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const icon = path.startsWith('/api/local-assistants/') && path.endsWith('/icon')
      || path.startsWith('/api/assistants/') && path.endsWith('/catalog-icon');
    let delayMs = apiDelayMs;
    if (icon) delayMs = iconDelayMs;
    if (path === '/api/local-assistants') delayMs = snapshotDelayMs;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (icon) {
      await route.fulfill({ contentType: 'image/png', body: iconPng });
      return;
    }
    const body = apiBody(path, data);
    await route.fulfill({
      status: body === null ? 404 : 200,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { detail: 'unexpected benchmark request' }),
    });
  });
}

function observePresentation(expectedCards) {
  performance.setResourceTimingBufferSize(1000);
  const observed = {
    bootSeen: false, bootHidden: null, cardsInDom: null,
    cardsVisibleFrame: null, iconSourcesReady: null,
  };
  window.__assistantPerf = observed;
  const mark = (key) => {
    if (observed[key] === null) observed[key] = performance.now();
    if (observed.bootHidden !== null && observed.cardsVisibleFrame !== null
      && observed.cardsInDom !== null && observed.iconSourcesReady !== null) observer.disconnect();
  };
  const inspect = () => {
    const boot = document.querySelector('[data-slot="boot-screen"]');
    if (boot) observed.bootSeen = true;
    const catalog = document.querySelector('section.assistant-catalog');
    const cardCount = catalog?.querySelectorAll('article').length ?? 0;
    if (cardCount === expectedCards && !catalog?.querySelector('.assistant-catalog-loading')) {
      mark('cardsInDom');
    }
    if (observed.bootSeen && !boot && catalog) mark('bootHidden');
    if (observed.bootHidden !== null && cardCount === expectedCards) {
      requestAnimationFrame(() => mark('cardsVisibleFrame'));
    }
    if (cardCount === expectedCards && catalog.querySelectorAll('article img[src^="blob:"]').length === expectedCards) {
      mark('iconSourcesReady');
    }
  };
  const observer = new MutationObserver(inspect);
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', inspect, { once: true });
}

function phase(path) {
  if (path === '/api/session') return 'session';
  if (path === '/api/teams' || path === '/api/assistants') return 'team-start';
  if (path === `/api/teams/${teamId}/assistants`) return 'team-inventory';
  if (path === '/api/assistant-catalog') return 'catalog';
  if (path === '/api/local-assistants') return 'snapshots';
  if (path.endsWith('/icon') || path.endsWith('/catalog-icon')) return 'icons';
  return 'other';
}

function timeline(resources) {
  const spans = {};
  for (const entry of resources) {
    const path = new URL(entry.name).pathname;
    if (!path.startsWith('/api/')) continue;
    const name = phase(path);
    const span = spans[name] ?? { count: 0, startMs: Infinity, endMs: 0 };
    span.count += 1;
    span.startMs = Math.min(span.startMs, entry.startTime);
    span.endMs = Math.max(span.endMs, entry.responseEnd);
    spans[name] = span;
  }
  return spans;
}

async function taskDuration(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return (metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0) * 1000;
}

async function sample(page, cdp, mode, count, index) {
  const counts = {};
  let errors = 0;
  const onRequest = (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) counts[path] = (counts[path] ?? 0) + 1;
  };
  const onResponse = (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) errors += 1;
  };
  const onFailed = (request) => {
    if (request.url().includes('/api/')) errors += 1;
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  const started = performance.now();
  try {
    if (mode === 'cold') await page.goto('/assistants/', { waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const state = window.__assistantPerf;
      return state && state.cardsInDom !== null && state.bootHidden !== null && state.cardsVisibleFrame !== null
        && state.iconSourcesReady !== null;
    }, null, { timeout: 15000 });
    const result = await page.evaluate(() => ({
      marks: window.__assistantPerf,
      resources: performance.getEntriesByType('resource').map((entry) => ({
        name: entry.name, startTime: entry.startTime, responseEnd: entry.responseEnd,
      })),
    }));
    const requests = {};
    for (const [path, total] of Object.entries(counts)) {
      const name = phase(path);
      requests[name] = (requests[name] ?? 0) + total;
    }
    return {
      count, composition, sample: index, mode, errors, requests,
      marks: result.marks, timeline: timeline(result.resources),
      taskMs: Math.round(await taskDuration(cdp) * 10) / 10,
      observedWallMs: Math.round(performance.now() - started),
    };
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1]);
}

function summarize(results, count, mode) {
  const selected = results.filter((result) => result.count === count && result.mode === mode);
  const metrics = {};
  for (const name of ['cardsInDom', 'bootHidden', 'cardsVisibleFrame', 'iconSourcesReady']) {
    const values = selected.map((result) => result.marks[name]);
    metrics[name] = { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
  }
  const phases = {};
  for (const name of ['session', 'team-start', 'team-inventory', 'catalog', 'snapshots', 'icons']) {
    const spans = selected.map((result) => result.timeline[name]).filter(Boolean);
    if (spans.length !== selected.length) throw new Error(`Missing ${name} timing span.`);
    const requestCounts = spans.map((span) => span.count);
    phases[name] = {
      requests: { min: Math.min(...requestCounts), max: Math.max(...requestCounts) },
      endMs: { p50: percentile(spans.map((span) => span.endMs), 0.5),
        p95: percentile(spans.map((span) => span.endMs), 0.95) },
      windowMs: { p50: percentile(spans.map((span) => span.endMs - span.startMs), 0.5),
        p95: percentile(spans.map((span) => span.endMs - span.startMs), 0.95) },
    };
  }
  const cardsToBoot = selected.map((result) => result.marks.bootHidden - result.marks.cardsInDom);
  const cpu = selected.map((result) => result.taskMs);
  return {
    count, composition, mode, samples: selected.length,
    delaysMs: { api: apiDelayMs, snapshots: snapshotDelayMs, icon: iconDelayMs },
    errors: selected.reduce((total, result) => total + result.errors, 0),
    taskMs: { p50: percentile(cpu, 0.5), p95: percentile(cpu, 0.95) },
    cardsToBootMs: { p50: percentile(cardsToBoot, 0.5), p95: percentile(cardsToBoot, 0.95) },
    metrics, phases,
  };
}

const server = await preview({ preview: { host: '127.0.0.1', port: 4173, strictPort: true } });
let browser;
const results = [];
try {
  browser = await chromium.launch();
  const origin = server.resolvedUrls.local[0];
  const warmContext = await browser.newContext({ baseURL: origin });
  try {
    const warmPage = await warmContext.newPage();
    const warmCdp = await warmContext.newCDPSession(warmPage);
    await warmCdp.send('Performance.enable');
    await warmPage.addInitScript(observePresentation, 1);
    await mockApi(warmPage, fixture(1));
    const warmup = await sample(warmPage, warmCdp, 'cold', 1, 0);
    if (warmup.errors) throw new Error('The benchmark warmup had an API error.');
  } finally {
    await warmContext.close();
  }
  const counts = [1, 8, 24];
  for (let index = 1; index <= samples; index += 1) {
    for (let offset = 0; offset < counts.length; offset += 1) {
      const count = counts[(index + offset - 1) % counts.length];
      const context = await browser.newContext({ baseURL: origin });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      await page.addInitScript(observePresentation, count);
      await mockApi(page, fixture(count));
      try {
        for (const mode of ['cold', 'warm']) {
          const result = await sample(page, cdp, mode, count, index);
          results.push(result);
          console.log(JSON.stringify({ type: 'sample', ...result }));
        }
      } finally {
        await context.close();
      }
    }
  }
  for (const count of counts) {
    for (const mode of ['cold', 'warm']) {
      console.log(JSON.stringify({ type: 'summary', ...summarize(results, count, mode) }));
    }
  }
  if (results.some((result) => result.errors > 0)) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
