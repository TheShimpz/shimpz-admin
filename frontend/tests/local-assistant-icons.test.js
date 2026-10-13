import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { catalogIconUrl, installedIconUrl } from '../src/lib/assistants/icons.js';
import {
  isInadmissibleLocalPreview,
  loadAssistantSummary,
  loadLocalAssistantIcon,
  loadLocalAssistantSummary,
  loadPublicAssistantIcon,
} from '../src/lib/assistants/preview.js';
import { LocalApiError } from '../src/lib/api.js';
import { via } from './socketStub.js';

// Summaries are read over the session socket; a stub answers each call as the call result Admin sends.
const localSummary = (stub, ...args) => via(stub, () => loadLocalAssistantSummary(...args));
const assistantSummary = (stub, ...args) => via(stub, () => loadAssistantSummary(...args));

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
// The digest of the bytes pngResponse() serves, as the catalog entry of a public icon names it.
const PNG_DIGEST = `sha256:${createHash('sha256').update(new Uint8Array([137, 80, 78, 71])).digest('hex')}`;

function pngResponse() {
  return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

test('bounds Local icon requests to two concurrent fetches without caching', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return pngResponse();
  };

  await Promise.all(Array.from({ length: 5 }, () => loadLocalAssistantIcon(fetcher, IMAGE_ID)));

  assert.equal(maximum, 2);
  assert.equal(calls, 5);
});

