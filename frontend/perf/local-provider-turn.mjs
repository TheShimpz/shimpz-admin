// Measure real Local chat turns in the built Admin app without retaining content.
// Read the disposable origin, session cookie, and sample count from stdin.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';

const WARMUPS = 1;
const MESSAGE = 'Responda brevemente: olá.';
const UNINSTALL_MESSAGE = 'Desinstala o Cloudflare';
const UNINSTALL_ASSISTANT = 'shimpz-cloudflare';
const UNINSTALL_NAME = 'Shimpz Cloudflare';
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
  const mode = parsed.mode;
  if (Object.keys(parsed).sort().join(',') !== 'mode,origin,samples,session_cookie'
      || typeof origin !== 'string' || !/^http:\/\/127\.0\.0\.1:4600$/.test(origin)
      || typeof cookie !== 'string' || !/^shimpz_admin=[A-Za-z0-9:+._~-]{16,4096}$/.test(cookie)
      || !Number.isSafeInteger(samples) || samples < 1 || samples > MAX_SAMPLES
      || !['ordinary', 'uninstall-proposal'].includes(mode)
      || process.versions.node.split('.')[0] !== '24') {
    throw new Error('Invalid disposable browser input');
  }
  return { origin, session: cookie.slice('shimpz_admin='.length), samples, mode };
}

