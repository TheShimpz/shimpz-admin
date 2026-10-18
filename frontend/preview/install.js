// Preview only (ADR-0087): answer the Admin API and the session socket from a scenario inside the browser, before the
// application boots. A request or socket the scenario does not answer fails here; nothing reaches a backend.
import { get } from 'svelte/store';

import { rfbServer, solid } from '../e2e/rfbServer.js';
import { createScenario, SCENARIOS } from '../e2e/scenarios.js';
import { serveSession, SESSION_PROTOCOL, SESSION_SOCKET_PATH } from '../e2e/sessionSocket.js';
import { locale } from '../src/lib/i18n/index.js';

const STORAGE_KEY = 'shimpz-preview-scenario';

function chosenScenario() {
  const requested = new URL(location.href).searchParams.get('scenario');
  let name = requested;
  try {
    if (requested) sessionStorage.setItem(STORAGE_KEY, requested);
    name = requested ?? sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable; the query parameter alone still selects the scenario.
  }
  return SCENARIOS.includes(name) ? name : 'ready';
}

// The scenario's own texts are in the interface language Admin starts in (i18n/index.js); after switching the
// language, reload the preview to see the scenario in it.
const scenario = createScenario(chosenScenario(), get(locale));
// Switching the interface language reloads the preview, so the scenario's texts follow it.
try {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function setPreviewItem(key, value) {
    const changed = this === localStorage && key === 'shimpz_lang' && this.getItem(key) !== value;
    setItem.call(this, key, value);
    if (changed) location.reload();
  };
} catch {
  // Without storage the language still switches; reload the preview to see the scenario in it.
}
// A saved Team order survives a reload of the preview tab, the way Admin keeps it; it is replayed through the
// scenario's own validation, so a stale order is simply refused. The reorder failure scenarios always start fresh.
const ORDER_KEY = scenario.name.startsWith('reorder-') ? null : `shimpz-preview-team-order:${scenario.name}`;
try {
  const saved = ORDER_KEY && JSON.parse(sessionStorage.getItem(ORDER_KEY) ?? 'null');
  if (Array.isArray(saved)) scenario.call('teams.reorder', { body: { team_ids: saved } });
} catch {
  // Without storage the preview starts from the scenario's own order.
}
// One session socket call, answered by the scenario; a Team order it saved is kept for the next reload.
// `?data=unavailable` (preview only): Admin is reachable but answers its reads 503 for the first 15 s, as when Team is
// briefly unavailable, so the shared availability message shows and then clears by itself.
const DATA_UNAVAILABLE = new URL(location.href).searchParams.get('data') === 'unavailable';
const DATA_STARTED = Date.now();
// `?loading=slow` (preview only): every read of a Team's chat history takes 3 s, as with a slow Admin, so the chat's
// loading indicator shows whenever a Team's conversation is not known yet; one the session kept opens at once.
const LOADING_SLOW = new URL(location.href).searchParams.get('loading') === 'slow';
const SLOW_HISTORY_MS = 3_000;
// An Assistant page's details are just as slow, so its skeleton shows.
const SLOW_DETAILS = new Set(['assistants.details', 'snapshots.details']);

function previewCall(method, params) {
  if (DATA_UNAVAILABLE && Date.now() - DATA_STARTED < 15_000) return { status: 503, json: { detail: 'unavailable' } };
  if (LOADING_SLOW && ((method === 'history.page' && !params.routine) || SLOW_DETAILS.has(method))) {
    return new Promise((resolve) => setTimeout(() => resolve(scenario.call(method, params)), SLOW_HISTORY_MS));
  }
  const answer = scenario.call(method, params);
  if (ORDER_KEY && answer?.status === 200 && method === 'teams.reorder') {
    try {
      sessionStorage.setItem(ORDER_KEY, JSON.stringify(params.body.team_ids));
    } catch {
      // The order still holds until the tab reloads.
    }
  }
  return answer;
}
const realFetch = window.fetch.bind(window);
const RealWebSocket = window.WebSocket;

function jsonResponse(status, json) {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
}

