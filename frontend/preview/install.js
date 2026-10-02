// Preview only (ADR-0087): answer the Admin API and the chat socket from a scenario inside the browser, before the
// application boots. A request or socket the scenario does not answer fails here; nothing reaches a backend.
import { createScenario, SCENARIOS } from '../e2e/scenarios.js';

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

// The interface language Admin will start in (i18n.js), so the scenario's own texts match it; after switching the
// language, reload the preview to see the scenario in it.
function chosenLocale() {
  const supported = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];
  let stored = null;
  try {
    stored = localStorage.getItem('shimpz_lang');
  } catch {
    stored = null;
  }
  const candidates = [stored, ...(navigator.languages ?? [navigator.language])].filter(Boolean);
  return candidates.map((code) => code.slice(0, 2).toLowerCase()).find((code) => supported.includes(code)) ?? 'en';
}

const scenario = createScenario(chosenScenario(), chosenLocale());
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
  if (Array.isArray(saved)) scenario.respond({ method: 'PUT', path: '/api/teams/order', body: { team_ids: saved } });
} catch {
  // Without storage the preview starts from the scenario's own order.
}
const realFetch = window.fetch.bind(window);
const RealWebSocket = window.WebSocket;

function jsonResponse(status, json) {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
}

window.fetch = async (input, init = {}) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (!api) return realFetch(input, init);
  // An Admin API request anywhere but this origin never leaves the browser.
  if (url.origin !== location.origin) return jsonResponse(503, { detail: 'The preview refuses a cross-origin API.' });
  const text = ['GET', 'HEAD'].includes(request.method) ? '' : await request.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const answer = scenario.respond({ method: request.method, path: url.pathname, body });
  if (ORDER_KEY && answer?.status === 200 && url.pathname === '/api/teams/order') {
    try {
      sessionStorage.setItem(ORDER_KEY, JSON.stringify(body.team_ids));
    } catch {
      // The order still holds until the tab reloads.
    }
  }
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

// A scripted chat socket: it accepts the requested subprotocol and answers frames from the scenario.
class ScenarioSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols, teamId) {
    super();
    this.url = url;
    this.teamId = teamId;
    this.protocol = [protocols].flat().filter(Boolean)[0] ?? '';
    this.readyState = ScenarioSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    setTimeout(() => {
      this.readyState = ScenarioSocket.OPEN;
      this.#emit('open', new Event('open'));
    }, 0);
  }

  #pending = [];

  #deliver(reply) {
    if (this.readyState === ScenarioSocket.OPEN) {
      this.#emit('message', new MessageEvent('message', { data: JSON.stringify(reply) }));
    }
  }

  #emit(type, event) {
    this.dispatchEvent(event);
    this[`on${type}`]?.(event);
  }

  send(data) {
    if (this.readyState !== ScenarioSocket.OPEN) return;
    let frame = null;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    // Stop cancels the replies still on their way and answers like Team: the turn stopped.
    if (frame?.type === 'stop') {
      this.#pending.splice(0).forEach(clearTimeout);
      setTimeout(() => this.#deliver({ type: 'stopped' }), 0);
      return;
    }
    for (const reply of scenario.chat.message(frame, this.teamId)) {
      // A finished reply arrives after the execution stages a real turn reports, so its trace can be reviewed.
      const frames = reply?.type === 'done' ? [...PREVIEW_PROGRESS, reply] : [reply];
      frames.forEach((item, index) => {
        const delay = item === reply ? 3000 : 200 + index * 220;
        this.#pending.push(setTimeout(() => this.#deliver(item), delay));
      });
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === ScenarioSocket.CLOSED) return;
    this.readyState = ScenarioSocket.CLOSED;
    setTimeout(() => this.#emit('close', new CloseEvent('close', { code, reason, wasClean: true })), 0);
  }
}

window.WebSocket = function PreviewWebSocket(url, protocols) {
  const target = new URL(url, location.href);
  const sameHost = target.host === location.host;
  const teamId = sameHost ? scenario.chat.team(target.pathname) : null;
  if (teamId) return new ScenarioSocket(target.href, protocols, teamId);
  // Only Vite's own hot-reload socket stays real; every other socket is refused.
  if (sameHost && [protocols].flat().some((name) => ['vite-hmr', 'vite-ping'].includes(name))) {
    return new RealWebSocket(url, protocols);
  }
  throw new DOMException('Refused by the preview scenario.', 'SecurityError');
};
Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
