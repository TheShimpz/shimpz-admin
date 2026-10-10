// Measure the built Admin's first load: the JavaScript a cold browser context fetches before the chat composer is ready,
// and the main-thread work that load costs. The shared `ready` scenario (e2e/scenarios.js) answers every API request,
// so Team, Brain, and provider timing are excluded. The build is served as Admin's backend serves it, uncompressed and
// under its policy (e2e/serveBuild.mjs on port 4173); the gzip size is what the same files compress to at level 9, for
// comparison only. Each sample is a new browser context in one interface language (SHIMPZ_PERF_LOCALES, default
// en,pt). Build first, then run with Node.js 26 in the image ../playwright.Dockerfile builds.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { chromium } from '@playwright/test';

import { routeScenario } from '../e2e/scenarioRoutes.js';
import { messages } from '../src/lib/messages.js';

const samples = Number(process.env.SHIMPZ_PERF_SAMPLES ?? '15');
const locales = (process.env.SHIMPZ_PERF_LOCALES ?? 'en,pt').split(',');
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 50) throw new Error('Sample count must be 1 to 50.');
if (locales.some((code) => !(code in messages))) throw new Error('Unknown interface language.');

const percentile = (values, proportion) => {
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(proportion * ordered.length) - 1] * 10) / 10;
};
const gzipped = new Map();
function gzipBytes(pathname) {
  if (!gzipped.has(pathname)) gzipped.set(pathname, gzipSync(readFileSync(new URL(`../build${pathname}`, import.meta.url)), { level: 9 }).length);
  return gzipped.get(pathname);
}

async function sample(browser, origin, code) {
  const context = await browser.newContext({ baseURL: origin, locale: code, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await routeScenario(page, 'ready');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto('/chat/?team=marketing');
  await page.getByRole('textbox', { name: messages[code].chatPage.send, exact: true }).waitFor();
  const ready = await page.evaluate(() => performance.now());
  const scripts = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => new URL(entry.name).pathname.endsWith('.js'))
    .map((entry) => ({ path: new URL(entry.name).pathname, bytes: entry.encodedBodySize })));
  const { metrics } = await cdp.send('Performance.getMetrics');
  const metric = (name) => (metrics.find((item) => item.name === name)?.value ?? 0) * 1000;
  await context.close();
  if (errors.length) throw new Error(`The page raised: ${errors.join('; ')}`);
  return {
    readyMs: ready,
    scriptFiles: scripts.length,
    scriptBytes: scripts.reduce((total, script) => total + script.bytes, 0),
    scriptGzipBytes: scripts.reduce((total, script) => total + gzipBytes(script.path), 0),
    taskMs: metric('TaskDuration'),
    scriptMs: metric('ScriptDuration'),
    compileMs: metric('V8CompileDuration'),
  };
}

const server = spawn(process.execPath, [new URL('../e2e/serveBuild.mjs', import.meta.url).pathname], { stdio: 'inherit' });
const origin = 'http://127.0.0.1:4173';
for (let attempt = 0; !(await fetch(origin).then(() => true, () => false)); attempt += 1) {
  if (attempt === 50) throw new Error('The build server did not start.');
  await delay(100);
}
const browser = await chromium.launch();
try {
  for (const code of locales) await sample(browser, origin, code);
  const results = Object.fromEntries(locales.map((code) => [code, []]));
  // The languages alternate sample by sample, so drift on the host affects each the same way.
  for (let index = 0; index < samples; index += 1) {
    for (const code of locales) results[code].push(await sample(browser, origin, code));
  }
  for (const code of locales) {
    const values = results[code];
    const summary = { locale: code, samples };
    for (const name of ['scriptFiles', 'scriptBytes', 'scriptGzipBytes']) summary[name] = percentile(values.map((value) => value[name]), 0.5);
    for (const name of ['readyMs', 'taskMs', 'scriptMs', 'compileMs']) {
      summary[`${name.replace(/Ms$/, '')}P50Ms`] = percentile(values.map((value) => value[name]), 0.5);
      summary[`${name.replace(/Ms$/, '')}P95Ms`] = percentile(values.map((value) => value[name]), 0.95);
    }
    console.log(JSON.stringify(summary));
  }
} finally {
  await browser.close();
  server.kill();
}
