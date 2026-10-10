// Measure a real built chat page while older, bounded history is prepended.
// API and WebSocket fixtures are synthetic; Team, Brain, and provider are excluded.
// Build first, then run with Node.js 24 and the pinned Playwright browser image.
// Chromium TaskDuration is page-wide; nearest-rank p95 depends on the sample count.
// Script, layout, and style counters help attribution but do not account for all task time or paint.
// ThreadTime is sampled separately and can differ from TaskDuration in either direction.
// TaskOtherDuration includes other work; heap deltas alone cannot identify garbage collection.
// Each older page loads the way a reader gets it: a wheel scroll to the top of the transcript brings the history
// sentinel into view, and the page requests and prepends the next page with no button.
// Wall time runs from the older-history request to the first frame after its prepend; CPU windows begin at the scroll.
// Journey metrics span every older-page load after the initial hydrated page.
// A forced collection after the visible window bounds deferred heap work separately.
// Journey totals contain the idle and scroll windows; adding them would count work twice.
// Collection totals also include assertions; journeyWallMs is measured by the driver.
// SHIMPZ_HISTORY_EXHAUST=1 makes the measured page the oldest one, so its prepend also removes the history sentinel.
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import catalog from '../src/lib/modelCatalog.json' with { type: 'json' };

const team = { team_id: 'perf_team', team_name: 'Performance Team', status: 'running' };
const provider = catalog.providers.find((item) => item.id === catalog.default_provider);
const models = catalog.providers.map((item) => ({
  id: item.id, title: item.title, default_model: item.default_model,
  models: item.models, configured: item.id === provider.id, masked: null,
}));
const pages = (process.env.SHIMPZ_HISTORY_PAGES ?? '1,4,8').split(',').map(Number);
const samples = Number(process.env.SHIMPZ_PERF_SAMPLES ?? '5');
const exhaust = (process.env.SHIMPZ_HISTORY_EXHAUST ?? '0') === '1';
if (pages.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 16)) {
  throw new Error('Existing page counts must be between 1 and 16.');
}
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 30) {
  throw new Error('Sample count must be between 1 and 30.');
}

const cursor = (index) => `${String(index).padStart(10, '0')}E`;
const id = (index) => index.toString(16).padStart(32, '0');
// Every history row carries the UTC second Admin wrote it; record N was written N seconds after the first.
const createdAt = (index) => new Date(Date.UTC(2026, 9, 1) + index * 1_000).toISOString().replace('.000Z', 'Z');
const percentile = (values, proportion) => {
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(proportion * ordered.length) - 1] * 10) / 10;
};

function historyPage(index, totalPages) {
  const first = (totalPages - index - 1) * 32;
  const entries = [];
  for (let offset = 0; offset < 32; offset += 1) {
    const number = first + offset;
    const marker = `Record ${number}`;
    entries.push({ id: `${id(number)}:user`, created_at: createdAt(number), kind: 'message', role: 'user',
      text: `${marker}: Summarize the status and next steps.` });
    entries.push({ id: `${id(number)}:reply`, created_at: createdAt(number), kind: 'message', role: 'assistant',
      author: team.team_name, text: `### ${marker}\n\n- **Status:** ready for review.\n- **Next:** check the attached result.\n\n\`\`\`text\n${marker}: complete\n\`\`\`` });
  }
  return { entries, before: index + 1 < totalPages ? cursor(index + 1) : null };
}

