// Measure each main Admin screen on the built UI: cold load timing, chat transcript scrolling, composer typing, and the
// API calls a screen load or a Team switch makes. The build is served by e2e/serveBuild.mjs the way Admin serves it
// (enforced CSP, no compression) on port 4173, and the shared e2e scenarios answer every API call and socket; Team,
// Brain, and provider timing are excluded. Build first, then run with Node.js 26 in the browser image
// ../playwright.Dockerfile builds. Every sample is a fresh browser context. Output is one JSON line per measurement.
// SHIMPZ_PERF_SAMPLES (default 5) sets the samples per measurement and SHIMPZ_PERF_PARTS (default
// loads,team-switch,typing,scroll) selects the parts. Nearest-rank p95 is the maximum below twenty samples.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { routeScenario } from '../e2e/scenarioRoutes.js';

if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('This benchmark requires Node.js 26.');
const PARTS = ['loads', 'team-switch', 'typing', 'scroll'];
const samples = Number(process.env.SHIMPZ_PERF_SAMPLES ?? '5');
const parts = (process.env.SHIMPZ_PERF_PARTS ?? PARTS.join(',')).split(',');
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 30) {
  throw new Error('Sample count must be between 1 and 30.');
}
if (parts.length < 1 || parts.some((part) => !PARTS.includes(part))) {
  throw new Error(`Parts must be a comma-separated subset of ${PARTS.join(',')}.`);
}
const origin = 'http://127.0.0.1:4173';
const team = { id: 'marketing', name: 'Marketing' };
// The long transcripts: each history page holds 32 exchanges (64 entries) of the same rich Markdown reply.
const HISTORY_PAGES = [1, 4];
const TYPED_TEXT = 'Please check every zone and tell me what changed since yesterday at noon.';
const SCROLL_STEPS = 60;
const SCROLL_STEP_PX = 240;

function percentile(values, proportion) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  return Math.round(ordered[Math.ceil(proportion * ordered.length) - 1] * 10) / 10;
}

// Runs in the page before any script: paint, LCP, and long-task entries, and input-to-next-frame for each typed key.
function observePage() {
  const observed = { fcp: null, lcp: null, longTasks: [], inputs: [] };
  window.__screenPerf = observed;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') observed.fcp = entry.startTime;
  }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) observed.lcp = entry.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      observed.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: 'longtask', buffered: true });
  document.addEventListener('input', (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    const at = event.timeStamp;
    requestAnimationFrame(() => observed.inputs.push(performance.now() - at));
  }, true);
}

const cursor = (index) => `${String(index).padStart(10, '0')}E`;
const entryId = (index) => index.toString(16).padStart(32, '0');
const createdAt = (index) => new Date(Date.UTC(2026, 8, 1) + index * 600_000).toISOString().replace('.000Z', 'Z');
const usage = {
  duration_ms: 6240, models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 11_900, output_tokens: 580 }],
};

function historyPage(index, totalPages) {
  const first = (totalPages - index - 1) * 32;
  const entries = [];
  for (let offset = 0; offset < 32; offset += 1) {
    const record = first + offset;
    entries.push({ id: `${entryId(record)}:user`, created_at: createdAt(record), kind: 'message', role: 'user',
      text: `Record ${record}: summarize the DNS zones, flag what changed since yesterday, and list next steps.` });
    entries.push({ id: `${entryId(record)}:reply`, created_at: createdAt(record), kind: 'message', role: 'assistant',
      author: team.name, usage, text: [
        `### Record ${record}`, '',
        `Here is the summary for **example-${record}.com**:`, '',
        '- **Status:** ready for review.', '- **Changed:** two A records and one CNAME.',
        '- **Next:** confirm the TTL with the owner, then publish.', '',
        '| Record | Type | TTL |', '| --- | --- | --- |', '| www | A | 300 |', '| api | CNAME | 3600 |', '',
        '```text', `example-${record}.com: 3 records reviewed`, '```', '',
        'Let me know if you want me to [open the zone](https://dash.cloudflare.com/) or schedule a daily check.',
      ].join('\n') });
  }
  return { entries, before: index + 1 < totalPages ? cursor(index + 1) : null };
}

