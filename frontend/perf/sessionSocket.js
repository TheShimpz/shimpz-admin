// The Admin session socket (ADR-0114) the offline chat measurements stand in for, inside the page: the measured chat
// frames are dispatched synchronously in the page, as Admin's frames would arrive, while each read the page makes is
// answered by the driver. `installSessionSocket` runs in the page (Playwright `addInitScript`), so it is self-contained.

/**
 * Replace the page's WebSocket with one session socket speaking `shimpz.admin.v1`: subscriptions and the chat channel's
 * attach and detach are answered in the page; every other call goes to the driver's `benchCall(method, params)`, which
 * answers `{ status, body }`. Attaching the Team synchronizes it as Admin does (`sync-empty`) and sets `benchReady`.
 * `benchEmit(event)` dispatches one `shimpz.chat.v7` frame of the attached Team; `benchCallSent` and
 * `benchCallAnswered`, when the page sets them, observe each driver-answered call as it leaves and as its result
 * arrives.
 */
export function installSessionSocket() {
  const EPOCH = '5'.repeat(32);
  // The v7 server frames whose own shape names their Team; every other frame carries it on the channel.
  const native = (event) => ['done', 'assistant-install-plan', 'assistant-guidance'].includes(event.type) ||
    (event.type === 'assistant-uninstall' && ['proposed', 'uninstalled'].includes(event.state));
  let socket;
  let attached = null;
  class SessionSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocol) {
      socket = this;
      this.url = url;
      this.protocol = protocol;
      this.readyState = SessionSocket.CONNECTING;
      setTimeout(() => {
        this.readyState = SessionSocket.OPEN;
        this.onopen?.({});
      }, 0);
    }
    deliver(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
    result(id, status, body) {
      this.deliver({ type: 'result', id, status, body });
    }
    send(payload) {
      const frame = JSON.parse(payload);
      if (frame.type !== 'call') return;
      const { id, method, params } = frame;
      if (method === 'subscribe' || method === 'unsubscribe') {
        const topics = method === 'subscribe' ? Object.fromEntries(params.topics.map((topic) => [topic, 0])) : {};
        setTimeout(() => this.result(id, 200, { epoch: EPOCH, topics }), 0);
      } else if (method === 'chat.attach') {
        attached = params.team_id;
        setTimeout(() => {
          this.result(id, 200, { team_id: attached });
          this.deliver({ type: 'sync-empty', team_id: attached });
          window.benchReady = true;
        }, 0);
      } else if (method === 'chat.detach') {
        attached = null;
        setTimeout(() => this.result(id, 200, { team_id: params.team_id }), 0);
      } else {
        window.benchCallSent?.(method, params);
        window.benchCall(method, params).then(({ status, body }) => {
          window.benchCallAnswered?.(method, params);
          this.result(id, status, body);
        });
      }
    }
    close() {
      this.readyState = SessionSocket.CLOSED;
    }
  }
  window.WebSocket = SessionSocket;
  window.benchEmit = (event) => socket.deliver(native(event) ? event : { ...event, team_id: attached });
}

/**
 * Answer the page's reads from `answers` (`method -> (params) => body`); a read with no answer is recorded in
 * `unexpected` and refused, so it fails the trial.
 */
export async function answerCalls(page, answers, unexpected) {
  await page.exposeFunction('benchCall', (method, params) => {
    const body = answers[method]?.(params);
    if (body === undefined || body === null) {
      unexpected.push(`call ${method}`);
      return { status: 503, body: { detail: 'Not in this measurement.' } };
    }
    return { status: 200, body };
  });
}
