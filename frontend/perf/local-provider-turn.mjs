// Measure real Local chat turns in the built Admin app without retaining content.
// Read the disposable origin, session cookie, and sample count from stdin.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';

const WARMUPS = 1;
const MESSAGE = 'Responda brevemente: olá.';
const MAX_SAMPLES = 20;
let stage = 'input';
let browser;

function percentile(values, proportion) {
  const ordered = [...values].sort((left, right) => left - right);
  if (proportion === 0.5 && ordered.length % 2 === 0) {
    const midpoint = (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
    return Math.round(midpoint * 100) / 100;
  }
  return Math.round(ordered[Math.ceil(ordered.length * proportion) - 1] * 100) / 100;
}

function summary(samples, key) {
  const values = samples.map((sample) => sample[key]);
  return { n: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) };
}

function input() {
  const parsed = JSON.parse(readFileSync(0, 'utf8'));
  const origin = parsed.origin;
  const cookie = parsed.session_cookie;
  const samples = parsed.samples;
  if (Object.keys(parsed).sort().join(',') !== 'origin,samples,session_cookie'
      || typeof origin !== 'string' || !/^http:\/\/127\.0\.0\.1:4600$/.test(origin)
      || typeof cookie !== 'string' || !/^shimpz_admin=[A-Za-z0-9:+._~-]{16,4096}$/.test(cookie)
      || !Number.isSafeInteger(samples) || samples < 1 || samples > MAX_SAMPLES
      || process.versions.node.split('.')[0] !== '24') {
    throw new Error('Invalid disposable browser input');
  }
  return { origin, session: cookie.slice('shimpz_admin='.length), samples };
}

function observeSocket(page, state) {
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/api/teams/demo_team/chat/ws') return;
    state.sockets += 1;
    socket.on('framesent', ({ payload }) => {
      let frame;
      try { frame = JSON.parse(payload.toString()); } catch { state.frameErrors += 1; return; }
      if (frame.type === 'chat' && state.current) {
        state.current.sendAt = performance.now();
        state.current.sendEpochMs = performance.timeOrigin + state.current.sendAt;
      }
    });
    socket.on('framereceived', ({ payload }) => {
      let frame;
      try { frame = JSON.parse(payload.toString()); } catch { state.frameErrors += 1; return; }
      const sample = state.current;
      if (!sample?.sendAt) return;
      if (frame.type === 'progress') {
        if (sample.firstProgressAt === null) {
          sample.firstProgressAt = performance.now();
          sample.firstProgressEpochMs = performance.timeOrigin + sample.firstProgressAt;
        }
        sample.phases.push({ seq: frame.seq, phase: frame.phase, state: frame.state });
      } else if (frame.type === 'done') {
        sample.terminalAt = performance.now();
        sample.terminals += 1;
        sample.replyPresent = typeof frame.reply === 'string' && frame.reply.trim().length > 0;
      } else if (frame.type !== 'sync-empty') {
        sample.unexpectedFrames += 1;
      }
    });
    socket.on('socketerror', () => { state.socketErrors += 1; });
  });
}

function checkSample(sample) {
  if (!Number.isFinite(sample.sendAt) || !Number.isFinite(sample.firstProgressAt)
      || !Number.isFinite(sample.sendEpochMs) || !Number.isFinite(sample.firstProgressEpochMs)
      || !Number.isFinite(sample.terminalAt) || !Number.isFinite(sample.pendingAt)
      || !Number.isFinite(sample.renderedAt) || sample.terminals !== 1 || !sample.replyPresent
      || sample.unexpectedFrames !== 0 || sample.phases.length === 0
      || sample.phases.some((item, index) => item.seq !== index + 1
        || typeof item.phase !== 'string' || typeof item.state !== 'string')
      || !(sample.sendAt <= sample.firstProgressAt && sample.firstProgressAt <= sample.terminalAt
        && sample.terminalAt <= sample.renderedAt)) {
    throw new Error('Chat sample failed its ordered frame and render contract');
  }
  return {
    send_epoch_ms: sample.sendEpochMs,
    first_progress_epoch_ms: sample.firstProgressEpochMs,
    pending_ms: sample.pendingAt - sample.sendAt,
    first_progress_ms: sample.firstProgressAt - sample.sendAt,
    terminal_ms: sample.terminalAt - sample.sendAt,
    rendered_reply_upper_ms: sample.renderedAt - sample.sendAt,
    progress_events: sample.phases.length,
  };
}

