// Measure a real built chat page while older, bounded history is prepended.
// API and WebSocket fixtures are synthetic; Team, Brain, and provider are excluded.
// Build first, then run with Node.js 24 and the pinned Playwright browser image.
// Chromium TaskDuration is page-wide; nearest-rank p95 depends on the sample count.
// Script, layout, and style counters help attribution but do not account for all task time or paint.
// ThreadTime is sampled separately and can differ from TaskDuration in either direction.
// TaskOtherDuration includes other work; heap deltas alone cannot identify garbage collection.
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
if (pages.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 16)) {
  throw new Error('Existing page counts must be between 1 and 16.');
}
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 30) {
  throw new Error('Sample count must be between 1 and 30.');
}

const cursor = (index) => `${String(index).padStart(10, '0')}E`;
const id = (index) => index.toString(16).padStart(32, '0');
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
    entries.push({ id: `${id(number)}:user`, kind: 'message', role: 'user',
      text: `${marker}: Summarize the status and next steps.` });
    entries.push({ id: `${id(number)}:reply`, kind: 'message', role: 'assistant', author: team.team_name,
      text: `### ${marker}\n\n- **Status:** ready for review.\n- **Next:** check the attached result.\n\n\`\`\`text\n${marker}: complete\n\`\`\`` });
  }
  return { entries, before: index + 1 < totalPages ? cursor(index + 1) : null };
}

function apiFixture(path) {
  if (path === '/api/session') return {
    profile: 'local', authenticated: true, initialized: true,
    authentication_state: 'configured', authentication_method: 'webauthn',
    origin_admitted: true, passkey_enrollment_available: false,
    passkey_registered: false, oauth_completion_mode: 'automatic',
    features: { teamCredentials: true },
  };
  if (path === '/api/teams') return { teams: [team] };
  if (path === '/api/assistants') return { assistants: [] };
  if (path === '/api/notifications') return { notifications: [], unread_count: 0 };
  if (path === '/api/notifications/sync') return {
    notifications: [], unread_count: 0,
    sync: { status: 'ok', updated_assistants: 0, notifications_added: 0, failed_updates: 0 },
  };
  if (path === '/api/model-providers') return { providers: models };
  if (path === '/api/platform-release') return {
    release: 'ghcr.io/theshimpz/shimpz-local-release@sha256:' + 'd'.repeat(64),
    ordinal: 1, checked_at: '2026-09-23T00:00:00Z', outcome: 'current',
  };
  if (path === '/api/assistant-catalog') return { version: 1, assistants: [] };
  if (path === '/api/local-assistants') return { assistants: [], trace_id: 'c'.repeat(32) };
  if (path === '/api/teams/perf_team/assistants') return { assistants: [] };
  if (path === '/api/teams/perf_team/assistant-integrations') return { integrations: [] };
  if (path === '/api/teams/perf_team/inference') return {
    team_id: team.team_id, provider: provider.id, model: provider.default_model,
  };
  return null;
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
    let historyRequests = 0;
    page.on('pageerror', (error) => errors.push(error.name));
    await page.addInitScript(installSocket);
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      let body;
      if (url.pathname === '/api/teams/perf_team/chat/history') {
        const before = url.searchParams.get('before');
        const index = before === null ? 0 : Number(before.slice(0, -1));
        if (before !== null && before !== cursor(index)) unexpected.push('invalid cursor');
        historyRequests += 1;
        body = historyPage(index, existingPages + 2);
      } else {
        body = apiFixture(url.pathname);
      }
      if (!body) unexpected.push(url.pathname);
      await route.fulfill({ status: body ? 200 : 404, contentType: 'application/json',
        body: JSON.stringify(body ?? { detail: 'unknown' }) });
    });
    await page.goto('/chat/?team=perf_team');
    await page.waitForFunction(() => window.benchReady === true);
    const older = page.getByRole('button', { name: 'Load older messages' });
    for (let index = 1; index < existingPages; index += 1) {
      await older.click();
      await page.locator('.exchange').nth(index * 32 - 1).waitFor();
    }
    if (historyRequests !== existingPages) throw new Error('History setup made an unexpected request count.');
    await older.scrollIntoViewIfNeeded();
    const oldFirst = page.locator('.exchange').first();
    const oldFirstText = await oldFirst.textContent();
    const oldFirstY = (await oldFirst.boundingBox()).y;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.evaluate(() => {
      const root = document.querySelector('.turns');
      window.benchExisting = new Set(root.querySelectorAll('.exchange'));
      window.benchAdded = new Set();
      window.benchObserver = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && node.classList.contains('exchange')) window.benchAdded.add(node);
        }
      });
      window.benchObserver.observe(root, { childList: true, subtree: true });
      window.benchLongTasks = [];
      new PerformanceObserver((list) => window.benchLongTasks.push(
        ...list.getEntries().map((entry) => entry.duration),
      )).observe({ entryTypes: ['longtask'] });
      root.querySelector('.history-older button').addEventListener('click', () => {
        window.benchStart = performance.now();
      }, { capture: true, once: true });
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
    await older.click();
    await page.waitForFunction(() => window.benchAdded.size >= 32);
    const result = await page.evaluate(async ({ oldFirstText, oldFirstY }) => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.benchObserver.disconnect();
      let shifted = document.querySelector('.exchange');
      for (let index = 0; index < 32; index += 1) shifted = shifted?.nextElementSibling;
      const created = [...window.benchAdded].filter((node) => !window.benchExisting.has(node)).length;
      return {
        wallMs: performance.now() - window.benchStart,
        created,
        moved: [...window.benchAdded].filter((node) => window.benchExisting.has(node)).length,
        maxLongTaskMs: Math.max(0, ...window.benchLongTasks),
        complete: created === 32 && shifted?.textContent === oldFirstText,
        scrollShiftPx: Math.round(((shifted?.getBoundingClientRect().y ?? 0) - oldFirstY) * 10) / 10,
      };
    }, { oldFirstText, oldFirstY });
    const afterMetrics = await performanceMetrics(cdp);
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
    if (!result.complete ||
        await page.locator('.exchange').count() !== (existingPages + 1) * 32 ||
        result.created !== 32 || Math.abs(result.scrollShiftPx) > 2 ||
        historyRequests !== existingPages + 1 || unexpected.length || errors.length) {
      throw new Error('History prepend changed content, request count, or browser health.');
    }
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
    console.log(JSON.stringify({ existingPages, insertedEntries: 64, samples,
      cpuP50Ms: metric('cpuMs', 0.5), cpuP95Ms: metric('cpuMs', 0.95),
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
