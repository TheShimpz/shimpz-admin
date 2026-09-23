// Synthetic WebSocket workload against the built Local chat; no Team or provider timing is included.
// Build first. Set SHIMPZ_PROGRESS_CASES, SHIMPZ_PERF_SAMPLES, and SHIMPZ_PROGRESS_GAP_MS.
// Gap 0 incurs Chromium's ~4 ms timer clamp. Each trial uses a fresh context and a warm preview server.
// Reduced motion isolates progress work from CSS animations. Any failed trial aborts the run.
// With five samples p95 is the maximum.
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import catalog from '../src/lib/modelCatalog.json' with { type: 'json' };

const team = { team_id: 'perf_team', team_name: 'Performance Team', status: 'running' };
const provider = catalog.providers.find((item) => item.id === catalog.default_provider);
const models = catalog.providers.map((item) => ({
  id: item.id, title: item.title, default_model: item.default_model,
  models: item.models, configured: item.id === provider.id, masked: null,
}));
const counts = (process.env.SHIMPZ_PROGRESS_CASES ?? '36').split(',').map(Number);
const samples = Number(process.env.SHIMPZ_PERF_SAMPLES ?? '5');
const gap = Number(process.env.SHIMPZ_PROGRESS_GAP_MS ?? '0');
if (counts.some((count) => ![36, 128, 948].includes(count))) {
  throw new Error('Cases must be 36, 128, or 948 progress events.');
}
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100) {
  throw new Error('Sample count must be between 1 and 100.');
}
if (!Number.isSafeInteger(gap) || gap < 0 || gap > 1000) {
  throw new Error('Event gap must be an integer between 0 and 1000 ms.');
}

function fixture(path) {
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
  if (path === '/api/teams/perf_team/chat/history') return { entries: [], before: null };
  if (path === '/api/teams/perf_team/assistant-integrations') return { integrations: [] };
  if (path === '/api/teams/perf_team/inference') return {
    team_id: team.team_id, provider: provider.id, model: provider.default_model,
  };
  return null;
}

function frames(count) {
  const result = [];
  const pair = (origin, phase, fields = {}) => {
    result.push({ type: 'progress', seq: result.length + 1, origin, phase, state: 'started', ...fields });
    result.push({ type: 'progress', seq: result.length + 1, origin, phase, state: 'finished', elapsed_ms: 2, ...fields });
  };
  const rounds = count === 948 ? 7 : 1;
  const actions = count === 36 ? 10 : count === 128 ? 56 : 64;
  pair('admin', 'admin-preparation');
  pair('team', 'team-context');
  pair('team', 'model');
  for (let round = 0; round < rounds; round += 1) {
    pair('team', 'action-preparation');
    for (let index = 1; index <= actions; index += 1) {
      pair('team', 'action', {
        assistant_id: 'shimpz-cloudflare', action: 'list-zones', index, total: actions,
      });
    }
    pair('team', 'model');
    pair('team', 'action-delivery');
  }
  pair('team', 'team-context');
  pair('admin', 'reply-validation');
  if (result.length !== count) throw new Error('Invalid progress fixture length.');
  return result;
}

function installSocket() {
  let socket;
  class FakeWebSocket {
    static OPEN = 1;
    constructor(_url, protocol) {
      socket = this;
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
  window.benchEventMarks = [];
  window.benchEmit = (event) => {
    if (event.type === 'progress') window.benchEventMarks.push(performance.now());
    socket.onmessage?.({ data: JSON.stringify(event) });
  };
  window.benchLongTasks = [];
  new PerformanceObserver((list) => window.benchLongTasks.push(
    ...list.getEntries().map((entry) => ({ duration: entry.duration, startTime: entry.startTime })),
  )).observe({ entryTypes: ['longtask'] });
}

async function taskDuration(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return (metrics.find((item) => item.name === 'TaskDuration')?.value ?? 0) * 1000;
}

function percentile(values, proportion) {
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(proportion * ordered.length) - 1] * 10) / 10;
}