async function measure(page, state, composer, send, index) {
  stage = 'turn';
  const before = await page.locator('.conversation .shimpz-message--assistant').count();
  state.current = {
    sendAt: null, pendingAt: null, firstProgressAt: null, terminalAt: null,
    sendEpochMs: null, firstProgressEpochMs: null,
    renderedAt: null, terminals: 0, unexpectedFrames: 0, replyPresent: false, phases: [],
  };
  await composer.fill(MESSAGE);
  await send.click();
  await page.getByRole('group', { name: 'I’m processing…' }).waitFor({ timeout: 10000 });
  state.current.pendingAt = performance.now();
  await page.waitForFunction((expected) => (
    document.querySelectorAll('.conversation .shimpz-message--assistant').length === expected + 1
  ), before, { timeout: 60000 });
  state.current.renderedAt = performance.now();
  const reply = page.locator('.conversation .shimpz-message--assistant').last();
  if (!(await reply.textContent())?.trim() || !(await composer.isEnabled())) {
    throw new Error('Rendered reply or composer state is invalid');
  }
  const raw = state.current;
  const sample = checkSample(raw);
  state.current = null;
  return { index, sample, phases: raw.phases };
}

async function run() {
  const { origin, session, samples } = input();
  stage = 'browser-launch';
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ baseURL: origin, locale: 'en-US', reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'shimpz_admin', value: session, url: origin,
    httpOnly: true, secure: false, sameSite: 'Strict' }]);
  const page = await context.newPage();
  const state = { current: null, sockets: 0, frameErrors: 0, socketErrors: 0, pageErrors: 0, apiErrors: [] };
  page.on('pageerror', () => { state.pageErrors += 1; });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 400) {
      state.apiErrors.push({ path: url.pathname, status: response.status() });
    }
  });
  observeSocket(page, state);
  stage = 'navigation-goto';
  await page.goto('/chat/?team=demo_team');
  const composer = page.getByPlaceholder('Message Demo Team…');
  const send = page.getByRole('button', { name: 'Send' });
  stage = 'navigation-composer';
  await composer.waitFor({ timeout: 30000 });
  stage = 'navigation-send';
  await send.waitFor({ timeout: 30000 });
  stage = 'navigation-ready';
  await page.waitForFunction(() => {
    const field = document.querySelector('form.composer textarea');
    return field instanceof HTMLTextAreaElement && !field.disabled;
  }, null, { timeout: 30000 });

  const turns = [];
  for (let index = 0; index < WARMUPS + samples; index += 1) {
    turns.push(await measure(page, state, composer, send, index));
  }
  if (state.sockets !== 1 || state.frameErrors || state.socketErrors || state.pageErrors
      || state.apiErrors.some((error) => error.path !== '/api/platform-release' || error.status !== 503)) {
    throw new Error('Browser transport or page failed');
  }
  const measured = turns.slice(WARMUPS);
  const values = measured.map((turn) => turn.sample);
  stage = 'complete';
  console.log(JSON.stringify({ status: 'complete', warmups: WARMUPS, samples, turn_errors: 0,
    sockets: state.sockets, api_errors: state.apiErrors, phase_sequence: turns[WARMUPS].phases,
    pending: summary(values, 'pending_ms'), first_progress: summary(values, 'first_progress_ms'),
    terminal: summary(values, 'terminal_ms'), rendered_reply_upper: summary(values, 'rendered_reply_upper_ms'),
    ordered_samples_ms: values }));
}

try {
  await run();
} catch (error) {
  console.log(JSON.stringify({ status: 'error', stage, error_type: error?.name ?? 'Error' }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
