import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isInadmissibleLocalPreview,
  loadAssistantSummary,
  loadLocalAssistantIcon,
  loadLocalAssistantSummary,
  loadPublicAssistantIcon,
} from '../src/lib/localAssistantIcons.js';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

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
    }),
    loadPublicAssistantIcon(fetcher, 'second-assistant'),
    loadPublicAssistantIcon(fetcher, 'third-assistant'),
  ]);

  assert.equal(maximum, 2);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [50]);
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
  const fetcher = async (url, options) => {
    requests.push({ url, accept: options.headers.Accept });
    if (requests.length === 1) {
      return summaryResponse({ code: 'local-assistant-preview-busy', retry_after_ms: 30 }, 503);
    }
    return summaryResponse({ locale: 'pt', summary: 'Publica alterações de DNS.' });
  };

  const summary = await loadLocalAssistantSummary(fetcher, IMAGE_ID, 'pt', {
    delay: async (delay) => delays.push(delay),
  });

  assert.equal(summary, 'Publica alterações de DNS.');
  assert.deepEqual(delays, [30]);
  assert.deepEqual(requests, Array(2).fill({
    url: `/api/local-assistants/${'a'.repeat(64)}/summary?locale=pt`,
    accept: 'application/json',
  }));
});

test('refuses invalid summary requests and any answer outside the requested locale or shape', async () => {
  let calls = 0;
  const counted = async () => {
    calls += 1;
    return summaryResponse({ locale: 'pt', summary: 'Resumo.' });
  };
  for (const [imageId, locale] of [['latest', 'pt'], [IMAGE_ID, 'pt-BR'], [IMAGE_ID, undefined]]) {
    await assert.rejects(loadLocalAssistantSummary(counted, imageId, locale), /Invalid Local Assistant summary request/);
  }
  await assert.rejects(
    loadLocalAssistantSummary(counted, IMAGE_ID, 'pt', { signal: 'not a signal' }),
    /Invalid Local Assistant summary request/,
  );
  assert.equal(calls, 0);

  for (const body of [
    { locale: 'en', summary: 'Summary.' },
    { locale: 'pt' },
    { locale: 'pt', summary: '' },
    { locale: 'pt', summary: ' Resumo.' },
    { locale: 'pt', summary: 'Resumo\nlinha.' },
    { locale: 'pt', summary: 'Cafe\u0301.' },
    { locale: 'pt', summary: 'x'.repeat(161) },
    { locale: 'pt', summary: 'Resumo.', trace_id: 'a'.repeat(32) },
  ]) {
    await assert.rejects(
      loadLocalAssistantSummary(async () => summaryResponse(body), IMAGE_ID, 'pt'),
      /summary is invalid/,
    );
  }
  await assert.rejects(
    loadLocalAssistantSummary(async () => summaryResponse({ detail: 'Team is unavailable' }, 502), IMAGE_ID, 'pt'),
    /Team is unavailable/,
  );
  let busy = 0;
  await assert.rejects(
    loadLocalAssistantSummary(async () => {
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
  const summary = await loadAssistantSummary(async (url, options) => {
    requests.push({ url, cache: options.cache, accept: options.headers.Accept, signal: options.signal });
    return summaryResponse({ locale: 'ja', summary: 'DNS の変更を安全に公開します。' });
  }, 'team_1', 'shimpz-cloudflare', 'ja', { signal: controller.signal });

  assert.equal(summary, 'DNS の変更を安全に公開します。');
  assert.deepEqual(requests, [{
    url: '/api/teams/team_1/assistants/shimpz-cloudflare/summary?locale=ja',
    cache: 'no-store',
    accept: 'application/json',
    signal: controller.signal,
  }]);

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
      loadAssistantSummary(counted, teamId, assistantId, locale, options),
      /Invalid Assistant summary request/,
    );
  }
  await assert.rejects(loadAssistantSummary(null, 'team_1', 'shimpz-cloudflare', 'pt'), /Invalid Assistant summary/);
  assert.equal(calls, 0);

  for (const body of [
    { locale: 'en', summary: 'Publish DNS changes safely.' },
    { locale: 'pt', summary: ' Resumo.' },
    { locale: 'pt', summary: 'Resumo.', trace_id: 'a'.repeat(32) },
  ]) {
    await assert.rejects(
      loadAssistantSummary(async () => summaryResponse(body), 'team_1', 'shimpz-cloudflare', 'pt'),
      /^LocalApiError: The Assistant summary is invalid\.$/,
    );
  }
  await assert.rejects(
    loadAssistantSummary(
      async () => summaryResponse({ detail: 'Assistant is not installed in this Team' }, 404),
      'team_1',
      'shimpz-cloudflare',
      'pt',
    ),
    (error) => error.status === 404 && error.message === 'Assistant is not installed in this Team',
  );
  await assert.rejects(
    loadAssistantSummary(async () => summaryResponse({}, 502), 'team_1', 'shimpz-cloudflare', 'pt'),
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
  const summaryError = await loadLocalAssistantSummary(refused('local-assistant-preview-invalid'), IMAGE_ID, 'pt')
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
