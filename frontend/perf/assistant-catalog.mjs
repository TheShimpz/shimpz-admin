// Measure the built Local Assistants page with bounded, deterministic API delays. The page's session socket
// (`perf/sessionSocket.js`) runs in the page and the benchmark runner answers each of its calls after its delay; the session
// bootstrap and the icons stay HTTP.
// SHIMPZ_PERF_SCENARIO=navigation measures instead a same-tab visit from the chat: the chat loads, the page is left
// alone until it sends nothing for a second (so anything it prepares at idle is done), and a click on the sidebar's
// Store link is timed until every row's icon is decoded in the frame before its paint; then the Chat link and the Store
// link again time the repeat visit, and each return to the chat is timed too, until the conversation shows its history
// and then until its composer takes text. SHIMPZ_PERF_ICON_PX sets the icons' size (1 by default, 1024 as published).
// SHIMPZ_PERF_CONTROL_DELAY_MS delays the socket's own subscriptions and chat attach (0 by default).
// For a real Supervisor session, run in a Playwright container sharing the network
// namespace of a disposable Admin image with --network none, a fresh /data volume,
// and uvicorn bound to port 7777 inside that namespace. No host port is published.
// SHIMPZ_PERF_ISOLATED_AUTH=1 requires a loopback-only network and a fresh Admin.
import { chromium } from '@playwright/test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { performance } from 'node:perf_hooks';
import { crc32, deflateSync } from 'node:zlib';
import { preview } from 'vite';
import modelCatalog from '../src/lib/brain/catalog.json' with { type: 'json' };
import { authenticatedLocalSession } from '../e2e/scenarios.js';
import { installSessionSocket } from './sessionSocket.js';

if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('This benchmark requires Node.js 26.');
const samples = positiveInteger(process.env.SHIMPZ_PERF_SAMPLES, 20);
const apiDelayMs = nonnegativeInteger(process.env.SHIMPZ_PERF_API_DELAY_MS, 40);
const snapshotDelayMs = nonnegativeInteger(process.env.SHIMPZ_PERF_SNAPSHOT_DELAY_MS, apiDelayMs);
const iconDelayMs = nonnegativeInteger(process.env.SHIMPZ_PERF_ICON_DELAY_MS, 80);
const controlDelayMs = nonnegativeInteger(process.env.SHIMPZ_PERF_CONTROL_DELAY_MS, 0);
const composition = process.env.SHIMPZ_PERF_COMPOSITION ?? 'balanced';
if (!['balanced', 'published'].includes(composition)) throw new Error('Invalid Assistant composition.');
const scenario = process.env.SHIMPZ_PERF_SCENARIO ?? 'load';
if (!['load', 'navigation'].includes(scenario)) throw new Error('Invalid benchmark scenario.');
const iconPx = positiveInteger(process.env.SHIMPZ_PERF_ICON_PX, 1);
if (iconPx > 1024) throw new Error('Icons are at most 1024 pixels square.');
const isolatedAuth = process.env.SHIMPZ_PERF_ISOLATED_AUTH === '1';
if (isolatedAuth && scenario !== 'load') throw new Error('Real Supervisor measurement covers the load scenario only.');
if (process.env.SHIMPZ_PERF_ISOLATED_AUTH !== undefined && !isolatedAuth) {
  throw new Error('Isolated authentication mode must be exactly 1.');
}
const counts = (process.env.SHIMPZ_PERF_COUNTS ?? '1,8,24').split(',').map(Number);
if (counts.length < 1 || counts.length > 3 ||
    counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 50) ||
    new Set(counts).size !== counts.length) {
  throw new Error('Assistant counts must be one to three distinct integers from 1 to 50.');
}
const iconPng = iconPx === 1
  ? Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  : squarePng(iconPx);
// Admin serves a publication's icon only with the digest its catalog entry names, and the page checks it.
const iconDigest = `sha256:${createHash('sha256').update(iconPng).digest('hex')}`;
const teamId = 'perf_team';

