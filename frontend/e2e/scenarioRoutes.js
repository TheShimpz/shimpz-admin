// Playwright adapter for the shared scenarios (ADR-0087): the same factories the preview installs answer the page, and
// anything a scenario does not declare fails closed.
import { expect } from '@playwright/test';

import { createScenario } from './scenarios.js';
import { scenarioHandlers, serveSession, SESSION_SOCKET_PATH } from './sessionSocket.js';

// A JSON body as the scenario reads it, or a multipart upload as its one `file` part's name, type, and size.
async function requestBody(request) {
  const type = (await request.headerValue('content-type')) ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': type } })
      .formData()
      .catch(() => null);
    const parts = form ? [...form.entries()] : [];
    const [name, file] = parts[0] ?? [];
    return parts.length === 1 && name === 'file' && file instanceof File
      ? { file: { name: file.name, type: file.type, size: file.size } }
      : null;
  }
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

export async function routeScenario(page, name = 'ready') {
  const scenario = createScenario(name);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const body = await requestBody(request);
    const url = new URL(request.url());
    const answer = scenario.respond({ method: request.method(), path: url.pathname, query: url.searchParams, body });
    return route.fulfill(answer
      ? { status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.json) }
      : { status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Not in this scenario.' }) });
  });
  // Every chat frame the page sends to Marketing's channel is kept in order, so a test can prove exactly what reached
  // the Team boundary. The session socket answers every read and chat frame from the scenario.
  const chatFrames = [];
  const handlers = scenarioHandlers(scenario);
  const mock = await sessionMock(page);
  mock.fallback = {
    call: handlers.call,
    chat: (teamId) => {
      const run = handlers.chat(teamId);
      return run && ((channel) => {
        if (teamId === 'marketing') channel.onMessage((message) => chatFrames.push(JSON.parse(message)));
        run(channel);
      });
    },
  };
  return { ...scenario, chatFrames: () => chatFrames, sessions: mock.sessions };
}

// The page's Admin session socket (ADR-0114), answered per page: each read by its method, each Team's chat channel by
// a handler that sees the channel as a v7 socket handler saw its socket, and a `connect` hook that may refuse a socket
// before it opens (`connectToServer` reaches no server here, so the browser sees a failed connection). A scenario the
// page routes answers whatever a test does not.
const sessionMocks = new WeakMap();

async function sessionMock(page) {
  let mock = sessionMocks.get(page);
  if (mock) return mock;
  mock = { reads: new Map(), chats: new Map(), connect: null, fallback: null, sessions: [], calls: [] };
  sessionMocks.set(page, mock);
  await page.routeWebSocket(/\/api(?:\/|$)/, (socket) => socket.close({ code: 1008, reason: 'Not in this scenario.' }));
  await page.routeWebSocket(`**${SESSION_SOCKET_PATH}`, (socket) => {
    if (mock.connect?.(socket) === false) return;
    const session = serveSession(
      { send: (text) => socket.send(text), close: (code, reason) => socket.close({ code, reason }) },
      {
        call: async (method, params) => {
          mock.calls.push({ method, params });
          // The newest handler answers first; one that returns undefined falls back to the one before it.
          for (const handler of [...(mock.reads.get(method) ?? [])].reverse()) {
            const answer = await handler(params);
            if (answer !== undefined) return answer;
          }
          return mock.fallback?.call(method, params) ?? null;
        },
        chat: (teamId) => mock.chats.get(teamId) ?? mock.fallback?.chat(teamId),
      },
    );
    mock.sessions.push(session);
    socket.onMessage((message) => void session.receive(message));
  });
  return mock;
}

/**
 * Answer one session socket read with `handler(params)`, which returns `{ status, json }`, or undefined to leave the
 * read to the handler registered before it (as `route.fallback()` does).
 */
export async function routeRead(page, method, handler) {
  const { reads } = await sessionMock(page);
  reads.set(method, [...(reads.get(method) ?? []), handler]);
}

/** Every read the page's session sockets asked for, in order, as `{ method, params }`. */
export async function sessionCalls(page) {
  return (await sessionMock(page)).calls;
}

/** Answer one Team's chat channel: `handler(channel)` runs at every attach, as a v7 socket handler ran per socket. */
export async function routeChat(page, teamId, handler) {
  (await sessionMock(page)).chats.set(teamId, handler);
}

/** Decide each session socket as it opens: return false after `socket.connectToServer()` to refuse it. */
export async function routeConnect(page, connect) {
  (await sessionMock(page)).connect = connect;
}

/** Raise one topic on every open session socket of the page, as Admin does when it learns of a change. */
export async function raiseTopic(page, topic) {
  for (const session of (await sessionMock(page)).sessions) session.changed(topic);
}

/** The client frames the page's session sockets received, in order. */
export async function sessionFrames(page) {
  return (await sessionMock(page)).sessions.flatMap((session) => session.frames);
}

/** Wait until the page asked its session socket for one read whose params `matches` admits. */
export async function waitForRead(page, method, matches = () => true) {
  const calls = await sessionCalls(page);
  await expect.poll(() => calls.some((call) => call.method === method && matches(call.params))).toBe(true);
}

/** The params of every read of `method` the page asked for, in order. */
export async function readsOf(page, method) {
  return (await sessionCalls(page)).filter((call) => call.method === method).map((call) => call.params);
}

/** A promise that settles once the page asks for one more read of `method` than it has so far. */
export async function nextRead(page, method) {
  const calls = await sessionCalls(page);
  const count = () => calls.filter((call) => call.method === method).length;
  const before = count();
  return expect.poll(count).toBeGreaterThan(before);
}