// Closed HTTP fixtures for the current Admin client contracts, shaped like e2e/scenarios.js. Each answer is keyed by
// method and path; anything else is recorded as unexpected and fails the trial.
function apiFixture(method, path) {
  const answers = {
    'POST /api/session': () => ({
      profile: 'local', authenticated: true, initialized: true,
      authentication_state: 'configured', authentication_method: 'webauthn',
      origin_admitted: true, passkey_enrollment_available: false,
      passkey_registered: false, oauth_completion_mode: 'automatic',
      features: { teamCredentials: true },
    }),
    'GET /api/admin/security': () => ({
      failed_second_factor_attempts: 0, recovery_codes_remaining: 10,
      sign_in_history: { previous: { at: '2026-09-23T00:00:00Z', origin: 'http://127.0.0.1:7777' }, failures_since: 0 },
    }),
    'GET /api/teams': () => ({ teams: [team] }),
    'GET /api/assistants': () => ({ assistants: [] }),
    'GET /api/model-providers': () => ({ providers: models }),
    'GET /api/decision-provider': () => ({ provider: 'typesafe', configured: false, masked: null }),
    'GET /api/platform-release': () => ({
      release: 'ghcr.io/theshimpz/shimpz-local-release@sha256:' + 'd'.repeat(64),
      ordinal: 1, checked_at: '2026-09-23T00:00:00Z', outcome: 'current',
    }),
    'GET /api/assistant-catalog': () => ({ version: 1, locale: 'en', assistants: [] }),
    'GET /api/local-assistants': () => ({ assistants: [], trace_id: 'c'.repeat(32) }),
    'GET /api/teams/perf_team/assistants': () => ({ assistants: [] }),
    'GET /api/teams/perf_team/assistant-integrations': () => ({ integrations: [] }),
    'GET /api/teams/perf_team/assistant-stored-inputs': () => ({ stored_inputs: [] }),
    'GET /api/teams/perf_team/routines': () => ({ team_id: team.team_id, routines: [], runs: [], incidents: [] }),
    'GET /api/teams/perf_team/inference': () => ({
      team_id: team.team_id, provider: provider.id, model: provider.default_model, effort: 'low',
    }),
  };
  return answers[`${method} ${path}`]?.() ?? null;
}

function installSocket() {
  class FakeWebSocket {
    static OPEN = 1;
    constructor(_url, protocol) {
      this.protocol = protocol;
      this.readyState = 0;
      setTimeout(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }, 0);
    }
    send(payload) {
      if (JSON.parse(payload).type === 'sync') {
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'sync-empty' }) });
          window.benchReady = true;
        }, 0);
      }
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = FakeWebSocket;
  // Marks when the page issues the measured older-history request, and where the current first exchange sits when its
  // response reaches the page: the view the prepend must keep, including a loading status laid out but not yet painted.
  // That one read may force layout the prepend frame would otherwise do. Nothing is recorded until the probe arms it.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!window.benchArmed || window.benchRequestAt !== undefined
      || !url.pathname.endsWith('/chat/history') || !url.searchParams.has('before')) {
      return nativeFetch(input, init);
    }
    window.benchRequestAt = performance.now();
    return nativeFetch(input, init).then((response) => {
      window.benchViewY = window.benchAnchor.getBoundingClientRect().y;
      return response;
    });
  };
}

async function performanceMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const values = new Map(metrics.map((item) => [item.name, item.value]));
  return Object.fromEntries([
    'TaskDuration', 'TaskOtherDuration', 'ThreadTime', 'ScriptDuration',
    'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount',
    'JSHeapUsedSize',
  ]
    .map((name) => {
      const value = values.get(name);
      if (typeof value !== 'number') throw new Error(`Chromium omitted ${name}.`);
      return [name, name.endsWith('Duration') || name === 'ThreadTime' ? value * 1000 : value];
    }));
}