// A JSON body as the scenario reads it, or a multipart upload as its one `file` part's name, type, and size.
async function requestBody(request) {
  if (['GET', 'HEAD'].includes(request.method)) return null;
  if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    const parts = form ? [...form.entries()] : [];
    const [name, file] = parts[0] ?? [];
    return parts.length === 1 && name === 'file' && file instanceof File
      ? { file: { name: file.name, type: file.type, size: file.size } }
      : null;
  }
  const text = await request.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// A file's page rendition or download is read as bytes; the preview server answers it from fixtures (plugin.js).
const FILE_BYTES_RE = /^\/api\/teams\/[a-z0-9_]{1,40}\/files\/[0-9a-f]{32}\/(?:pages\/[1-9][0-9]?\/preview|download)$/u;

window.fetch = async (input, init = {}) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (!api) return realFetch(input, init);
  // An Admin API request anywhere but this origin never leaves the browser.
  if (url.origin !== location.origin) return jsonResponse(503, { detail: 'The preview refuses a cross-origin API.' });
  if (request.method === 'GET' && FILE_BYTES_RE.test(url.pathname)) {
    return realFetch(input, init);
  }
  const body = await requestBody(request);
  const answer = scenario.respond({ method: request.method, path: url.pathname, query: url.searchParams, body });
  return answer
    ? jsonResponse(answer.status, answer.json)
    : jsonResponse(503, { detail: `The ${scenario.name} preview scenario does not answer this request.` });
};

const ACTION = { assistant_id: 'shimpz-cloudflare', index: 1, action: 'list-zones', total: 1 };
const PREVIEW_PROGRESS = Object.freeze([
  ['admin', 'admin-preparation', 40],
  ['team', 'team-context', 120],
  ['team', 'model', 2100],
  ['team', 'action', 900, ACTION],
  ['team', 'model', 1300],
  ['admin', 'reply-validation', 30],
].flatMap(([origin, phase, elapsed, action], index) => [
  { type: 'progress', seq: index * 2 + 1, origin, phase, state: 'started', ...(action ?? {}) },
  { type: 'progress', seq: index * 2 + 2, origin, phase, state: 'finished', elapsed_ms: elapsed, ...(action ?? {}) },
]));

// Preview only: the Assistant install and uninstall cards. Asking to uninstall proposes Exa's removal, each time with a
// fresh proposal id so a new card shows, and answering no cancels it; asking to install plans a Local Exa build and a
// published WhatsApp and installs them one after the other, while the turn is still running, as Admin reports them.
const UNINSTALL_RE = /desinstal|uninstall|deinstall|désinstall|アンインストール|卸载|إزالة/i;
const INSTALL_RE = /instal|インストール|安装|تثبيت/i;
const CANCEL_RE = /^(no|não|nao|cancel|cancelar)$/i;
const PREVIEW_INSTALLS = Object.freeze([
  {
    id: 'shimpz-exa', name: 'Exa', summary: 'Searches the web and reads the pages it finds.', creator: '@shimpz',
    version: '0.3.0', providers: [], provenance: 'local',
  },
  {
    id: 'whatsapp', name: 'WhatsApp', summary: 'Sends reviewed WhatsApp messages.', creator: '@meta',
    version: '1.2.0', providers: ['whatsapp'], provenance: 'published',
  },
]);
let previewProposal = '';

function previewId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function lifecycleFrames(frame, teamId) {
  const message = (frame.type === 'chat' ? frame.message ?? '' : '').trim();
  if (UNINSTALL_RE.test(message)) {
    previewProposal = previewId();
    return [{
      type: 'assistant-uninstall', state: 'proposed', proposal_id: previewProposal, team_id: teamId,
      expires_in: 120,
      assistant: { id: 'shimpz-exa', name: 'Exa', version: '0.3.0', creator: '@shimpz', provenance: 'local' },
    }];
  }
  if (previewProposal && CANCEL_RE.test(message)) {
    const proposal = previewProposal;
    previewProposal = '';
    return [{ type: 'assistant-uninstall', state: 'cancelled', proposal_id: proposal, assistant_id: 'shimpz-exa' }];
  }
  if (!INSTALL_RE.test(message)) return null;
  const planId = previewId();
  const plan = (state, statuses, extra = {}) => ({
    type: 'assistant-install-plan', state, plan_id: planId, team_id: teamId,
    assistants: PREVIEW_INSTALLS.map((assistant, index) => ({ ...assistant, status: statuses[index] })),
    ...extra,
  });
  return [
    plan('planned', ['pending', 'pending']),
    plan('installing', ['installing', 'pending']),
    plan('installing', ['installed', 'installing']),
    plan('installed', ['installed', 'installed'], { continuation: 'none' }),
  ];
}