// Registered after the scenario, so it answers the Team's chat history (but not a Routine's) with `pages` pages.
async function routeLongHistory(page, pages) {
  await page.route(`**/api/teams/${team.id}/chat/history**`, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('routine')) return route.fallback();
    const before = url.searchParams.get('before');
    return route.fulfill({ json: historyPage(before ? Number(before.slice(0, 10)) : 0, pages) });
  });
}

const composer = (page, name = team.name) => page.getByPlaceholder(`Message ${name}…`);
const recordHeading = (page, record) => page.getByRole('heading', { name: `Record ${record}`, exact: true });
const bootHidden = (page) => page.waitForFunction(() => !document.querySelector('[data-slot="boot-screen"]'));
const catalogRows = (page) => page.waitForFunction(() => (
  document.querySelectorAll('section.assistant-catalog a.assistant-row').length > 0
  && !document.querySelector('.assistant-catalog-loading')
));

const SCREENS = {
  'sign-in': { scenario: 'sign-in', url: '/', ready: (page) => page.getByLabel('Password', { exact: true }).waitFor() },
  'chat-empty': { scenario: 'ready', url: `/chat/?team=${team.id}`, ready: (page) => composer(page).waitFor() },
  'chat-history-64': {
    scenario: 'ready', url: `/chat/?team=${team.id}`, setup: (page) => routeLongHistory(page, 1),
    ready: async (page) => {
      await composer(page).waitFor();
      await recordHeading(page, 31).waitFor();
    },
  },
  'assistants-catalog': {
    scenario: 'catalog', url: `/assistants/?team=${team.id}`,
    ready: async (page) => {
      await bootHidden(page);
      await catalogRows(page);
    },
  },
  'assistant-page': {
    scenario: 'catalog', url: `/assistants/shimpz-cloudflare?team=${team.id}`,
    ready: async (page) => {
      await bootHidden(page);
      await page.getByRole('heading', { level: 1, name: 'Cloudflare' }).waitFor();
    },
  },
  'chat-routines': { scenario: 'routines', url: `/chat/?team=${team.id}`, ready: (page) => composer(page).waitFor() },
};

// API requests by `METHOD /path`, and those the scenario does not answer (it fails them closed with 503).
function apiLog(page) {
  const log = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    log.push({ call: `${response.request().method()} ${url.pathname}`, unanswered: response.status() === 503 });
  });
  return log;
}

function apiSummary(entries) {
  const counts = {};
  for (const { call } of entries) counts[call] = (counts[call] ?? 0) + 1;
  return {
    apiCalls: entries.length, apiCounts: counts,
    unanswered: [...new Set(entries.filter((entry) => entry.unanswered).map((entry) => entry.call))].sort(),
  };
}

async function chromiumMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

function metricDeltas(before, after) {
  const milliseconds = (name) => (after[name] - before[name]) * 1000;
  return {
    taskMs: milliseconds('TaskDuration'), scriptMs: milliseconds('ScriptDuration'),
    styleMs: milliseconds('RecalcStyleDuration'), layoutMs: milliseconds('LayoutDuration'),
    styleCount: after.RecalcStyleCount - before.RecalcStyleCount, layoutCount: after.LayoutCount - before.LayoutCount,
  };
}