async function measure(browser, baseURL, existingPages) {
  const context = await browser.newContext({ baseURL, locale: 'en-US', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const unexpected = [];
    const errors = [];
    let newestRequests = 0;
    let olderRequests = 0;
    page.on('pageerror', (error) => errors.push(error.name));
    await page.addInitScript(installSocket);
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      let body;
      if (method === 'GET' && url.pathname === '/api/teams/perf_team/chat/history') {
        const before = url.searchParams.get('before');
        const index = before === null ? 0 : Number(before.slice(0, -1));
        if (before !== null && before !== cursor(index)) unexpected.push('invalid cursor');
        if (before === null) newestRequests += 1;
        else olderRequests += 1;
        body = historyPage(index, existingPages + (exhaust ? 1 : 2));
      } else {
        body = apiFixture(method, url.pathname);
      }
      if (!body) unexpected.push(`${method} ${url.pathname}`);
      await route.fulfill({ status: body ? 200 : 404, contentType: 'application/json',
        body: JSON.stringify(body ?? { detail: 'unknown' }) });
    });
    await page.goto('/chat/?team=perf_team');
    await page.waitForFunction(() => window.benchReady === true);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const viewport = page.locator('.turns');
    const exchanges = (expected) => page.waitForFunction((count) => (
      document.querySelectorAll('.exchange').length === count && !document.querySelector('.history-older-status')
    ), expected);
    await exchanges(32);
    await viewport.hover();
    // One wheel gesture over the transcript scrolls it to the top, where the sentinel requests the older page.
    const scrollToTop = async () => {
      const top = await viewport.evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, -(top + 1000));
    };
    const journeyStart = await performanceMetrics(cdp);
    const journeyStartWall = performance.now();
    for (let index = 1; index < existingPages; index += 1) {
      await scrollToTop();
      await exchanges((index + 1) * 32);
    }
    if (newestRequests < 1 || olderRequests !== existingPages - 1) {
      throw new Error('History setup made an unexpected request count.');
    }
    const oldFirstText = await page.locator('.exchange').first().textContent();
    await page.evaluate(() => {
      const root = document.querySelector('.turns');
      window.benchExisting = new Set(root.querySelectorAll('.exchange'));
      window.benchAdded = new Set();
      window.benchObserver = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && node.classList.contains('exchange')) window.benchAdded.add(node);
        }
        const created = [...window.benchAdded].filter((node) => !window.benchExisting.has(node)).length;
        if (created >= 32 && window.benchPrependFrame === undefined) {
          window.benchPrependFrame = requestAnimationFrame(() => { window.benchPrependedAt = performance.now(); });
        }
      });
      window.benchObserver.observe(root, { childList: true, subtree: true });
      window.benchLongTasks = [];
      new PerformanceObserver((list) => window.benchLongTasks.push(
        ...list.getEntries().map((entry) => entry.duration),
      )).observe({ entryTypes: ['longtask'] });
      window.benchAnchor = root.querySelector('.exchange');
      window.benchArmed = true;
    });
    const idleStart = await performanceMetrics(cdp);
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.benchLongTasks = [];
    });
    const idleEnd = await performanceMetrics(cdp);
    const idleCpuMs = idleEnd.TaskDuration - idleStart.TaskDuration;
    const beforeMetrics = await performanceMetrics(cdp);
    const windowStart = performance.now();
    await scrollToTop();
    await page.waitForFunction(() => Number.isFinite(window.benchPrependedAt));
    const result = await page.evaluate(async (oldFirstText) => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.benchObserver.disconnect();
      let shifted = document.querySelector('.exchange');
      for (let index = 0; index < 32; index += 1) shifted = shifted?.nextElementSibling;
      const created = [...window.benchAdded].filter((node) => !window.benchExisting.has(node)).length;
      return {
        wallMs: window.benchPrependedAt - window.benchRequestAt,
        created,
        moved: [...window.benchAdded].filter((node) => window.benchExisting.has(node)).length,
        maxLongTaskMs: Math.max(0, ...window.benchLongTasks),
        complete: created === 32 && shifted === window.benchAnchor && shifted.textContent === oldFirstText
          && Number.isFinite(window.benchViewY) && window.benchRequestAt < window.benchPrependedAt,
        scrollShiftPx: Math.round(((shifted?.getBoundingClientRect().y ?? 0) - window.benchViewY) * 10) / 10,
      };
    }, oldFirstText);
    const afterMetrics = await performanceMetrics(cdp);
    result.journeyTaskMs = afterMetrics.TaskDuration - journeyStart.TaskDuration;
    result.journeyThreadMs = afterMetrics.ThreadTime - journeyStart.ThreadTime;
    result.journeyScriptMs = afterMetrics.ScriptDuration - journeyStart.ScriptDuration;
    result.journeyOtherMs = afterMetrics.TaskOtherDuration - journeyStart.TaskOtherDuration;
    result.journeyHeapDeltaBytes = afterMetrics.JSHeapUsedSize - journeyStart.JSHeapUsedSize;
    result.journeyWallMs = performance.now() - journeyStartWall;
    result.cpuMs = afterMetrics.TaskDuration - beforeMetrics.TaskDuration;
    result.threadMs = afterMetrics.ThreadTime - beforeMetrics.ThreadTime;
    result.otherMs = afterMetrics.TaskOtherDuration - beforeMetrics.TaskOtherDuration;
    result.heapDeltaBytes = afterMetrics.JSHeapUsedSize - beforeMetrics.JSHeapUsedSize;
    result.scriptMs = afterMetrics.ScriptDuration - beforeMetrics.ScriptDuration;
    result.layoutMs = afterMetrics.LayoutDuration - beforeMetrics.LayoutDuration;
    result.styleMs = afterMetrics.RecalcStyleDuration - beforeMetrics.RecalcStyleDuration;
    result.layoutPasses = afterMetrics.LayoutCount - beforeMetrics.LayoutCount;
    result.stylePasses = afterMetrics.RecalcStyleCount - beforeMetrics.RecalcStyleCount;
    result.windowWallMs = performance.now() - windowStart;
    result.idleCpuMs = idleCpuMs;
    result.idleThreadMs = idleEnd.ThreadTime - idleStart.ThreadTime;
    result.idleOtherMs = idleEnd.TaskOtherDuration - idleStart.TaskOtherDuration;
    result.idleHeapDeltaBytes = idleEnd.JSHeapUsedSize - idleStart.JSHeapUsedSize;
    const shown = await page.locator('.exchange').count();
    if (!result.complete || shown !== (existingPages + 1) * 32 ||
        result.created !== 32 || Math.abs(result.scrollShiftPx) > 2 ||
        olderRequests !== existingPages || unexpected.length || errors.length) {
      throw new Error(`History prepend changed content, request count, or browser health: ${JSON.stringify({
        existingPages, complete: result.complete, created: result.created, shown,
        scrollShiftPx: result.scrollShiftPx, olderRequests, unexpected, errors,
      })}`);
    }
    const beforeCollection = await performanceMetrics(cdp);
    await cdp.send('HeapProfiler.collectGarbage');
    const afterCollection = await performanceMetrics(cdp);
    result.forcedCollectionTaskMs = afterCollection.TaskDuration - beforeCollection.TaskDuration;
    result.forcedCollectionThreadMs = afterCollection.ThreadTime - beforeCollection.ThreadTime;
    result.journeyWithCollectionTaskMs = afterCollection.TaskDuration - journeyStart.TaskDuration;
    result.journeyWithCollectionThreadMs = afterCollection.ThreadTime - journeyStart.ThreadTime;
    result.retainedHeapBytes = afterCollection.JSHeapUsedSize - journeyStart.JSHeapUsedSize;
    return result;
  } finally {
    await context.close();
  }
}