// A square RGBA PNG with varied pixels, so its encoded size and decode work resemble a published icon's.
function squarePng(size) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  let seed = 7;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const offset = row + 1 + x * 4;
      rows[offset] = (x * 255) / size;
      rows[offset + 1] = (y * 255) / size;
      rows[offset + 2] = seed & 0x3f;
      rows[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
    admission: 'admissible',
    reason: null,
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
    description: 'A measured public Assistant with one read-only Action.',
    icon_digest: iconDigest,
    actions: [{ id: 'inspect', effect: 'read_only', description: 'Inspect the measured state.' }],
    integrations: [],
    links: {},
    name: `Published Assistant ${index + 1}`,
    source_digest: `sha256:${'a'.repeat(64)}`,
    stored_inputs: [],
    summary: 'A measured public Assistant.',
  }));
  return { local, published };
}

// Each session socket operation the page makes, answered from the fixture.
function callBody(method, params, data) {
  const answers = {
    'models.list': () => ({
      providers: modelCatalog.providers.map((provider) => ({
        id: provider.id,
        title: provider.title,
        default_model: provider.default_model,
        models: provider.models.filter((model) => model.chat === true).map(({ chat: _chat, ...model }) => model),
        configured: provider.id === modelCatalog.default_provider,
        masked: null,
      })),
    }),
    'platform.release': () => ({
      release: `ghcr.io/theshimpz/shimpz-local-release@sha256:${'d'.repeat(64)}`,
      ordinal: 1,
      checked_at: '2026-09-23T00:00:00Z',
      outcome: 'current',
    }),
    'security.summary': () => ({
      failed_second_factor_attempts: 0, recovery_codes_remaining: 10,
      sign_in_history: { previous: { at: '2026-09-23T00:00:00Z', origin: 'http://127.0.0.1:7777' }, failures_since: 0 },
    }),
    'teams.list': () => ({ teams: [{ team_id: teamId, team_name: 'Performance Team', status: 'running' }] }),
    'assistants.registry': () => ({ assistants: [] }),
    'assistants.list': () => ({ assistants: [] }),
    'inference.read': () => ({
      team_id: teamId,
      provider: modelCatalog.default_provider,
      model: modelCatalog.providers.find((provider) => provider.id === modelCatalog.default_provider).default_model,
    }),
    'integrations.list': () => ({ integrations: [] }),
    'routines.list': () => ({ team_id: teamId, routines: [], runs: [], incidents: [] }),
    'store.catalog': () => ({ version: 1, locale: 'en', assistants: data.published, next: null }),
    'snapshots.list': () => ({ assistants: data.local, trace_id: 'c'.repeat(32) }),
    'snapshots.summary': () => ({ locale: 'en', summary: 'A measured local snapshot.' }),
    // What the chat a navigation starts from reads: a transcript of HISTORY_EXCHANGES exchanges and no decision provider.
    'history.page': () => ({ entries: HISTORY_ENTRIES, before: null }),
    'decision.read': () => ({ provider: 'typesafe', configured: false, masked: null }),
  };
  if (['inference.read', 'assistants.list', 'integrations.list', 'routines.list', 'history.page'].includes(method)
      && params.team_id !== teamId) return null;
  return answers[method]?.() ?? null;
}

// The chat's history: each exchange a question and a short Markdown reply.
const HISTORY_EXCHANGES = 12;
const HISTORY_ENTRIES = Array.from({ length: HISTORY_EXCHANGES }, (_, index) => {
  const id = (index + 1).toString(16).padStart(32, '0');
  const at = new Date(Date.UTC(2026, 8, 23) + index * 600_000).toISOString().replace('.000Z', 'Z');
  return [
    { id: `${id}:user`, created_at: at, kind: 'message', role: 'user', text: `Question ${index + 1}: what changed?` },
    { id: `${id}:reply`, created_at: at, kind: 'message', role: 'assistant', author: 'Performance Team',
      text: `### Answer ${index + 1}\n\n- **Status:** ready.\n- **Next:** review the two changed records.` },
  ];
}).flat();

// Requests the closed fixture does not answer; any of them fails the run instead of skewing a sample.
const unexpectedRequests = new Set();

function requireAnsweredRequests() {
  if (unexpectedRequests.size) throw new Error(`Unanswered benchmark requests: ${[...unexpectedRequests].join(', ')}`);
}

// The session socket's calls, timed in the page as they leave and as their results arrive.
function observeCalls() {
  window.__calls = [];
  window.benchCallSent = (method) => window.__calls.push({ method, startTime: performance.now(), responseEnd: null });
  window.benchCallAnswered = (method) => {
    const call = window.__calls.find((entry) => entry.method === method && entry.responseEnd === null);
    if (call) call.responseEnd = performance.now();
  };
}

