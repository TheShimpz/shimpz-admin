const CAPSULE_ID_RE = /^[a-z0-9_]{1,40}$/;
const ASSISTANT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RUNTIME_STATUS_RE = /^[a-z]{2,24}$/;
const HELLO_ID = 'hello-pulse';
const MAX_INSTALLED_ASSISTANTS = 128;

export class LocalApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LocalApiError';
    this.status = status;
  }
}

export function safeApiError(body, fallback) {
  const candidate = body?.error ?? body?.detail;
  return typeof candidate === 'string' && candidate.length <= 300 ? candidate : fallback;
}

async function jsonObject(response) {
  const body = await response.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

/** Read the controller-owned runtime inventory; never turn an invalid response into an empty list. */
export async function listInstalledAssistants(fetcher, capsuleId) {
  if (typeof fetcher !== 'function' || !CAPSULE_ID_RE.test(capsuleId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }

  const response = await fetcher(
    `/api/capsules/${encodeURIComponent(capsuleId)}/assistants`,
    { cache: 'no-store', headers: { Accept: 'application/json' } },
  );
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'The installed Assistant inventory is unavailable.'),
      response.status,
    );
  }
  if (!Array.isArray(body.assistants) || body.assistants.length > MAX_INSTALLED_ASSISTANTS) {
    throw new LocalApiError('The installed Assistant inventory is invalid.', response.status);
  }

  const seen = new Set();
  return body.assistants.map((entry) => {
    const assistant = entry?.assistant;
    const status = entry?.status;
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof assistant !== 'string' ||
      assistant.length > 80 ||
      !ASSISTANT_ID_RE.test(assistant) ||
      !RUNTIME_STATUS_RE.test(status) ||
      seen.has(assistant)
    ) {
      throw new LocalApiError('The installed Assistant inventory is invalid.', response.status);
    }
    seen.add(assistant);
    return { assistant, status };
  });
}

/** Always let the idempotent install endpoint reconcile runtime state before invoking the hello Power. */
export async function evaluateHelloPulse(fetcher, capsuleId, name = 'Captain') {
  if (typeof fetcher !== 'function' || !CAPSULE_ID_RE.test(capsuleId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\r\n]/.test(name)) {
    throw new LocalApiError('Invalid hello input.');
  }

  const base = `/api/capsules/${encodeURIComponent(capsuleId)}/assistants`;
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const installResponse = await fetcher(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ assistant: HELLO_ID }),
  });
  const installBody = await jsonObject(installResponse);
  // 409 remains safe for a concurrent installer; both paths still prove readiness through the Power.
  if (!installResponse.ok && installResponse.status !== 409) {
    throw new LocalApiError(
      safeApiError(installBody, 'The local evaluation could not be completed.'),
      installResponse.status,
    );
  }

  const helloResponse = await fetcher(`${base}/${HELLO_ID}/powers/hello`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: name.trim() }),
  });
  const helloBody = await jsonObject(helloResponse);
  if (!helloResponse.ok) {
    throw new LocalApiError(
      safeApiError(helloBody, 'The local evaluation could not be completed.'),
      helloResponse.status,
    );
  }
  const message = helloBody.message ?? helloBody.result?.message;
  if (typeof message !== 'string' || !message || message.length > 256) {
    throw new LocalApiError('The local evaluation could not be completed.', helloResponse.status);
  }
  return { message, installed: installResponse.ok && installBody.installed === true };
}