const server = await preview({ preview: { host: '127.0.0.1', port: 4173, strictPort: true } });
const browser = await chromium.launch();
try {
  const runs = new Map(pages.map((count) => [count, []]));
  for (let index = 0; index < samples; index += 1) {
    for (const existingPages of index % 2 === 0 ? pages : [...pages].reverse()) {
      runs.get(existingPages).push(await measure(browser, server.resolvedUrls.local[0], existingPages));
    }
  }
  for (const [existingPages, values] of runs) {
    const metric = (name, proportion) => percentile(values.map((value) => value[name]), proportion);
    console.log(JSON.stringify({ existingPages, insertedEntries: 64, samples, historyExhausted: exhaust,
      cpuP50Ms: metric('cpuMs', 0.5), cpuP95Ms: metric('cpuMs', 0.95),
      journeyTaskP50Ms: metric('journeyTaskMs', 0.5), journeyTaskP95Ms: metric('journeyTaskMs', 0.95),
      journeyWithCollectionTaskP50Ms: metric('journeyWithCollectionTaskMs', 0.5),
      journeyWithCollectionTaskP95Ms: metric('journeyWithCollectionTaskMs', 0.95),
      journeyWithCollectionThreadP50Ms: metric('journeyWithCollectionThreadMs', 0.5),
      forcedCollectionTaskP50Ms: metric('forcedCollectionTaskMs', 0.5),
      forcedCollectionThreadP50Ms: metric('forcedCollectionThreadMs', 0.5),
      journeyThreadP50Ms: metric('journeyThreadMs', 0.5),
      journeyScriptP50Ms: metric('journeyScriptMs', 0.5),
      journeyOtherP50Ms: metric('journeyOtherMs', 0.5),
      journeyWallP50Ms: metric('journeyWallMs', 0.5), journeyWallP95Ms: metric('journeyWallMs', 0.95),
      threadP50Ms: metric('threadMs', 0.5), otherP50Ms: metric('otherMs', 0.5),
      scriptP50Ms: metric('scriptMs', 0.5), layoutP50Ms: metric('layoutMs', 0.5),
      styleP50Ms: metric('styleMs', 0.5),
      layoutPassesP50: metric('layoutPasses', 0.5), stylePassesP50: metric('stylePasses', 0.5),
      wallP50Ms: metric('wallMs', 0.5), wallP95Ms: metric('wallMs', 0.95),
      windowWallP50Ms: metric('windowWallMs', 0.5), idleCpuP50Ms: metric('idleCpuMs', 0.5),
      idleThreadP50Ms: metric('idleThreadMs', 0.5),
      idleOtherP50Ms: metric('idleOtherMs', 0.5),
      maxLongTaskMs: Math.max(...values.map((value) => value.maxLongTaskMs)),
      maxScrollShiftPx: Math.max(...values.map((value) => Math.abs(value.scrollShiftPx))),
      created: values.map((value) => value.created), moved: values.map((value) => value.moved),
      cpuSamplesMs: values.map((value) => Math.round(value.cpuMs * 10) / 10),
      journeyTaskSamplesMs: values.map((value) => Math.round(value.journeyTaskMs * 10) / 10),
      journeyWithCollectionTaskSamplesMs: values.map((value) => Math.round(value.journeyWithCollectionTaskMs * 10) / 10),
      journeyWithCollectionThreadSamplesMs: values.map((value) => Math.round(value.journeyWithCollectionThreadMs * 10) / 10),
      forcedCollectionTaskSamplesMs: values.map((value) => Math.round(value.forcedCollectionTaskMs * 10) / 10),
      forcedCollectionThreadSamplesMs: values.map((value) => Math.round(value.forcedCollectionThreadMs * 10) / 10),
      retainedHeapSamplesBytes: values.map((value) => value.retainedHeapBytes),
      journeyThreadSamplesMs: values.map((value) => Math.round(value.journeyThreadMs * 10) / 10),
      journeyScriptSamplesMs: values.map((value) => Math.round(value.journeyScriptMs * 10) / 10),
      journeyOtherSamplesMs: values.map((value) => Math.round(value.journeyOtherMs * 10) / 10),
      journeyHeapDeltaSamplesBytes: values.map((value) => value.journeyHeapDeltaBytes),
      journeyWallSamplesMs: values.map((value) => Math.round(value.journeyWallMs * 10) / 10),
      threadSamplesMs: values.map((value) => Math.round(value.threadMs * 10) / 10),
      otherSamplesMs: values.map((value) => Math.round(value.otherMs * 10) / 10),
      heapDeltaSamplesBytes: values.map((value) => value.heapDeltaBytes),
      scriptSamplesMs: values.map((value) => Math.round(value.scriptMs * 10) / 10),
      layoutSamplesMs: values.map((value) => Math.round(value.layoutMs * 10) / 10),
      styleSamplesMs: values.map((value) => Math.round(value.styleMs * 10) / 10),
      layoutPassSamples: values.map((value) => value.layoutPasses),
      stylePassSamples: values.map((value) => value.stylePasses),
      wallSamplesMs: values.map((value) => Math.round(value.wallMs * 10) / 10),
      idleCpuSamplesMs: values.map((value) => Math.round(value.idleCpuMs * 10) / 10),
      idleThreadSamplesMs: values.map((value) => Math.round(value.idleThreadMs * 10) / 10),
      idleOtherSamplesMs: values.map((value) => Math.round(value.idleOtherMs * 10) / 10),
      idleHeapDeltaSamplesBytes: values.map((value) => value.idleHeapDeltaBytes) }));
  }
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