function observeSocket(page, state) {
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/api/teams/demo_team/chat/ws') return;
    state.sockets += 1;
    socket.on('framesent', ({ payload }) => {
      let frame;
      try { frame = JSON.parse(payload.toString()); } catch { state.frameErrors += 1; return; }
      if (frame.type === 'chat' && state.current) {
        const sample = state.current;
        if (sample.mode === 'uninstall-proposal') {
          if (frame.message === UNINSTALL_MESSAGE && sample.sendAt === null) {
            sample.sendAt = performance.now();
            sample.sendEpochMs = performance.timeOrigin + sample.sendAt;
          } else if (frame.message === 'no' && sample.proposedAt !== null && sample.cancelSendAt === null) {
            sample.cancelSendAt = performance.now();
          } else {
            sample.unexpectedFrames += 1;
          }
        } else {
          sample.sendAt = performance.now();
          sample.sendEpochMs = performance.timeOrigin + sample.sendAt;
        }
      }
    });
    socket.on('framereceived', ({ payload }) => {
      let frame;
      try { frame = JSON.parse(payload.toString()); } catch { state.frameErrors += 1; return; }
      const sample = state.current;
      if (!sample?.sendAt) return;
      if (sample.mode === 'uninstall-proposal') {
        observeUninstallFrame(sample, frame);
        return;
      }
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

function observeUninstallFrame(sample, frame) {
  if (frame.type === 'assistant-guidance') {
    sample.guidance = true;
  } else if (frame.type === 'assistant-uninstall' && frame.state === 'expired') {
    sample.expired = true;
  } else if (frame.type === 'assistant-uninstall' && frame.state === 'proposed') {
    if (sample.proposedAt !== null || frame.team_id !== 'demo_team'
        || !/^[0-9a-f]{32}$/.test(frame.proposal_id)
        || frame.assistant?.id !== UNINSTALL_ASSISTANT
        || frame.assistant?.name !== UNINSTALL_NAME
        || typeof frame.assistant?.version !== 'string'
        || typeof frame.reply !== 'string'
        || !Number.isSafeInteger(frame.expires_in) || frame.expires_in < 1 || frame.expires_in > 120) {
      sample.unexpectedFrames += 1;
      return;
    }
    sample.proposedAt = performance.now();
    sample.proposedEpochMs = performance.timeOrigin + sample.proposedAt;
    sample.proposalId = frame.proposal_id;
    sample.proposals += 1;
  } else if (frame.type === 'assistant-uninstall' && frame.state === 'cancelled') {
    if (sample.cancelSendAt === null || frame.proposal_id !== sample.proposalId
        || frame.assistant_id !== UNINSTALL_ASSISTANT || sample.cancelledAt !== null) {
      sample.unexpectedFrames += 1;
      return;
    }
    sample.cancelledAt = performance.now();
    sample.cancellations += 1;
  } else if (frame.type !== 'sync-empty') {
    sample.unexpectedFrames += 1;
  }
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

function checkUninstallSample(sample) {
  if (!Number.isFinite(sample.sendAt) || !Number.isFinite(sample.sendEpochMs)
      || !Number.isFinite(sample.proposedAt) || !Number.isFinite(sample.proposedEpochMs)
      || !Number.isFinite(sample.renderedAt) || !Number.isFinite(sample.cancelSendAt)
      || !Number.isFinite(sample.cancelledAt) || !Number.isFinite(sample.cancelRenderedAt)
      || sample.proposals !== 1 || sample.cancellations !== 1 || sample.unexpectedFrames !== 0
      || sample.guidance || sample.expired
      || !(sample.sendAt <= sample.proposedAt && sample.proposedAt <= sample.renderedAt
        && sample.renderedAt <= sample.cancelSendAt && sample.cancelSendAt <= sample.cancelledAt
        && sample.cancelledAt <= sample.cancelRenderedAt)) {
    throw new Error('Uninstall proposal or cancellation failed its ordered frame and render contract');
  }
  return {
    send_epoch_ms: sample.sendEpochMs,
    proposal_epoch_ms: sample.proposedEpochMs,
    proposal_ms: sample.proposedAt - sample.sendAt,
    rendered_proposal_upper_ms: sample.renderedAt - sample.sendAt,
    cancel_round_trip_ms: sample.cancelledAt - sample.cancelSendAt,
    cancelled_dom_upper_ms: sample.cancelRenderedAt - sample.cancelSendAt,
  };
}

async function measureUninstall(page, state, composer, send, index) {
  stage = 'proposal';
  state.current = {
    mode: 'uninstall-proposal', sendAt: null, sendEpochMs: null,
    proposedAt: null, proposedEpochMs: null, proposalId: null,
    renderedAt: null, cancelSendAt: null, cancelledAt: null, cancelRenderedAt: null,
    proposals: 0, cancellations: 0, unexpectedFrames: 0, guidance: false, expired: false,
  };
  const sample = state.current;
  await composer.fill(UNINSTALL_MESSAGE);
  await send.click();
  const cancel = page.getByRole('button', { name: `Cancel uninstalling ${UNINSTALL_NAME}` });
  try {
    await cancel.waitFor({ state: 'visible', timeout: 60000 });
  } catch (error) {
    if (sample.guidance) stage = 'proposal-guidance';
    else if (sample.expired) stage = 'proposal-expired';
    throw error;
  }
  sample.renderedAt = performance.now();
  const card = page.locator(`#assistant-lifecycle-${sample.proposalId}`);
  const uninstall = page.getByRole('button', { name: `Uninstall ${UNINSTALL_NAME}` });
  if (await card.count() !== 1 || await card.getByText(UNINSTALL_NAME, { exact: true }).count() !== 1
      || await uninstall.count() !== 1 || !(await cancel.isEnabled())) {
    throw new Error('Rendered uninstall proposal did not match the installed Assistant');
  }
  stage = 'cancel';
  await cancel.click();
  await cancel.waitFor({ state: 'detached', timeout: 10000 });
  sample.cancelRenderedAt = performance.now();
  if (await card.count() !== 1 || await uninstall.count() !== 0) {
    throw new Error('Cancelled proposal remained actionable');
  }
  const measured = checkUninstallSample(sample);
  state.current = null;
  return { index, sample: measured };
}

async function run() {
  const { origin, session, samples, mode } = input();
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
    turns.push(mode === 'uninstall-proposal'
      ? await measureUninstall(page, state, composer, send, index)
      : await measure(page, state, composer, send, index));
  }
  if (state.sockets !== 1 || state.frameErrors || state.socketErrors || state.pageErrors
      || state.apiErrors.some((error) => error.path !== '/api/platform-release' || error.status !== 503)) {
    throw new Error('Browser transport or page failed');
  }
  const measured = turns.slice(WARMUPS);
  const values = measured.map((turn) => turn.sample);
  stage = 'complete';
  const shared = { status: 'complete', mode, warmups: WARMUPS, samples, turn_errors: 0,
    sockets: state.sockets, api_errors: state.apiErrors, ordered_samples_ms: values };
  console.log(JSON.stringify(mode === 'uninstall-proposal'
    ? { ...shared, proposal: summary(values, 'proposal_ms'),
      rendered_proposal_upper: summary(values, 'rendered_proposal_upper_ms'),
      cancel_round_trip: summary(values, 'cancel_round_trip_ms'),
      cancelled_dom_upper: summary(values, 'cancelled_dom_upper_ms') }
    : { ...shared, phase_sequence: turns[WARMUPS].phases,
      pending: summary(values, 'pending_ms'), first_progress: summary(values, 'first_progress_ms'),
      terminal: summary(values, 'terminal_ms'),
      rendered_reply_upper: summary(values, 'rendered_reply_upper_ms') }));
}

try {
  await run();
} catch (error) {
  console.log(JSON.stringify({ status: 'error', stage, error_type: error?.name ?? 'Error' }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