// The scripted Admin session socket (ADR-0114): it accepts the session protocol and answers every read and chat frame
// from the scenario. A finished reply arrives after the execution stages a real turn reports, so its trace can be
// reviewed, and Stop cancels the replies still on their way and answers like Team: the turn stopped.
function previewChat(teamId) {
  return scenario.attachable(teamId) && ((channel) => {
    const pending = [];
    channel.onMessage((message) => {
      const frame = JSON.parse(message);
      if (frame.type === 'stop') {
        pending.splice(0).forEach(clearTimeout);
        setTimeout(() => channel.send({ type: 'stopped' }), 0);
        return;
      }
      const lifecycle = lifecycleFrames(frame, teamId);
      if (lifecycle) {
        lifecycle.forEach((item, index) => pending.push(setTimeout(() => channel.send(item), 300 + index * 1200)));
        return;
      }
      for (const reply of scenario.chat.message(frame, teamId)) {
        const frames = reply?.type === 'done' ? [...PREVIEW_PROGRESS, reply] : [reply];
        frames.forEach((item, index) => {
          const delay = item === reply ? 3000 : 200 + index * 220;
          pending.push(setTimeout(() => channel.send(item), delay));
        });
      }
    });
  });
}

// Preview-only states that a live Admin reaches only with time or a broken connection: `?session=expiring` starts the
// session 125 s before its idle expiry (the warning shows after about 5 s and Stay signed in renews it),
// `?socket=reconnecting` drops the socket after 3 s and refuses to reopen for about 20 s, and `?version=stale` has Admin
// name another commit than the preview's own build (vite.config.js), as after an update the tab outlived, so the
// sidebar shows the notice that reloads the page.
const PREVIEW_PARAMS = new URL(location.href).searchParams;
const SESSION_EXPIRING = PREVIEW_PARAMS.get('session') === 'expiring';
const SOCKET_RECONNECTING = PREVIEW_PARAMS.get('socket') === 'reconnecting';
const VERSION_STALE = PREVIEW_PARAMS.get('version') === 'stale';
const SERVED_REVISION = VERSION_STALE ? 'b'.repeat(40) : __ADMIN_REVISION__;
// The commit time the scripted Admin names with its commit.
const PREVIEW_SOURCE_TIME = 1_791_884_573;
const PREVIEW_STARTED = Date.now();

// Admin keeps topic revisions for its whole process: every scripted socket of the page shares them.
const PREVIEW_REVISIONS = new Map();

class SessionSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.protocol = SESSION_PROTOCOL;
    this.readyState = SessionSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.session = serveSession({
      send: (text) => setTimeout(() => this.#emit('message', new MessageEvent('message', { data: text })), 0),
      close: (code, reason) => this.close(code, reason),
    }, { call: previewCall, chat: previewChat }, PREVIEW_REVISIONS);
    const refused = SOCKET_RECONNECTING && Date.now() - PREVIEW_STARTED > 1000 && Date.now() - PREVIEW_STARTED < 23000;
    setTimeout(() => {
      if (refused) {
        this.readyState = SessionSocket.CLOSED;
        this.#emit('close', new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
        return;
      }
      this.readyState = SessionSocket.OPEN;
      this.#emit('open', new Event('open'));
      // Admin tells a socket its deadlines and its commit as it opens.
      if (SESSION_EXPIRING || VERSION_STALE) this.#deadline(SESSION_EXPIRING ? 125 : 3600);
      if (SOCKET_RECONNECTING && Date.now() - PREVIEW_STARTED < 1000) setTimeout(() => this.close(1006), 3000);
    }, 0);
  }

  #deadline(idleSeconds) {
    const data = JSON.stringify({
      type: 'session', idle_seconds: idleSeconds, absolute_seconds: 80000, source_revision: SERVED_REVISION,
      source_time: SERVED_REVISION === null ? null : PREVIEW_SOURCE_TIME,
    });
    setTimeout(() => this.#emit('message', new MessageEvent('message', { data })), 0);
  }

  #emit(type, event) {
    if (type === 'message' && this.readyState !== SessionSocket.OPEN) return;
    this.dispatchEvent(event);
    this[`on${type}`]?.(event);
  }

  send(data) {
    if (this.readyState !== SessionSocket.OPEN) return;
    if (JSON.parse(data)?.type === 'activity') {
      if (SESSION_EXPIRING) this.#deadline(3600);
      return;
    }
    void this.session.receive(data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === SessionSocket.CLOSED) return;
    this.readyState = SessionSocket.CLOSED;
    setTimeout(() => this.#emit('close', new CloseEvent('close', { code, reason, wasClean: true })), 0);
  }
}