// Lets late requests (Routine reads, icons) and their long tasks land before a reading.
async function settle(page, ms) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function withPage(browser, measure) {
  const context = await browser.newContext({
    baseURL: origin, locale: 'en-US', viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript(observePage);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const result = await measure(page, cdp);
    if (pageErrors.length) throw new Error(`The page raised: ${pageErrors.join('; ')}`);
    return result;
  } finally {
    await context.close();
  }
}

// Opens the chat on a transcript of `pages` history pages, scrolls up until every page is shown, and stays at the top.
async function openLongChat(page, pages) {
  await routeScenario(page, 'ready');
  await routeLongHistory(page, pages);
  await page.goto(`/chat/?team=${team.id}`);
  await composer(page).waitFor();
  const oldest = recordHeading(page, 0);
  for (let attempt = 0; attempt < pages * 4 && !await oldest.count(); attempt += 1) {
    await page.locator('.turns').evaluate((element) => { element.scrollTop = 0; });
    await settle(page, 300);
  }
  await oldest.waitFor({ state: 'attached', timeout: 1000 });
  await page.locator('.turns').evaluate((element) => { element.scrollTop = 0; });
  await settle(page, 300);
}

async function loadSample(browser, screen) {
  return withPage(browser, async (page, cdp) => {
    await routeScenario(page, screen.scenario);
    await screen.setup?.(page);
    const log = apiLog(page);
    await page.goto(screen.url);
    await screen.ready(page);
    const readyMs = await page.evaluate(() => performance.now());
    await settle(page, 1200);
    const observed = await page.evaluate(() => ({
      ...window.__screenPerf, domElements: document.getElementsByTagName('*').length,
      // The scripts the load fetched, as served: their bytes are what was transferred and what the browser parsed.
      scripts: performance.getEntriesByType('resource')
        .filter((entry) => new URL(entry.name).pathname.endsWith('.js')).map((entry) => entry.decodedBodySize),
    }));
    const tasks = observed.longTasks;
    return {
      readyMs, fcpMs: observed.fcp, lcpMs: observed.lcp,
      longTasks: tasks.length,
      longTaskMs: tasks.reduce((sum, task) => sum + task.duration, 0),
      maxLongTaskMs: Math.max(0, ...tasks.map((task) => task.duration)),
      // Blocking time of the long tasks after first contentful paint, up to the end of the settle window.
      tbtMs: tasks.filter((task) => task.start >= (observed.fcp ?? 0))
        .reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
      taskMs: (await chromiumMetrics(cdp)).TaskDuration * 1000,
      domElements: observed.domElements,
      scriptFiles: observed.scripts.length,
      scriptBytes: observed.scripts.reduce((sum, bytes) => sum + bytes, 0),
      ...apiSummary(log),
    };
  });
}

// Counts per call: the median over samples, so one late or missing request does not stand for the screen.
function medianCounts(rows) {
  const calls = [...new Set(rows.flatMap((row) => Object.keys(row.apiCounts)))].sort();
  return Object.fromEntries(calls.map((call) => [call, percentile(rows.map((row) => row.apiCounts[call] ?? 0), 0.5)]));
}

function summarize(rows, keys) {
  return Object.fromEntries(keys.flatMap((key) => [
    [`${key}P50`, percentile(rows.map((row) => row[key]), 0.5)],
    [`${key}P95`, percentile(rows.map((row) => row[key]), 0.95)],
  ]));
}

// Click a Team in the sidebar and wait for its composer; the API calls run until the switch settles.
async function teamSwitchSample(browser) {
  return withPage(browser, async (page, cdp) => {
    await routeScenario(page, 'ready');
    const log = apiLog(page);
    await page.goto(`/chat/?team=${team.id}`);
    await composer(page).waitFor();
    await settle(page, 1200);
    const sidebar = page.locator('.shell-sidebar');
    const switches = [];
    for (const name of ['Trinity', team.name, 'Cypher', team.name, 'Neo']) {
      const start = log.length;
      const before = await chromiumMetrics(cdp);
      const started = performance.now();
      await sidebar.getByRole('link', { name, exact: true }).click();
      await composer(page, name).waitFor();
      const switchMs = performance.now() - started;
      await settle(page, 600);
      switches.push({ to: name, switchMs, ...metricDeltas(before, await chromiumMetrics(cdp)),
        ...apiSummary(log.slice(start)) });
    }
    return switches;
  });
}

// Type into the composer with a key every 30 ms: style and layout work per key, and each key's input-to-next-frame
// latency (pooled over the samples).
async function typingSample(browser, pages) {
  return withPage(browser, async (page, cdp) => {
    if (pages) await openLongChat(page, pages);
    else {
      await routeScenario(page, 'ready');
      await page.goto(`/chat/?team=${team.id}`);
      await composer(page).waitFor();
      await settle(page, 600);
    }
    await composer(page).click();
    await page.evaluate(() => { window.__screenPerf.inputs = []; });
    const before = await chromiumMetrics(cdp);
    await page.keyboard.type(TYPED_TEXT, { delay: 30 });
    await settle(page, 300);
    const work = metricDeltas(before, await chromiumMetrics(cdp));
    const inputs = await page.evaluate(() => window.__screenPerf.inputs);
    if (inputs.length !== TYPED_TEXT.length) throw new Error('A typed key had no input frame.');
    const perKey = (value) => value / TYPED_TEXT.length;
    return {
      inputs, taskMsPerKey: perKey(work.taskMs), scriptMsPerKey: perKey(work.scriptMs),
      styleMsPerKey: perKey(work.styleMs), layoutMsPerKey: perKey(work.layoutMs),
      layoutsPerKey: perKey(work.layoutCount),
    };
  });
}

// Wheel down the transcript from its oldest entry; animation-frame intervals (pooled over the samples) are the frame
// time.
async function scrollSample(browser, pages) {
  return withPage(browser, async (page, cdp) => {
    await openLongChat(page, pages);
    const box = await page.locator('.turns').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.evaluate(() => {
      window.__frames = [];
      window.__scrolling = true;
      let last = performance.now();
      const tick = (now) => {
        window.__frames.push(now - last);
        last = now;
        if (window.__scrolling) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const before = await chromiumMetrics(cdp);
    const started = performance.now();
    for (let step = 0; step < SCROLL_STEPS; step += 1) {
      await page.mouse.wheel(0, SCROLL_STEP_PX);
      await page.waitForTimeout(16);
    }
    const wallMs = performance.now() - started;
    const work = metricDeltas(before, await chromiumMetrics(cdp));
    const frames = await page.evaluate(() => {
      window.__scrolling = false;
      return window.__frames.slice(1);
    });
    return { frames, wallMs, mainTaskMs: work.taskMs, layoutMs: work.layoutMs };
  });
}

async function repeat(measure) {
  const rows = [];
  for (let index = 0; index < samples; index += 1) rows.push(await measure());
  return rows;
}

const server = spawn(process.execPath, [new URL('../e2e/serveBuild.mjs', import.meta.url).pathname], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
let browser;
try {
  for (let attempt = 0; !await fetch(origin).then(() => true, () => false); attempt += 1) {
    if (attempt === 50) throw new Error('The build server did not start.');
    await delay(100);
  }
  browser = await chromium.launch();
  const print = (record) => console.log(JSON.stringify({ samples, ...record }));
  // One unrecorded load warms the server and the browser.
  await loadSample(browser, SCREENS['chat-empty']);
  if (parts.includes('loads')) {
    for (const [screen, definition] of Object.entries(SCREENS)) {
      const rows = await repeat(() => loadSample(browser, definition));
      print({ part: 'load', screen, ...summarize(rows, [
        'readyMs', 'fcpMs', 'lcpMs', 'longTasks', 'longTaskMs', 'maxLongTaskMs', 'tbtMs', 'taskMs', 'domElements',
        'scriptFiles', 'scriptBytes', 'apiCalls',
      ]), apiCounts: medianCounts(rows), unanswered: [...new Set(rows.flatMap((row) => row.unanswered))].sort() });
    }
  }
  if (parts.includes('team-switch')) {
    const rows = await repeat(() => teamSwitchSample(browser));
    const switches = rows.flat();
    print({ part: 'team-switch', switches: switches.length,
      ...summarize(switches, ['switchMs', 'taskMs', 'layoutCount', 'apiCalls']),
      apiCountsAway: medianCounts(rows.map((row) => row[0])),
      apiCountsBack: medianCounts(rows.map((row) => row[1])),
      unanswered: [...new Set(switches.flatMap((row) => row.unanswered))].sort() });
  }
  if (parts.includes('typing')) {
    for (const pages of [0, ...HISTORY_PAGES]) {
      const rows = await repeat(() => typingSample(browser, pages));
      const inputs = rows.flatMap((row) => row.inputs);
      print({ part: 'typing', historyEntries: pages * 64, keysPerSample: TYPED_TEXT.length,
        inputFrameP50Ms: percentile(inputs, 0.5), inputFrameP95Ms: percentile(inputs, 0.95),
        ...summarize(rows, ['taskMsPerKey', 'scriptMsPerKey', 'styleMsPerKey', 'layoutMsPerKey', 'layoutsPerKey']) });
    }
  }
  if (parts.includes('scroll')) {
    for (const pages of HISTORY_PAGES) {
      const rows = await repeat(() => scrollSample(browser, pages));
      const frames = rows.flatMap((row) => row.frames);
      print({ part: 'scroll', historyEntries: pages * 64, steps: SCROLL_STEPS, stepPx: SCROLL_STEP_PX,
        frames: frames.length, frameP50Ms: percentile(frames, 0.5), frameP95Ms: percentile(frames, 0.95),
        framesOver50Ms: frames.filter((frame) => frame > 50).length,
        ...summarize(rows, ['wallMs', 'mainTaskMs', 'layoutMs']) });
    }
  }
} finally {
  await browser?.close();
  server.kill();
}