// `data` is read through `current.data`, so one page serves the fixture of the sample it runs.
async function mockApi(page, current) {
  await page.addInitScript((delay) => { window.benchControlDelayMs = delay; }, controlDelayMs);
  await page.addInitScript(observeCalls);
  await page.addInitScript(installSessionSocket);
  await page.exposeFunction('benchCall', async (method, params) => {
    await new Promise((resolve) => setTimeout(resolve, method === 'snapshots.list' ? snapshotDelayMs : apiDelayMs));
    const body = callBody(method, params, current.data);
    if (body === null) {
      unexpectedRequests.add(`call ${method}`);
      return { status: 503, body: { detail: 'unexpected benchmark call' } };
    }
    return { status: 200, body };
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (isolatedAuth && path === '/api/session') {
      await route.continue();
      return;
    }
    const icon = path.startsWith('/api/local-assistants/') && path.endsWith('/icon')
      || path.startsWith('/api/assistants/') && path.endsWith('/catalog-icon');
    await new Promise((resolve) => setTimeout(resolve, icon ? iconDelayMs : apiDelayMs));
    if (icon) {
      await route.fulfill({ contentType: 'image/png', body: iconPng });
      return;
    }
    const body = path === '/api/session' ? authenticatedLocalSession() : null;
    if (body === null) unexpectedRequests.add(`${route.request().method()} ${path}`);
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
  // The rows the page shows icons for: on or within 400 px of the region the catalog scrolls in, at most 48.
  const nearRows = (catalog) => {
    let region = catalog;
    while (region && !['auto', 'scroll'].includes(getComputedStyle(region).overflowY)) region = region.parentElement;
    const fold = (region ?? document.documentElement).getBoundingClientRect().bottom + 400;
    return [...catalog.querySelectorAll('a.assistant-row')].filter((row) => row.getBoundingClientRect().top <= fold)
      .slice(0, 48);
  };
  const inspect = () => {
    const boot = document.querySelector('[data-slot="boot-screen"]');
    if (boot) observed.bootSeen = true;
    const catalog = document.querySelector('section.assistant-catalog');
    const cardCount = catalog?.querySelectorAll('a.assistant-row').length ?? 0;
    if (cardCount === expectedCards && !catalog?.querySelector('.assistant-catalog-loading')) {
      mark('cardsInDom');
    }
    if (observed.bootSeen && !boot && catalog) mark('bootHidden');
    if (observed.bootHidden !== null && cardCount === expectedCards) {
      requestAnimationFrame(() => mark('cardsVisibleFrame'));
    }
    if (cardCount === expectedCards
      && nearRows(catalog).every((row) => row.querySelector('img[src^="blob:"]'))) {
      mark('iconSourcesReady');
    }
  };
  const observer = new MutationObserver(inspect);
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', inspect, { once: true });
}

// A phase by HTTP path or by socket operation.
function phase(name) {
  if (name === '/api/session') return 'session';
  if (name === 'teams.list' || name === 'assistants.registry') return 'team-start';
  if (name === 'assistants.list') return 'team-inventory';
  if (name === 'store.catalog') return 'catalog';
  if (name === 'snapshots.list') return 'snapshots';
  if (name.endsWith('/icon') || name.endsWith('/catalog-icon')) return 'icons';
  return 'other';
}

function timeline(entries) {
  const spans = {};
  for (const entry of entries) {
    const name = phase(entry.name);
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
  let errors = 0;
  const onResponse = (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) errors += 1;
  };
  const onFailed = (request) => {
    if (request.url().includes('/api/')) errors += 1;
  };
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  const started = performance.now();
  try {
    const sessionResponse = isolatedAuth
      ? page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session'
        && response.request().method() === 'POST')
      : null;
    if (mode === 'cold') await page.goto('/assistants/', { waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    if (sessionResponse) {
      const session = await (await sessionResponse).json();
      if (session.authenticated !== true || session.authentication_method !== 'totp'
          || session.origin_admitted !== true) {
        throw new Error('The real Supervisor session changed during measurement.');
      }
    }
    await page.waitForFunction(() => {
      const state = window.__assistantPerf;
      return state && state.cardsInDom !== null && state.bootHidden !== null && state.cardsVisibleFrame !== null
        && state.iconSourcesReady !== null;
    }, null, { timeout: 15000 }).catch((error) => {
      requireAnsweredRequests();
      throw error;
    });
    requireAnsweredRequests();
    // HTTP requests by path and session socket calls by operation, each with its start and end on the page's clock.
    const result = await page.evaluate(() => ({
      marks: window.__assistantPerf,
      resources: [
        ...performance.getEntriesByType('resource')
          .filter((entry) => new URL(entry.name).pathname.startsWith('/api/'))
          .map((entry) => ({ name: new URL(entry.name).pathname, startTime: entry.startTime, responseEnd: entry.responseEnd })),
        ...window.__calls.filter((call) => call.responseEnd !== null)
          .map((call) => ({ name: call.method, startTime: call.startTime, responseEnd: call.responseEnd })),
      ],
    }));
    const requests = {};
    for (const entry of result.resources) {
      const name = phase(entry.name);
      requests[name] = (requests[name] ?? 0) + 1;
    }
    return {
      count, composition, sample: index, mode, errors, requests,
      marks: result.marks, timeline: timeline(result.resources),
      taskMs: Math.round(await taskDuration(cdp) * 10) / 10,
      observedWallMs: Math.round(performance.now() - started),
    };
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
  }
}

// Until the page has sent nothing for `quietMs` (no session socket call and no HTTP request under way or begun).
async function settled(page, quietMs = 1000) {
  await page.waitForFunction((quiet) => {
    const now = performance.now();
    const calls = window.__calls ?? [];
    if (calls.some((call) => call.responseEnd === null)) return false;
    const last = Math.max(
      0,
      ...calls.map((call) => call.responseEnd),
      ...performance.getEntriesByType('resource').map((entry) => entry.responseEnd || now),
    );
    return now - last >= quiet;
  }, quietMs, { timeout: 20000, polling: 100 });
}

// Click one sidebar link and time, on the page's clock, the first frame in which the catalog shows `expected` rows,
// every one with its decoded icon; that frame's paint follows it, so the time is a lower bound on the visible one.
async function timedStoreVisit(page, expected) {
  await page.evaluate((count) => {
    const link = document.querySelector('a[href^="/assistants/?team="]');
    if (!link) throw new Error('The Store link is missing.');
    const visit = { start: performance.now(), shown: null };
    window.__visit = visit;
    // The rows the page shows icons for: on or within 400 px of the region the catalog scrolls in, at most 48.
    const nearRows = (catalog) => {
      let region = catalog;
      while (region && !['auto', 'scroll'].includes(getComputedStyle(region).overflowY)) region = region.parentElement;
      const fold = (region ?? document.documentElement).getBoundingClientRect().bottom + 400;
      return [...catalog.querySelectorAll('a.assistant-row')].filter((row) => row.getBoundingClientRect().top <= fold)
        .slice(0, 48);
    };
    const check = () => {
      const catalog = document.querySelector('section.assistant-catalog');
      const rows = catalog?.querySelectorAll('a.assistant-row').length ?? 0;
      const icons = rows === count ? nearRows(catalog).map((row) => row.querySelector('img[src^="blob:"]')) : [];
      if (rows === count && icons.every((icon) => icon && icon.complete && icon.naturalWidth > 0)) {
        visit.shown = performance.now() - visit.start;
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
    link.click();
  }, expected);
  await page.waitForFunction(() => window.__visit.shown !== null, null, { timeout: 15000 });
  return Math.round(await page.evaluate(() => window.__visit.shown) * 10) / 10;
}

// Click the sidebar's Chat link and time, on the page's clock, the first frame in which the conversation shows every
// exchange of its history and the composer, outside any loading state (`shown`), and the first in which the composer
// also takes text (`ready`). Frame callbacks precede paint, so both are lower bounds on the visible times.
async function timedChatVisit(page) {
  await page.evaluate((count) => {
    const link = document.querySelector('a[href^="/chat/?team="]');
    if (!link) throw new Error('The Chat link is missing.');
    const visit = { start: performance.now(), shown: null, ready: null };
    window.__chatVisit = visit;
    const check = () => {
      const conversation = document.querySelector('section.conversation');
      const composer = conversation?.querySelector('textarea');
      const shown = Boolean(composer) && !conversation.closest('[inert]') &&
        conversation.querySelectorAll('.exchange').length === count;
      const elapsed = performance.now() - visit.start;
      if (shown && visit.shown === null) visit.shown = elapsed;
      if (shown && !composer.disabled) {
        visit.ready = elapsed;
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
    link.click();
  }, HISTORY_EXCHANGES);
  await page.waitForFunction(() => window.__chatVisit.ready !== null, null, { timeout: 15000 });
  const { shown, ready } = await page.evaluate(() => window.__chatVisit);
  await settled(page, 300);
  return { shown: Math.round(shown * 10) / 10, ready: Math.round(ready * 10) / 10 };
}

async function navigationSample(page, count, index) {
  let errors = 0;
  const onResponse = (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) errors += 1;
  };
  page.on('response', onResponse);
  try {
    await page.goto('/chat/', { waitUntil: 'domcontentloaded' });
    await page.locator('textarea').first().waitFor({ timeout: 15000 });
    await settled(page);
    const iconsBefore = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter((entry) => /\/(?:catalog-)?icon$/.test(new URL(entry.name).pathname)).length);
    const first = await timedStoreVisit(page, count);
    const chat = await timedChatVisit(page);
    const repeat = await timedStoreVisit(page, count);
    const chatAgain = await timedChatVisit(page);
    requireAnsweredRequests();
    return {
      scenario, count, composition, iconPx, sample: index, errors, iconsBeforeVisit: iconsBefore,
      firstMs: first, repeatMs: repeat, chatShownMs: chat.shown, chatReadyMs: chat.ready,
      chatRepeatShownMs: chatAgain.shown, chatRepeatReadyMs: chatAgain.ready,
    };
  } finally {
    page.off('response', onResponse);
  }
}

function summarizeNavigation(results, count) {
  const selected = results.filter((result) => result.count === count);
  const metric = (name) => ({
    p50Ms: percentile(selected.map((result) => result[name]), 0.5),
    p95Ms: percentile(selected.map((result) => result[name]), 0.95),
  });
  return {
    scenario, count, composition, iconPx, samples: selected.length,
    delaysMs: { api: apiDelayMs, snapshots: snapshotDelayMs, icon: iconDelayMs, control: controlDelayMs },
    errors: selected.reduce((total, result) => total + result.errors, 0),
    firstVisit: metric('firstMs'), repeatVisit: metric('repeatMs'),
    chatReturn: { shown: metric('chatShownMs'), ready: metric('chatReadyMs') },
    chatRepeatReturn: { shown: metric('chatRepeatShownMs'), ready: metric('chatRepeatReadyMs') },
  };
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

const isolatedOrigin = 'http://127.0.0.1:7777';

function requireIsolatedLoopback() {
  const interfaces = networkInterfaces();
  const names = Object.keys(interfaces);
  const loopback = interfaces.lo ?? [];
  if (names.length !== 1 || names[0] !== 'lo' || loopback.length === 0 ||
      loopback.some((address) => !address.internal ||
        !['127.0.0.1', '::1'].includes(address.address))) {
    throw new Error('Real Supervisor measurement requires an isolated loopback-only network.');
  }
}

async function waitForFreshAdmin() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let response;
    try {
      response = await fetch(`${isolatedOrigin}/api/session`, {
        method: 'POST', signal: AbortSignal.timeout(1000),
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (!response.ok) throw new Error('The isolated Admin session endpoint failed.');
    const session = await response.json();
    if (session.profile !== 'local' || session.authenticated !== false ||
        session.initialized !== false || session.authentication_state !== 'uninitialized') {
      throw new Error('Real Supervisor measurement requires a fresh, uninitialized Admin.');
    }
    return;
  }
  throw new Error('The isolated Admin did not become ready.');
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.replaceAll(' ', '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid disposable TOTP key.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp(secret) {
  const counter = BigInt(Math.floor(Date.now() / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest.at(-1) & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)
    .toString().padStart(6, '0');
}

async function realSupervisorState(browser) {
  const context = await browser.newContext({ baseURL: isolatedOrigin });
  try {
    const page = await context.newPage();
    await page.goto('/assistants/');
    await page.getByRole('heading', { name: 'Create your admin password' }).waitFor();
    const password = randomBytes(28).toString('base64url');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Confirm password').fill(password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Add an authenticator' }).waitFor();
    const secret = (await page.locator('.totp-enrollment code').textContent())?.trim();
    if (!secret || !/^[A-Z2-7]+$/.test(secret)) throw new Error('TOTP enrollment did not render.');
    await page.getByLabel('Six-digit code').fill(totp(secret));
    const enrolled = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/admin/setup/totp');
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    if ((await enrolled).status() !== 200) throw new Error('Real Supervisor enrollment failed.');
    const session = await page.evaluate(async () => {
      const response = await fetch('/api/session', { method: 'POST', cache: 'no-store' });
      return response.json();
    });
    if (session.authenticated !== true || session.authentication_method !== 'totp'
        || session.origin_admitted !== true) {
      throw new Error('Real Supervisor session was not admitted.');
    }
    return await context.storageState();
  } finally {
    await context.close();
  }
}

if (isolatedAuth) {
  requireIsolatedLoopback();
  await waitForFreshAdmin();
}
const server = isolatedAuth ? null
  : await preview({ preview: { host: '127.0.0.1', port: 4173, strictPort: true } });
let browser;
const results = [];
try {
  browser = await chromium.launch();
  const origin = isolatedAuth ? isolatedOrigin : server.resolvedUrls.local[0];
  const storageState = isolatedAuth ? await realSupervisorState(browser) : null;
  const contextOptions = storageState ? { baseURL: origin, storageState } : { baseURL: origin };
  const warmContext = await browser.newContext(contextOptions);
  try {
    const warmPage = await warmContext.newPage();
    const warmErrors = [];
    warmPage.on('pageerror', (error) => warmErrors.push(error.name));
    const warmCdp = await warmContext.newCDPSession(warmPage);
    await warmCdp.send('Performance.enable');
    await warmPage.addInitScript(observePresentation, 1);
    await mockApi(warmPage, { data: fixture(1) });
    const warmup = await sample(warmPage, warmCdp, 'cold', 1, 0);
    if (warmup.errors || warmErrors.length) throw new Error('The benchmark warmup had an API or browser error.');
  } finally {
    await warmContext.close();
  }
  for (let index = 1; scenario === 'navigation' && index <= samples; index += 1) {
    for (let offset = 0; offset < counts.length; offset += 1) {
      const count = counts[(index + offset - 1) % counts.length];
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.name));
      await mockApi(page, { data: fixture(count) });
      try {
        const result = await navigationSample(page, count, index);
        if (pageErrors.length) throw new Error('The benchmark page raised a browser error.');
        results.push(result);
        console.log(JSON.stringify({ type: 'sample', ...result }));
      } finally {
        await context.close();
      }
    }
  }
  for (let index = 1; scenario === 'load' && index <= samples; index += 1) {
    for (let offset = 0; offset < counts.length; offset += 1) {
      const count = counts[(index + offset - 1) % counts.length];
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.name));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      await page.addInitScript(observePresentation, count);
      await mockApi(page, { data: fixture(count) });
      try {
        for (const mode of ['cold', 'warm']) {
          const result = await sample(page, cdp, mode, count, index);
          if (pageErrors.length) throw new Error('The benchmark page raised a browser error.');
          if (isolatedAuth && (result.requests.session !== 1 || result.requests['team-start'] !== 2
              || result.requests.catalog !== 1 || result.requests.snapshots !== 1
              || result.requests['team-inventory'] !== 1 || result.requests.icons !== count)) {
            throw new Error('The real Supervisor sample changed its API request shape.');
          }
          results.push(result);
          console.log(JSON.stringify({ type: 'sample', ...result,
            ...(isolatedAuth ? { realSupervisor: true, mockedTeamAndCatalog: true } : {}) }));
        }
      } finally {
        await context.close();
      }
    }
  }
  for (const count of scenario === 'navigation' ? counts : []) {
    console.log(JSON.stringify({ type: 'summary', ...summarizeNavigation(results, count) }));
  }
  for (const count of scenario === 'load' ? counts : []) {
    for (const mode of ['cold', 'warm']) {
      console.log(JSON.stringify({ type: 'summary', ...summarize(results, count, mode),
        ...(isolatedAuth ? { realSupervisor: true, mockedTeamAndCatalog: true } : {}) }));
    }
  }
  if (results.some((result) => result.errors > 0)) process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  }
}
