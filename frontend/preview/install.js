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

const scenario = createScenario(chosenScenario());
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
  return answer
    ? jsonResponse(answer.status, answer.json)
    : jsonResponse(503, { detail: `The ${scenario.name} preview scenario does not answer this request.` });
};

// A scripted chat socket: it accepts the requested subprotocol and answers frames from the scenario.
class ScenarioSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols) {
    super();
    this.url = url;
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
    for (const reply of scenario.chat.message(frame)) {
      setTimeout(() => {
        if (this.readyState === ScenarioSocket.OPEN) {
          this.#emit('message', new MessageEvent('message', { data: JSON.stringify(reply) }));
        }
      }, 400);
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
  if (sameHost && target.pathname === scenario.chat.path) return new ScenarioSocket(target.href, protocols);
  // Only Vite's own hot-reload socket stays real; every other socket is refused.
  if (sameHost && [protocols].flat().some((name) => ['vite-hmr', 'vite-ping'].includes(name))) {
    return new RealWebSocket(url, protocols);
  }
  throw new DOMException('Refused by the preview scenario.', 'SecurityError');
};
Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
