// A scripted Admin session socket (ADR-0114) for the browser tests, the presentation preview, and the measurements. It
// speaks `shimpz.admin.v1` exactly as Admin frames it: one `result` per `call`, `changed` invalidations for subscribed
// topics, and each attached Team's `shimpz.chat.v7` frames with that Team's `team_id`. What answers a read or a chat
// frame is the caller's: a scenario, or a test's own handlers. Anything not answered is refused, never invented.

export const SESSION_SOCKET_PATH = '/api/session/ws';
export const SESSION_PROTOCOL = 'shimpz.admin.v1';
const EPOCH = '5'.repeat(32);
// The `shimpz.chat.v7` server frames whose own shape names their Team; every other frame gains it on the channel.
const NATIVE_TEAM_FRAMES = new Set(['done', 'assistant-install-plan', 'assistant-guidance']);
const NATIVE_UNINSTALL_STATES = new Set(['proposed', 'uninstalled']);

function channelFrame(teamId, event) {
  const native = NATIVE_TEAM_FRAMES.has(event?.type) ||
    (event?.type === 'assistant-uninstall' && NATIVE_UNINSTALL_STATES.has(event.state));
  return native ? event : { ...event, team_id: teamId };
}

/**
 * The server side of one session socket. `transport` sends text and closes; `handlers` answers:
 * - `call(method, params)`: `{ status, json }`, a promise of one, or null (refused as unavailable);
 * - `chat(teamId)`: whether the Team's channel attaches, and the channel handler `(channel) => void` it then runs, which
 *   reads `channel.onMessage((text) => ...)` and answers with `channel.send(textOrFrame)` as a v7 socket handler did.
 * The returned session's `onActivity()` hears each report of the person's input and may answer it with the session's
 * renewed deadlines, `{ idle_seconds, absolute_seconds }`.
 * `frames` records every client frame in order.
 */
export function serveSession(transport, handlers) {
  const topics = new Map();
  const channels = new Map();
  const frames = [];
  let closed = false;

  function send(frame) {
    if (!closed) transport.send(JSON.stringify(frame));
  }

  function close(code = 1000, reason = '') {
    if (closed) return;
    closed = true;
    transport.close(code, reason);
  }

  function attach(teamId, locale) {
    const run = handlers.chat?.(teamId);
    if (!run || channels.has(teamId)) return false;
    const listeners = [];
    const channel = {
      teamId,
      onMessage(listener) {
        listeners.push(listener);
      },
      send(value) {
        const event = typeof value === 'string' ? JSON.parse(value) : value;
        if (channels.get(teamId) === channel) send(channelFrame(teamId, event));
      },
      // A v7 socket handler's close drops the whole session socket.
      close({ code = 1000, reason = '' } = {}) {
        close(code, reason);
      },
      receive(frame) {
        const text = JSON.stringify(frame);
        for (const listener of listeners) listener(text);
      },
    };
    channels.set(teamId, channel);
    run(channel);
    // Attaching synchronizes the Team, as Admin does once it has answered the attach.
    return () => channel.receive({ type: 'sync', locale });
  }

  async function answer(frame) {
    const { id, method, params } = frame;
    if (method === 'subscribe' || method === 'unsubscribe') {
      for (const topic of params.topics) {
        if (method === 'subscribe') topics.set(topic, topics.get(topic) ?? 0);
        else topics.delete(topic);
      }
      return { status: 200, json: { epoch: EPOCH, topics: Object.fromEntries(topics) } };
    }
    if (method === 'chat.attach') {
      const synchronize = attach(params.team_id, params.locale);
      if (!synchronize) return { status: 409, json: { detail: 'the Team cannot attach' } };
      return { status: 200, json: { team_id: params.team_id }, after: synchronize };
    }
    if (method === 'chat.detach') {
      if (!channels.delete(params.team_id)) return { status: 409, json: { detail: 'the Team is not attached' } };
      return { status: 200, json: { team_id: params.team_id } };
    }
    const answered = await handlers.call?.(method, params, frame);
    return answered ?? { status: 503, json: { detail: 'Not in this scenario.' } };
  }

  async function receive(text) {
    const frame = JSON.parse(text);
    frames.push(frame);
    if (frame.type === 'call') {
      const { status, json, after } = await answer(frame);
      send({ type: 'result', id: frame.id, status, body: json ?? {} });
      after?.();
      return;
    }
    if (frame.type === 'activity') {
      const renewed = session.onActivity?.();
      if (renewed) send({ type: 'session', ...renewed });
      return;
    }
    const channel = channels.get(frame.team_id);
    if (!channel) {
      close(1008, 'chat channel is not attached');
      return;
    }
    const { team_id: _teamId, ...v7 } = frame;
    channel.receive(v7);
  }

  const session = {
    onActivity: null,
    frames,
    receive,
    close,
    // Admin raised a topic: a subscribed socket hears of it.
    changed(topic) {
      if (!topics.has(topic)) return;
      const revision = topics.get(topic) + 1;
      topics.set(topic, revision);
      send({ type: 'changed', topic, epoch: EPOCH, revision });
    },
    // Admin told the page the session's deadlines, in whole seconds from now.
    deadlines(idleSeconds, absoluteSeconds) {
      send({ type: 'session', idle_seconds: idleSeconds, absolute_seconds: absoluteSeconds });
    },
    subscribed: (topic) => topics.has(topic),
    channel: (teamId) => channels.get(teamId),
  };
  return session;
}

/** Handlers that answer every read and chat frame from one shared scenario (e2e/scenarios.js). */
export function scenarioHandlers(scenario) {
  return {
    call: (method, params) => scenario.call(method, params),
    chat: (teamId) => scenario.attachable(teamId) && ((channel) => {
      channel.onMessage((message) => {
        for (const reply of scenario.chat.message(JSON.parse(message), teamId)) channel.send(reply);
      });
    }),
  };
}
