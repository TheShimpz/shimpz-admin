// The unit tests' stand-in for the Admin session socket (ADR-0114): each operation a module asks for goes to the stub
// the test installed, `(method, params, options) => answer`, where an answer reads like a call result.
import { socketReads } from '../src/lib/adminSocket.js';

/** A call result as the socket client gives it: `ok`, `status`, and a JSON body. */
export function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return structuredClone(body); } };
}

/** Answer every call the code under test makes next with `stub`. */
export function answering(stub) {
  socketReads.call = stub;
  return stub;
}

/** Run `operation` with `stub` answering the calls it makes as it starts, and return its promise. */
export function via(stub, operation) {
  answering(stub);
  return operation();
}

/** A stub that answers every call with one status and body and records each call as `{ method, params }`. */
export function recorder(status, body) {
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    return response(status, body);
  };
  return { calls, call };
}

/** A stub whose answer the test releases later with `answer(response)`. */
export function held() {
  const pending = {};
  pending.call = () => new Promise((resolve) => { pending.answer = resolve; });
  return pending;
}