async function measure(browser, baseURL, count, control) {
  const context = await browser.newContext({ baseURL, locale: 'en-US', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const badPaths = [];
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.name));
    await page.addInitScript(installSocket);
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = fixture(path);
      if (!body) badPaths.push(path);
      await route.fulfill({
        status: body ? 200 : 404, contentType: 'application/json',
        body: JSON.stringify(body ?? { detail: 'unknown' }),
      });
    });
    await page.goto('/chat/?team=perf_team');
    await page.waitForFunction(() => window.benchReady === true);
    await page.getByPlaceholder('Message Performance Team…').fill('Summarize the status');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('group', { name: 'I’m processing…' }).waitFor();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const before = await taskDuration(cdp);
    const input = frames(count);
    const marks = await page.evaluate(async ({ input, gap, control }) => {
      window.benchLongTasks = [];
      window.benchEventMarks = [];
      const start = performance.now();
      for (const item of input) {
        if (!control) window.benchEmit(item);
        await new Promise((resolve) => setTimeout(resolve, gap));
      }
      const last = performance.now();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return { wallMs: performance.now() - start, nextFrameMs: performance.now() - last,
        longTasks: window.benchLongTasks.map((task) => ({ ...task,
          eventIndex: window.benchEventMarks.findLastIndex((mark) => mark <= task.startTime) + 1,
        })) };
    }, { input, gap, control });
    const progressTaskMs = await taskDuration(cdp) - before;
    const liveRows = await page.locator('.thinking .ledger li').count();
    if (liveRows !== (control ? 0 : Math.min(count / 2, 32))) {
      throw new Error(`Expected live ledger rows for ${count} events; saw ${liveRows}.`);
    }
    if (!control) {
      const lastLive = await page.locator('.thinking .ledger li').last().textContent();
      if (!lastLive.includes('Admin checks the final response from')
        || !lastLive.includes('before displaying it')
        || !lastLive.includes('2 ms')) {
        throw new Error('Live ledger lost the final progress phase.');
      }
    }
    const beforeTerminal = await taskDuration(cdp);
    await page.evaluate((value) => window.benchEmit({
      type: 'done', team_id: value.team_id, team_name: value.team_name, reply: 'Benchmark reply.',
    }), team);
    await page.getByText('Benchmark reply.', { exact: true }).waitFor();
    await page.getByRole('group', { name: 'I’m processing…' }).waitFor({ state: 'detached' });
    if (!await page.getByPlaceholder('Message Performance Team…').isEnabled()) {
      throw new Error('Composer remained disabled after terminal reply.');
    }
    const receipt = page.getByText(`${count / 2} execution stages completed`, { exact: true });
    if (!control) await receipt.waitFor();
    const terminalTaskMs = await taskDuration(cdp) - beforeTerminal;
    let receiptTaskMs = 0;
    let receiptLongTaskMs = 0;
    if (!control) {
      await page.evaluate(() => { window.benchLongTasks = []; });
      const beforeReceipt = await taskDuration(cdp);
      await receipt.click();
      await page.waitForFunction((expected) => document.querySelectorAll('.receipt ol li').length === expected,
        count / 2);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      receiptTaskMs = await taskDuration(cdp) - beforeReceipt;
      receiptLongTaskMs = await page.evaluate(() => Math.max(
        0, ...window.benchLongTasks.map((task) => task.duration),
      ));
    }
    const longestTask = marks.longTasks.reduce((best, task) => (
      task.duration > best.duration ? task : best
    ), { duration: 0, eventIndex: 0 });
    const result = { count, control, gap, progressTaskMs, terminalTaskMs,
      receiptTaskMs, receiptLongTaskMs,
      wallMs: marks.wallMs, nextFrameMs: marks.nextFrameMs,
      maxLongTaskMs: longestTask.duration, maxLongTaskEvent: longestTask.eventIndex,
      badPaths, pageErrors };
    if (badPaths.length || pageErrors.length) throw new Error(JSON.stringify(result));
    return result;
  } finally {
    await context.close();
  }
}

const server = await preview({ preview: { host: '127.0.0.1', port: 4173, strictPort: true } });
const browser = await chromium.launch();
try {
  for (const count of counts) {
    const results = { control: [], progress: [] };
    for (let index = 0; index < samples; index += 1) {
      for (const control of index % 2 === 0 ? [true, false] : [false, true]) {
        results[control ? 'control' : 'progress'].push(
          await measure(browser, server.resolvedUrls.local[0], count, control),
        );
      }
    }
    for (const [arm, values] of Object.entries(results)) {
      const metric = (key, p) => percentile(values.map((value) => value[key]), p);
      const longestTask = values.reduce((best, value) => (
        value.maxLongTaskMs > best.maxLongTaskMs ? value : best
      ), { maxLongTaskMs: 0, maxLongTaskEvent: 0 });
      const controlCpu = percentile(results.control.map((value) => value.progressTaskMs), 0.5);
      console.log(JSON.stringify({ count, arm, gap, samples,
        progressCpuP50Ms: metric('progressTaskMs', 0.5),
        progressCpuP95Ms: metric('progressTaskMs', 0.95),
        marginalCpuPerEventMs: arm === 'progress'
          ? Math.round((metric('progressTaskMs', 0.5) - controlCpu) / count * 1000) / 1000 : null,
        progressWallP50Ms: metric('wallMs', 0.5),
        progressWallP95Ms: metric('wallMs', 0.95),
        terminalCpuP50Ms: metric('terminalTaskMs', 0.5),
        terminalCpuP95Ms: metric('terminalTaskMs', 0.95),
        receiptCpuP50Ms: arm === 'progress' ? metric('receiptTaskMs', 0.5) : null,
        receiptCpuP95Ms: arm === 'progress' ? metric('receiptTaskMs', 0.95) : null,
        maxLongTaskMs: longestTask.maxLongTaskMs,
        maxLongTaskEvent: longestTask.maxLongTaskEvent,
        maxReceiptLongTaskMs: arm === 'progress'
          ? Math.max(...values.map((value) => value.receiptLongTaskMs)) : null,
        maxNextFrameMs: Math.max(...values.map((value) => value.nextFrameMs)),
        receiptSteps: arm === 'progress' ? count / 2 : null }));
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