test('honors one bounded busy retry response before accepting the PNG', async () => {
  let calls = 0;
  const delays = [];
  const fetcher = async () => {
    const call = ++calls;
    if (calls === 1) {
      return new Response(JSON.stringify({
        code: 'local-assistant-preview-busy',
        retry_after_ms: 25,
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    return pngResponse();
  };

  const icon = await loadLocalAssistantIcon(fetcher, IMAGE_ID, {
    delay: async (delay) => delays.push(delay),
  });

  assert.equal(icon.type, 'image/png');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [25]);
});

test('rejects invalid identities and invalid successful assets', async () => {
  let calls = 0;
  await assert.rejects(loadLocalAssistantIcon(async () => {
    calls += 1;
    return pngResponse();
  }, 'latest'), /Invalid Local Assistant icon request/);
  assert.equal(calls, 0);

  await assert.rejects(
    loadLocalAssistantIcon(
      async () => new Response('not an icon', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      IMAGE_ID,
    ),
    /icon is invalid/,
  );
});

test('bounds public icon requests and retries transient executor pressure', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const delays = [];
  const fetcher = async () => {
    const call = ++calls;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (call === 1) return new Response('{}', { status: 503 });
    return pngResponse();
  };

  await Promise.all([
    loadPublicAssistantIcon(fetcher, 'first-assistant', {
      delay: async (delay) => delays.push(delay),
      iconDigest: PNG_DIGEST,
    }),
    loadPublicAssistantIcon(fetcher, 'second-assistant', { iconDigest: PNG_DIGEST }),
    loadPublicAssistantIcon(fetcher, 'third-assistant', { iconDigest: PNG_DIGEST }),
  ]);

  assert.equal(maximum, 2);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [50]);
});

test('admits a public icon only with the digest its catalog entry names', async () => {
  // Admin serves its current catalog entry's icon: bytes of another publication's icon are not this one.
  await assert.rejects(
    loadPublicAssistantIcon(async () => pngResponse(), 'first-assistant', { iconDigest: `sha256:${'b'.repeat(64)}` }),
    (error) => error instanceof LocalApiError && /changed/.test(error.message),
  );
  for (const iconDigest of [undefined, 'b'.repeat(64)]) {
    await assert.rejects(
      loadPublicAssistantIcon(async () => pngResponse(), 'first-assistant', { iconDigest }),
      /Invalid Assistant icon request/,
    );
  }
});

test('aborts active and queued icon work without starving the queue', async () => {
  const controller = new AbortController();
  let started = 0;
  const blocked = () => {
    started += 1;
    return new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
  };
  const requests = Array.from({ length: 4 }, () => loadLocalAssistantIcon(
    blocked,
    IMAGE_ID,
    { signal: controller.signal },
  ));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 2);

  controller.abort();
  const results = await Promise.allSettled(requests);
  assert.equal(results.every((result) => result.status === 'rejected'), true);
  assert.equal(started, 2);
  assert.equal((await loadLocalAssistantIcon(async () => pngResponse(), IMAGE_ID)).type, 'image/png');
});

function summaryResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('reads a staged snapshot summary in exactly one interface language with one busy retry', async () => {
  const requests = [];
  const delays = [];
  const fetcher = async (method, params) => {
    requests.push({ method, params });
    if (requests.length === 1) {
      return summaryResponse({ code: 'local-assistant-preview-busy', retry_after_ms: 30 }, 503);
    }
    return summaryResponse({ locale: 'pt', summary: 'Publica alterações de DNS.' });
  };

  const summary = await localSummary(fetcher, IMAGE_ID, 'pt', {
    delay: async (delay) => delays.push(delay),
  });

  assert.equal(summary, 'Publica alterações de DNS.');
  assert.deepEqual(delays, [30]);
  assert.deepEqual(requests, Array(2).fill({ method: 'snapshots.summary', params: { image_id: IMAGE_ID, locale: 'pt' } }));
});

test('refuses invalid summary requests and any answer outside the requested locale or shape', async () => {
  let calls = 0;
  const counted = async () => {
    calls += 1;
    return summaryResponse({ locale: 'pt', summary: 'Resumo.' });
  };
  for (const [imageId, locale] of [['latest', 'pt'], [IMAGE_ID, 'pt-BR'], [IMAGE_ID, undefined]]) {
    await assert.rejects(localSummary(counted, imageId, locale), /Invalid Local Assistant summary request/);
  }
  await assert.rejects(
    localSummary(counted, IMAGE_ID, 'pt', { signal: 'not a signal' }),
    /Invalid Local Assistant summary request/,
  );
  assert.equal(calls, 0);

  // A translated summary may use all 80 code points, including ones outside the Basic Multilingual Plane.
  for (const summary of ['x'.repeat(80), `${'x'.repeat(79)}\u{1F44B}`]) {
    const loaded = await localSummary(async () => summaryResponse({ locale: 'pt', summary }), IMAGE_ID, 'pt');
    assert.equal(loaded, summary);
  }

  for (const body of [
    { locale: 'en', summary: 'Summary.' },
    { locale: 'pt' },
    { locale: 'pt', summary: '' },
    { locale: 'pt', summary: ' Resumo.' },
    { locale: 'pt', summary: 'Resumo\nlinha.' },
    { locale: 'pt', summary: 'Cafe\u0301.' },
    { locale: 'pt', summary: 'x'.repeat(81) },
    { locale: 'pt', summary: 'Resumo.', trace_id: 'a'.repeat(32) },
  ]) {
    await assert.rejects(
      localSummary(async () => summaryResponse(body), IMAGE_ID, 'pt'),
      /summary is invalid/,
    );
  }
  await assert.rejects(
    localSummary(async () => summaryResponse({ detail: 'Team is unavailable' }, 502), IMAGE_ID, 'pt'),
    /Team is unavailable/,
  );
  let busy = 0;
  await assert.rejects(
    localSummary(async () => {
      busy += 1;
      return summaryResponse({ code: 'local-assistant-preview-busy', retry_after_ms: 1 }, 503);
    }, IMAGE_ID, 'pt', { delay: async () => {} }),
    /summary is unavailable/,
  );
  assert.equal(busy, 3);
});

test('reads an installed Assistant summary only in the requested interface language', async () => {
  const requests = [];
  const controller = new AbortController();
  const summary = await assistantSummary(async (method, params) => {
    requests.push({ method, params });
    return summaryResponse({ locale: 'ja', summary: 'DNS の変更を安全に公開します。' });
  }, 'team_1', 'shimpz-cloudflare', 'ja', { signal: controller.signal });

  assert.equal(summary, 'DNS の変更を安全に公開します。');
  assert.deepEqual(requests, [{
    method: 'assistants.summary',
    params: { team_id: 'team_1', assistant_id: 'shimpz-cloudflare', locale: 'ja' },
  }]);

  // An answer that arrives after its request was aborted is dropped.
  const aborted = new AbortController();
  const late = assistantSummary(async () => {
    aborted.abort();
    return summaryResponse({ locale: 'ja', summary: 'DNS の変更を安全に公開します。' });
  }, 'team_1', 'shimpz-cloudflare', 'ja', { signal: aborted.signal });
  await assert.rejects(late, (error) => error.name === 'AbortError');
  await assert.rejects(
    assistantSummary(async () => summaryResponse({}), 'team_1', 'shimpz-cloudflare', 'ja', { signal: aborted.signal }),
    (error) => error.name === 'AbortError',
  );

  let calls = 0;
  const counted = async () => {
    calls += 1;
    return summaryResponse({ locale: 'pt', summary: 'Resumo.' });
  };
  for (const [teamId, assistantId, locale, options] of [
    ['Team 1', 'shimpz-cloudflare', 'pt', {}],
    ['team_1', '../icon', 'pt', {}],
    ['team_1', 'shimpz-cloudflare', 'pt-BR', {}],
    ['team_1', 'shimpz-cloudflare', undefined, {}],
    [undefined, 'shimpz-cloudflare', 'pt', {}],
    ['team_1', 7, 'pt', {}],
    ['team_1', 'shimpz-cloudflare', 'pt', { signal: 'not a signal' }],
  ]) {
    await assert.rejects(
      assistantSummary(counted, teamId, assistantId, locale, options),
      /Invalid Assistant summary request/,
    );
  }
  assert.equal(calls, 0);

  for (const body of [
    { locale: 'en', summary: 'Publish DNS changes safely.' },
    { locale: 'pt', summary: ' Resumo.' },
    { locale: 'pt', summary: 'Resumo.', trace_id: 'a'.repeat(32) },
  ]) {
    await assert.rejects(
      assistantSummary(async () => summaryResponse(body), 'team_1', 'shimpz-cloudflare', 'pt'),
      /^LocalApiError: The Assistant summary is invalid\.$/,
    );
  }
  await assert.rejects(
    assistantSummary(
      async () => summaryResponse({ detail: 'Assistant is not installed in this Team' }, 404),
      'team_1',
      'shimpz-cloudflare',
      'pt',
    ),
    (error) => error.status === 404 && error.message === 'Assistant is not installed in this Team',
  );
  await assert.rejects(
    assistantSummary(async () => summaryResponse({}, 502), 'team_1', 'shimpz-cloudflare', 'pt'),
    /The Assistant summary is unavailable/,
  );
});

test('carries only a bounded Team refusal code and recognizes an inadmissible staged preview', async () => {
  const refused = (code, status = 409) => async () => new Response(
    JSON.stringify({ detail: 'Local Assistant preview failed admission', code }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
  const error = await loadLocalAssistantIcon(refused('local-assistant-preview-invalid'), IMAGE_ID).catch((value) => value);
  assert.equal(error.code, 'local-assistant-preview-invalid');
  assert.equal(isInadmissibleLocalPreview(error), true);
  const summaryError = await localSummary(refused('local-assistant-preview-invalid'), IMAGE_ID, 'pt')
    .catch((value) => value);
  assert.equal(isInadmissibleLocalPreview(summaryError), true);

  for (const [code, status] of [
    ['local-assistant-preview-unavailable', 503],
    ['local-assistant-preview-invalid', 503],
    ['local-assistant-snapshot-invalid', 409],
  ]) {
    const other = await loadLocalAssistantIcon(refused(code, status), IMAGE_ID, { delay: async () => {} })
      .catch((value) => value);
    assert.equal(isInadmissibleLocalPreview(other), false);
  }
  const unbounded = await loadLocalAssistantIcon(refused('Local Assistant <preview>'), IMAGE_ID).catch((value) => value);
  assert.equal(unbounded.code, '');
  assert.equal(isInadmissibleLocalPreview(new Error('local-assistant-preview-invalid')), false);
});

test('names an installed Assistant\'s icon by its Team and a publication\'s by its catalog entry, each part encoded', () => {
  assert.equal(installedIconUrl('marketing', 'shimpz-cloudflare'), '/api/teams/marketing/assistants/shimpz-cloudflare/icon');
  assert.equal(catalogIconUrl('hello-pulse'), '/api/assistants/hello-pulse/catalog-icon');
  assert.equal(installedIconUrl('a/b', 'c?d'), '/api/teams/a%2Fb/assistants/c%3Fd/icon');
  assert.equal(catalogIconUrl('../x'), '/api/assistants/..%2Fx/catalog-icon');
});