// A watched Browser task's display (ADR-0117): a scripted RFB server draws a page, then a bar under its header that
// fills in steps, as a page that loads; noVNC reads it exactly as it reads the Browser's display.
const BROWSER_STREAM_RE = /^\/api\/teams\/[a-z0-9_]{1,40}\/browser\/views\/[0-9a-f]{32}\/stream$/u;
const STREAM_STEP_MS = 400;
const BAR_STEP = 80;

function previewScreen() {
  let bar = 0;
  return ({ incremental }) => {
    if (!incremental) {
      return [
        solid(1280, 800, [246, 246, 242]),
        solid(1280, 64, [28, 59, 63]),
        solid(520, 40, [40, 120, 200], 96, 128),
        ...[0, 1, 2, 3, 4, 5].map((line) => solid(line % 3 === 2 ? 640 : 1000, 14, [196, 198, 204], 96, 220 + line * 40)),
        solid(480, 220, [222, 228, 236], 96, 480),
        solid(480, 220, [236, 224, 214], 704, 480),
      ];
    }
    bar = bar >= 1280 ? 0 : bar + BAR_STEP;
    return bar === 0 ? [solid(1280, 4, [246, 246, 242], 0, 64)] : [solid(BAR_STEP, 4, [232, 140, 72], bar - BAR_STEP, 64)];
  };
}

class StreamSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.protocol = 'binary';
    this.binaryType = 'blob';
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.server = rfbServer({ screen: previewScreen() });
    this.drawn = false;
    setTimeout(() => {
      this.readyState = 1;
      this.#emit('open', new Event('open'));
      this.#deliver(this.server.greeting, 0);
    }, 0);
  }

  #emit(type, event) {
    this.dispatchEvent(event);
    this[`on${type}`]?.(event);
  }

  // Each answer after the first screen waits a step, as a display sends a change only once the page changed.
  #deliver(bytes, delay) {
    setTimeout(() => {
      if (this.readyState === 1) this.#emit('message', new MessageEvent('message', { data: bytes.slice().buffer }));
    }, delay);
  }

  send(data) {
    if (this.readyState !== 1) return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const answer of this.server.receive(bytes)) {
      this.#deliver(answer, this.drawn ? STREAM_STEP_MS : 0);
      this.drawn = this.drawn || answer.length > 4 * 1024;
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.#emit('close', new CloseEvent('close', { code, reason, wasClean: true })), 0);
  }
}

window.WebSocket = function PreviewWebSocket(url, protocols) {
  const target = new URL(url, location.href);
  const sameHost = target.host === location.host;
  if (sameHost && target.pathname === SESSION_SOCKET_PATH && [protocols].flat().includes(SESSION_PROTOCOL)) {
    return new SessionSocket(target.href);
  }
  if (sameHost && BROWSER_STREAM_RE.test(target.pathname) && [protocols].flat().includes('binary')) {
    return new StreamSocket(target.href);
  }
  // Only Vite's own hot-reload socket stays real; every other socket is refused.
  if (sameHost && [protocols].flat().some((name) => ['vite-hmr', 'vite-ping'].includes(name))) {
    return new RealWebSocket(url, protocols);
  }
  throw new DOMException('Refused by the preview scenario.', 'SecurityError');
};
Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
