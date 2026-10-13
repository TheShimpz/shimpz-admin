import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '../src/lib/localApi.js';
import { LocalApiError, safeApiError } from '../src/lib/api.js';
import { via } from './socketStub.js';

// Each operation is answered by the stub its test passes first, as the session socket would answer it.
const installLocalAssistant = (stub, ...args) => via(stub, () => api.installLocalAssistant(...args));
const installAssistant = (stub, ...args) => via(stub, () => api.installAssistant(...args));
const listAssistantCatalog = (stub) => via(stub, () => api.listAssistantCatalog());
const listInstalledAssistants = (stub, ...args) => via(stub, () => api.listInstalledAssistants(...args));
// The two catalog reads take the call a synced value's read passes them.
const listLocalAssistantSnapshots = (stub) => api.listLocalAssistantSnapshots(stub);
const listPublicAssistantCatalog = (stub, locale) => api.listPublicAssistantCatalog(locale, stub);
const uninstallAssistant = (stub, ...args) => via(stub, () => api.uninstallAssistant(...args));

const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const LOCAL_IMAGE_ID = `sha256:${'b'.repeat(64)}`;

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}


// The page copy every public catalog entry carries beside its identity (Assistant Spec v1 display copy).
const PAGE_COPY = {
  description: 'Reads your zones and records and changes one only after your approval.',
  links: { github: 'https://github.com/shimpz', site: 'https://shimpz.com/' },
  actions: [
    { id: 'delete-dns-record', effect: 'mutating', description: 'Delete one DNS record.' },
    { id: 'list-zones', effect: 'read_only', description: 'List your zones.' },
  ],
  integrations: [{ id: 'cloudflare', provider: 'cloudflare' }],
  stored_inputs: [],
};

function projectedPage(copy = PAGE_COPY) {
  return {
    description: copy.description,
    links: Object.entries(copy.links)
      .sort(([left], [right]) => ['site', 'github', 'x', 'youtube', 'linkedin', 'instagram'].indexOf(left)
        - ['site', 'github', 'x', 'youtube', 'linkedin', 'instagram'].indexOf(right))
      .map(([kind, url]) => ({ kind, url })),
    actions: copy.actions,
    integrations: copy.integrations,
    storedInputs: copy.stored_inputs,
  };
}

test('install is passive and never invokes an Assistant Action', async () => {
  const calls = [];
  const progress = () => {};
  const fetcher = async (method, params, options) => {
    calls.push({ method, params, options });
    return response(200, { assistant: 'hello-pulse', installed: true });
  };

  const result = await installAssistant(fetcher, 'team_1', 'hello-pulse', SOURCE_DIGEST, { onProgress: progress });

  assert.deepEqual(result, { assistant: 'hello-pulse', installed: true });
  assert.deepEqual(calls, [{
    method: 'assistants.install',
    params: { team_id: 'team_1', body: { assistant_id: 'hello-pulse', source_digest: SOURCE_DIGEST } },
    options: { onProgress: progress },
  }]);
});

test('idempotent install reports an existing Assistant without executing it', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return response(200, { assistant: 'hello-pulse', installed: false });
  };

  assert.deepEqual(
    await installAssistant(fetcher, 'team_1', 'hello-pulse', SOURCE_DIGEST),
    { assistant: 'hello-pulse', installed: false },
  );
  assert.equal(calls, 1);
});

test('safe install errors stop after one request and prefer error over detail', async () => {
  const calls = [];
  const fetcher = async (method) => {
    calls.push(method);
    return response(503, { error: 'runtime recovery failed', detail: 'generic failure' });
  };

  await assert.rejects(
    installAssistant(fetcher, 'team_1', 'hello-pulse', SOURCE_DIGEST),
    (error) => error instanceof LocalApiError && error.status === 503 && error.message === 'runtime recovery failed',
  );
  assert.equal(calls.length, 1);
  assert.equal(safeApiError({ error: 'specific', detail: 'generic' }, 'fallback'), 'specific');
});

test('an install refused at the Team Assistant limit carries only that closed code', async () => {
  const refusal = (status, code) => async () => response(status, { detail: 'refused', code });
  await assert.rejects(
    installAssistant(refusal(409, 'assistant_limit_reached'), 'team_1', 'hello-pulse', SOURCE_DIGEST),
    (error) => error instanceof LocalApiError && error.status === 409 && error.code === 'assistant_limit_reached',
  );
  await assert.rejects(
    installLocalAssistant(refusal(409, 'assistant_limit_reached'), 'team_1', LOCAL_IMAGE_ID),
    (error) => error instanceof LocalApiError && error.code === 'assistant_limit_reached',
  );
  for (const [status, code] of [[409, 'team-context-changed'], [503, 'assistant_limit_reached']]) {
    await assert.rejects(
      installAssistant(refusal(status, code), 'team_1', 'hello-pulse', SOURCE_DIGEST),
      (error) => error instanceof LocalApiError && error.code === '',
    );
  }
});

test('invalid install responses fail closed without invoking anything else', async () => {
  for (const body of [
    { assistant: 'other', installed: true },
    { assistant: 'hello-pulse', installed: 'yes' },
  ]) {
    let calls = 0;
    await assert.rejects(
      installAssistant(async () => {
        calls += 1;
        return response(200, body);
      }, 'team_1', 'hello-pulse', SOURCE_DIGEST),
      (error) => error instanceof LocalApiError && error.message.includes('invalid response'),
    );
    assert.equal(calls, 1);
  }
});

test('uninstalls through the exact Team route and accepts idempotent absence', async () => {
  const calls = [];
  const fetcher = async (method, params) => {
    calls.push({ method, params });
    return response(200, {
      assistant: 'hello-pulse',
      uninstalled: false,
      trace_id: 'a'.repeat(32),
    });
  };

  assert.deepEqual(
    await uninstallAssistant(fetcher, 'team_1', 'hello-pulse'),
    { assistant: 'hello-pulse', uninstalled: false },
  );
  assert.deepEqual(calls, [{ method: 'assistants.uninstall', params: { team_id: 'team_1', assistant_id: 'hello-pulse' } }]);
});

test('lists and installs only exact unpublished Local Assistant snapshots', async () => {
  const snapshot = {
    assistant_id: 'hello-pulse',
    assistant_version: '1.2.3',
    name: 'Hello Pulse',
    summary: 'Says hello from a Local snapshot.',
    actions: ['say-hello'],
    integrations: [],
    declared_creators: ['@shimpz'],
    created_at: '2026-08-28T17:00:00Z',
    image_id: LOCAL_IMAGE_ID,
    platform: 'linux/amd64',
    provenance: 'local',
    unpublished: true,
    admission: 'admissible',
    reason: null,
    admission: 'admissible',
    reason: null,
  };
  const calls = [];
  const fetcher = async (method, params) => {
    calls.push({ method, params });
    if (method === 'snapshots.list') {
      return response(200, { assistants: [snapshot], trace_id: 'c'.repeat(32) });
    }
    return response(200, {
      assistant: 'hello-pulse',
      image_id: LOCAL_IMAGE_ID,
      installed: false,
      updated: true,
      provenance: 'local',
      unpublished: true,
      trace_id: 'd'.repeat(32),
    });
  };

  assert.deepEqual(await listLocalAssistantSnapshots(fetcher), [snapshot]);
  assert.deepEqual(await installLocalAssistant(fetcher, 'team_1', LOCAL_IMAGE_ID), {
    assistant: 'hello-pulse',
    image_id: LOCAL_IMAGE_ID,
    installed: false,
    updated: true,
  });
  assert.deepEqual(calls, [
    { method: 'snapshots.list', params: {} },
    { method: 'assistants.install_local', params: { team_id: 'team_1', body: { image_id: LOCAL_IMAGE_ID } } },
  ]);
});

test('keeps the Team admission verdict and refuses a verdict outside the closed contract', async () => {
  const snapshot = {
    assistant_id: 'hello-pulse',
    assistant_version: '1.2.3',
    name: 'Hello Pulse',
    summary: 'Says hello from a Local snapshot.',
    actions: ['say-hello'],
    integrations: [],
    declared_creators: ['@shimpz'],
    created_at: '2026-08-28T17:00:00Z',
    image_id: LOCAL_IMAGE_ID,
    platform: 'linux/amd64',
    provenance: 'local',
    unpublished: true,
    admission: 'admissible',
    reason: null,
  };
  const listed = (verdict) => listLocalAssistantSnapshots(
    async () => response(200, { assistants: [{ ...snapshot, ...verdict }] }),
  );
  for (const verdict of [
    { admission: 'inadmissible', reason: 'declaration-invalid' },
    { admission: 'inadmissible', reason: 'image-inconsistent' },
    { admission: 'unavailable', reason: null },
  ]) {
    assert.deepEqual(await listed(verdict), [{ ...snapshot, ...verdict }]);
  }
  for (const verdict of [
    { admission: 'inadmissible', reason: null },
    { admission: 'inadmissible', reason: 'restage' },
    { admission: 'admissible', reason: 'declaration-invalid' },
    { admission: 'unavailable', reason: 'image-inconsistent' },
    { admission: 'pending', reason: null },
  ]) {
    await assert.rejects(listed(verdict), /inventory is invalid/);
  }
  // Team's Assistant id grammar bounds an id at 40 characters.
  await assert.rejects(listed({ assistant_id: 'a'.repeat(41) }), /inventory is invalid/);
  assert.equal((await listed({ assistant_id: 'a'.repeat(40) }))[0].assistant_id, 'a'.repeat(40));
  // A staged identity whose labels Team refused still shadows its publication, so the list stays unknown instead of
  // silently dropping it; any other shape of such an entry is simply invalid.
  const unlabeled = {
    ...snapshot,
    assistant_id: 'broken-labels',
    image_id: `sha256:${'e'.repeat(64)}`,
    assistant_version: null,
    name: null,
    summary: null,
    declared_creators: null,
    actions: null,
    integrations: null,
    created_at: null,
    admission: 'inadmissible',
    reason: 'labels-invalid',
  };
  const both = (extra) => listLocalAssistantSnapshots(
    async () => response(200, { assistants: [snapshot, { ...unlabeled, ...extra }] }),
  );
  await assert.rejects(both({}), /inventory is invalid/);
  for (const extra of [
    { name: 'Broken' },
    { image_id: LOCAL_IMAGE_ID },
    { admission: 'admissible' },
    { assistant_id: 'Broken' },
    { platform: 'linux/riscv64' },
    { unpublished: false },
  ]) {
    await assert.rejects(both(extra), /inventory is invalid/);
  }
  const { reason: _reason, ...withoutReason } = snapshot;
  await assert.rejects(
    listLocalAssistantSnapshots(async () => response(200, { assistants: [withoutReason] })),
    /inventory is invalid/,
  );
});

test('rejects malformed Local snapshot inventories, requests, and acknowledgements', async () => {
  await assert.rejects(
    listLocalAssistantSnapshots(async () => response(200, {
      assistants: [{
        assistant_id: 'hello-pulse',
        assistant_version: '1.2.3',
        created_at: 'yesterday',
        image_id: LOCAL_IMAGE_ID,
        platform: 'linux/amd64',
        provenance: 'local',
        unpublished: true,
        admission: 'admissible',
        reason: null,
      }],
    })),
    /inventory is invalid/,
  );
  await assert.rejects(
    listLocalAssistantSnapshots(async () => response(200, {
      assistants: [{
        assistant_id: 'hello-pulse',
        assistant_version: '1.2.3',
        name: 'Hello Pulse',
        summary: 'Says hello.',
        declared_creators: ['@shimpz', '@shimpz'],
        created_at: '2026-08-28T17:00:00Z',
        image_id: LOCAL_IMAGE_ID,
        platform: 'linux/amd64',
        provenance: 'local',
        unpublished: true,
        admission: 'admissible',
        reason: null,
      }],
    })),
    /inventory is invalid/,
  );
  await assert.rejects(
    listLocalAssistantSnapshots(async () => response(200, {
      assistants: [{
        assistant_id: 'hello-pulse',
        assistant_version: '1.2.3',
        created_at: '2026-13-40T25:61:61Z',
        image_id: LOCAL_IMAGE_ID,
        platform: 'linux/amd64',
        provenance: 'local',
        unpublished: true,
        admission: 'admissible',
        reason: null,
      }],
    })),
    /inventory is invalid/,
  );
  await assert.rejects(installLocalAssistant(async () => response(200, {}), 'team_1', 'latest'), /Invalid/);
  await assert.rejects(
    installLocalAssistant(async () => response(200, {
      assistant: 'hello-pulse',
      image_id: LOCAL_IMAGE_ID,
      installed: true,
      provenance: 'published',
      unpublished: true,
    }), 'team_1', LOCAL_IMAGE_ID),
    /invalid response/,
  );
});

test('accepts only the closed Assistant uninstall acknowledgement', async () => {
  assert.deepEqual(
    await uninstallAssistant(async () => response(200, {
      assistant: 'hello-pulse',
      uninstalled: true,
    }), 'team_1', 'hello-pulse'),
    {
      assistant: 'hello-pulse',
      uninstalled: true,
    },
  );
  await assert.rejects(
    uninstallAssistant(async () => response(200, {
      assistant: 'hello-pulse',
      uninstalled: true,
      staged_image_retained: LOCAL_IMAGE_ID,
      remove_command: `docker image rm ${LOCAL_IMAGE_ID}`,
    }), 'team_1', 'hello-pulse'),
    /invalid response/,
  );
});

test('uninstall fails closed on invalid requests, status, or acknowledgements', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return response(200, { assistant: 'hello-pulse', uninstalled: true });
  };
  for (const [teamId, assistantId] of [
    ['../escape', 'hello-pulse'],
    ['team_1', '../escape'],
    ['team_1', 'hello--pulse'],
  ]) {
    await assert.rejects(
      uninstallAssistant(fetcher, teamId, assistantId),
      (error) => error instanceof LocalApiError && error.message === 'Invalid local Assistant request.',
    );
  }
  assert.equal(calls, 0);

  await assert.rejects(
    uninstallAssistant(
      async () => response(503, { detail: 'controller unavailable' }),
      'team_1',
      'hello-pulse',
    ),
    (error) => (
      error instanceof LocalApiError &&
      error.status === 503 &&
      error.message === 'controller unavailable'
    ),
  );

  for (const [status, body] of [
    [201, { assistant: 'hello-pulse', uninstalled: true }],
    [200, { assistant: 'other', uninstalled: true }],
    [200, { assistant: 'hello-pulse', uninstalled: 'yes' }],
    [200, { assistant: 'hello-pulse', uninstalled: true, debug: true }],
    [200, { assistant: 'hello-pulse', uninstalled: true, trace_id: '../invalid' }],
  ]) {
    await assert.rejects(
      uninstallAssistant(async () => response(status, body), 'team_1', 'hello-pulse'),
      (error) => (
        error instanceof LocalApiError &&
        error.message.includes(status === 201 ? 'could not be uninstalled' : 'invalid response')
      ),
    );
  }
});

test('loads the controller-owned installed Assistant inventory without weakening its shape', async () => {
  const calls = [];
  const fetcher = async (method, params) => {
    calls.push({ method, params });
    return response(200, {
      assistants: [
        { assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running', provenance: 'published' },
        { assistant: 'salesnator', assistant_version: '2.0.0', status: 'created', provenance: 'local' },
        { assistant: 'retired-assistant', assistant_version: '0.1.0', status: 'invalid', provenance: 'published' },
      ],
    });
  };

  assert.deepEqual(await listInstalledAssistants(fetcher, 'team_1'), [
    { assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running', provenance: 'published' },
    { assistant: 'salesnator', assistant_version: '2.0.0', status: 'created', provenance: 'local' },
    { assistant: 'retired-assistant', assistant_version: '0.1.0', status: 'invalid', provenance: 'published' },
  ]);
  assert.deepEqual(calls, [{ method: 'assistants.list', params: { team_id: 'team_1' } }]);
});

test('projects only bounded display identities from the local Assistant catalog', async () => {
  const fetcher = async (method, params) => {
    assert.equal(method, 'assistants.registry');
    assert.deepEqual(params, {});
    return response(200, {
      assistants: [
        { id: 'hello-pulse', title: 'Hello Pulse' },
        { id: 'salesnator', title: 'Salesnator' },
      ],
    });
  };

  assert.deepEqual(await listAssistantCatalog(fetcher), [
    { id: 'hello-pulse', name: 'Hello Pulse' },
    { id: 'salesnator', name: 'Salesnator' },
  ]);
});

test('projects the strict public Assistant catalog used by native cards', async () => {
  const assistant = {
    assistant_id: 'shimpz-cloudflare',
    assistant_version: '0.4.5',
    creators: ['@shimpz'],
    icon_digest: `sha256:${'b'.repeat(64)}`,
    name: 'Shimpz Cloudflare',
    source_digest: SOURCE_DIGEST,
    summary: 'Manage Cloudflare DNS.',
  };
  const fetcher = async (method, params) => {
    assert.equal(method, 'store.catalog');
    assert.deepEqual(params, { locale: 'pt' });
    return response(200, { next: null, version: 1, locale: 'pt', assistants: [{ ...assistant, ...PAGE_COPY }] });
  };

  assert.deepEqual(
    await listPublicAssistantCatalog(fetcher, 'pt'),
    [{ ...assistant, page: projectedPage() }],
  );
});

test('reads the public Assistant catalog only in exactly the requested interface language', async () => {
  const invalid = (error) => error instanceof LocalApiError;
  const requested = [];
  const fetcher = async (method, params) => {
    requested.push(params.locale);
    return response(200, { next: null, version: 1, locale: 'en', assistants: [] });
  };
  assert.deepEqual(await listPublicAssistantCatalog(fetcher, 'en'), []);
  await assert.rejects(listPublicAssistantCatalog(fetcher, 'ja'), invalid);
  for (const locale of ['', 'EN', 'pt-BR', 'it', undefined]) {
    await assert.rejects(listPublicAssistantCatalog(fetcher, locale), invalid);
  }
  assert.deepEqual(requested, ['en', 'ja']);
});

test('reports an unavailable public Assistant catalog with its bounded reason', async () => {
  await assert.rejects(
    listPublicAssistantCatalog(async () => response(502, { detail: 'Assistant catalog is unavailable' }), 'pt'),
    (error) => error instanceof LocalApiError && error.status === 502 && error.message === 'Assistant catalog is unavailable',
  );
});

test('bounds Assistant catalog names and summaries by Unicode code points, as their producers count them', async () => {
  const invalid = (error) => error instanceof LocalApiError;
  for (const character of ['界', '😀']) {
    const text = (length) => character.repeat(length);
    const local = (title) => listAssistantCatalog(async () => response(200, {
      assistants: [{ id: 'hello-pulse', title }],
    }));
    const published = (name, summary) => listPublicAssistantCatalog(async () => response(200, {
      next: null,
      version: 1,
      locale: 'en',
      assistants: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_version: '0.4.5',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'b'.repeat(64)}`,
        name,
        source_digest: SOURCE_DIGEST,
        summary,
        ...PAGE_COPY,
      }],
    }), 'en');
    const snapshots = (name, summary) => listLocalAssistantSnapshots(async () => response(200, {
      assistants: [{
        assistant_id: 'hello-pulse',
        assistant_version: '1.2.3',
        name,
        summary,
        actions: ['say-hello'],
        integrations: [],
        declared_creators: ['@shimpz'],
        created_at: '2026-08-28T17:00:00Z',
        image_id: LOCAL_IMAGE_ID,
        platform: 'linux/amd64',
        provenance: 'local',
        unpublished: true,
        admission: 'admissible',
        reason: null,
      }],
    }));
    const [registered] = await local(text(80));
    assert.equal(registered.name, text(80));
    await assert.rejects(local(text(81)), invalid);
    for (const list of [published, snapshots]) {
      // The summary is a short description of at most 80 code points.
      const [entry] = await list(text(80), text(80));
      assert.deepEqual([entry.name, entry.summary], [text(80), text(80)]);
      await assert.rejects(list(text(81), 'Summary'), invalid);
      await assert.rejects(list('Name', text(81)), invalid);
    }
  }
});

test('admits the producer public catalog size and no more', async () => {
  // Store and Developers admit up to 1,000 Assistants; the Admin browser must accept every valid producer catalog.
  const entries = (count) => Array.from({ length: count }, (_, index) => ({
    assistant_id: `assistant-${String(index).padStart(4, '0')}`,
    assistant_version: '1.0.0',
    creators: ['@shimpz'],
    icon_digest: `sha256:${'b'.repeat(64)}`,
    name: `Assistant ${index}`,
    source_digest: SOURCE_DIGEST,
    summary: 'A reviewed Assistant.',
    ...PAGE_COPY,
  }));
  const catalog = (count) => async () => response(200, { next: null, version: 1, locale: 'en', assistants: entries(count) });
  assert.equal((await listPublicAssistantCatalog(catalog(1000), 'en')).length, 1000);
  await assert.rejects(
    listPublicAssistantCatalog(catalog(1001), 'en'),
    (error) => error instanceof LocalApiError && error.message === 'The Assistant catalog is invalid.',
  );
});

test('rejects malformed public Assistant catalog projections', async () => {
  const valid = {
    assistant_id: 'shimpz-cloudflare',
    assistant_version: '0.4.5',
    creators: ['@shimpz'],
    icon_digest: `sha256:${'b'.repeat(64)}`,
    name: 'Shimpz Cloudflare',
    source_digest: SOURCE_DIGEST,
    summary: 'Manage Cloudflare DNS.',
    ...PAGE_COPY,
  };
  const action = PAGE_COPY.actions[1];
  for (const body of [
    { next: null, version: 2, locale: 'en', assistants: [] },
    { next: null, version: 1, assistants: [] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, extra: true }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, creators: [] }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, source_digest: 'sha256:bad' }] },
    { next: null, version: 1, locale: 'en', assistants: [valid, valid] },
    // The page copy follows its contract: bounded localized text, closed link kinds on their own hosts, sorted
    // unique declarations, and only the two effects.
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, description: 'd'.repeat(501) }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, description: ' Untrimmed.' }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, description: 'Bidi\u202eoverride.' }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, links: { facebook: 'https://facebook.com/shimpz' } }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, links: { github: 'https://gitlab.com/shimpz' } }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, links: { youtube: 'https://youtube.com.example.org/x' } }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, links: { site: 'http://shimpz.com/' } }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, links: { site: `https://shimpz.com/${'a'.repeat(238)}` } }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, links: [] }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, actions: [] }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, actions: [...PAGE_COPY.actions].reverse() }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, actions: [{ ...action, effect: 'deleting' }] }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, actions: [{ ...action, description: 'x'.repeat(121) }] }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, actions: [{ ...action, schema: {} }] }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, integrations: [{ id: 'cloudflare' }] }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, stored_inputs: [{ id: 'token', label: 'l'.repeat(121) }] }] },
    { next: null, version: 1, locale: 'en', assistants: [{ ...valid, stored_inputs: [{ id: 'token', label: 'Token' }] }] },
  ]) {
    await assert.rejects(
      listPublicAssistantCatalog(async () => response(200, body), 'en'),
      (error) => error instanceof LocalApiError && error.message === 'The Assistant catalog is invalid.',
    );
  }
});

test('rejects malformed or ambiguous Assistant catalog identities', async () => {
  for (const assistants of [
    null,
    [{ id: '../escape', title: 'Escape' }],
    [{ id: 'hello-pulse', title: ' Hello Pulse' }],
    [{ id: 'hello-pulse', title: 'Hello\nPulse' }],
    [{ id: 'hello-pulse' }],
    // Team's canonical English summary never reaches the interface.
    [{ id: 'hello-pulse', title: 'Hello Pulse', summary: 'Says hello.' }],
    [{ id: 'hello-pulse', title: 'Hello Pulse', actions: [] }],
    [
      { id: 'hello-pulse', title: 'Hello Pulse' },
      { id: 'hello-pulse', title: 'Duplicate' },
    ],
  ]) {
    await assert.rejects(
      listAssistantCatalog(async () => response(200, { assistants })),
      (error) => error instanceof LocalApiError && error.message === 'The local Assistant catalog is invalid.',
    );
  }
});

test('installed inventory errors and malformed records fail honestly instead of looking empty', async () => {
  await assert.rejects(
    listInstalledAssistants(async () => response(503, { detail: 'controller unavailable' }), 'team_1'),
    (error) => error instanceof LocalApiError && error.status === 503 && error.message === 'controller unavailable',
  );

  for (const assistants of [
    null,
    [{ assistant: '../escape', assistant_version: '1.2.3', status: 'running', provenance: 'published' }],
    [{ assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'RUNNING', provenance: 'published' }],
    [{ assistant: 'hello-pulse', status: 'running' }],
    [{ assistant: 'hello-pulse', assistant_version: '01.2.3', status: 'running', provenance: 'published' }],
    [{ assistant: 'hello-pulse', assistant_version: '1.2.3-beta', status: 'running', provenance: 'published' }],
    [{ assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running', provenance: 'unknown' }],
    [{ assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running', provenance: 'published', debug: true }],
    [
      { assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running', provenance: 'published' },
      { assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running', provenance: 'published' },
    ],
    Array.from({ length: 129 }, (_value, index) => ({
      assistant: `assistant-${index}`,
      assistant_version: '1.2.3',
      status: 'running',
      provenance: 'published',
    })),
  ]) {
    await assert.rejects(
      listInstalledAssistants(async () => response(200, { assistants }), 'team_1'),
      (error) => error instanceof LocalApiError && error.message === 'The installed Assistant inventory is invalid.',
    );
  }
});

test('rejects consecutive and trailing hyphens in installed Assistant ids', async () => {
  for (const assistant of ['hello--pulse', 'hello-pulse-']) {
    await assert.rejects(
      listInstalledAssistants(
        async () => response(200, {
          assistants: [{ assistant, assistant_version: '1.2.3', status: 'running', provenance: 'published' }],
        }),
        'team_1',
      ),
      (error) => (
        error instanceof LocalApiError &&
        error.message === 'The installed Assistant inventory is invalid.'
      ),
    );
  }
});

function publication(index) {
  return {
    assistant_id: `assistant-${String(index).padStart(4, '0')}`,
    assistant_version: '1.0.0',
    creators: ['@shimpz'],
    icon_digest: `sha256:${'b'.repeat(64)}`,
    name: `Assistant ${index}`,
    source_digest: SOURCE_DIGEST,
    summary: 'A reviewed Assistant.',
    ...PAGE_COPY,
  };
}

// A catalog served in pages of `size`, each naming the next by its offset and the catalog's digest.
function pagedCatalog(entries, size, digest = 'c'.repeat(32)) {
  const requests = [];
  const call = async (method, params) => {
    requests.push(params);
    const start = params.cursor ? Number(params.cursor.split('.')[0]) : 0;
    const end = Math.min(start + size, entries.length);
    return response(200, {
      version: 1,
      locale: params.locale,
      assistants: entries.slice(start, end),
      next: end < entries.length ? `${end}.${digest}` : null,
    });
  };
  return { call, requests };
}

test('joins the public catalog from its bounded pages, each read with the cursor the last one named', async () => {
  const entries = Array.from({ length: 5 }, (_, index) => publication(index));
  const catalog = pagedCatalog(entries, 2);
  const joined = await listPublicAssistantCatalog(catalog.call, 'en');
  assert.deepEqual(joined.map((entry) => entry.assistant_id), entries.map((entry) => entry.assistant_id));
  assert.deepEqual(catalog.requests, [
    { locale: 'en' },
    { locale: 'en', cursor: `2.${'c'.repeat(32)}` },
    { locale: 'en', cursor: `4.${'c'.repeat(32)}` },
  ]);
  // The pages together admit the producer catalog size and no more, and an Assistant named on two pages is refused.
  assert.equal((await listPublicAssistantCatalog(pagedCatalog(Array.from({ length: 1000 }, (_, index) => publication(index)), 400).call, 'en')).length, 1000);
  for (const repeated of [
    Array.from({ length: 1001 }, (_, index) => publication(index)),
    [publication(0), publication(1), publication(0)],
  ]) {
    await assert.rejects(
      listPublicAssistantCatalog(pagedCatalog(repeated, 400).call, 'en'),
      (error) => error instanceof LocalApiError && error.message === 'The Assistant catalog is invalid.',
    );
  }
});

test('reads a catalog that changed between its pages again from the first page, and gives up after two retries', async () => {
  const entries = Array.from({ length: 3 }, (_, index) => publication(index));
  const paged = pagedCatalog(entries, 2);
  let changes = 1;
  const changing = async (method, params) => {
    if (params.cursor && changes > 0) {
      changes -= 1;
      return response(409, { code: 'catalog-changed', detail: 'The Assistant catalog changed; read it again' });
    }
    return paged.call(method, params);
  };
  assert.equal((await listPublicAssistantCatalog(changing, 'en')).length, 3);
  assert.deepEqual(paged.requests.map((request) => Boolean(request.cursor)), [false, false, true]);

  changes = 3;
  await assert.rejects(
    listPublicAssistantCatalog(changing, 'en'),
    (error) => error instanceof LocalApiError && error.status === 409,
  );
  // Only a later page may answer that the catalog changed; the first page's 409 is a failure like any other.
  await assert.rejects(
    listPublicAssistantCatalog(async () => response(409, { code: 'catalog-changed', detail: 'changed' }), 'en'),
    (error) => error instanceof LocalApiError && error.message === 'changed',
  );
});

test('refuses a page that names a next page without Assistants or with a malformed cursor', async () => {
  for (const next of ['', 'next', `0.${'c'.repeat(32)}`, `2.${'C'.repeat(32)}`, 7]) {
    await assert.rejects(
      listPublicAssistantCatalog(async () => response(200, { version: 1, locale: 'en', assistants: [publication(0)], next }), 'en'),
      (error) => error instanceof LocalApiError && error.message === 'The Assistant catalog is invalid.',
    );
  }
  await assert.rejects(
    listPublicAssistantCatalog(async () => response(200, { version: 1, locale: 'en', assistants: [], next: `1.${'c'.repeat(32)}` }), 'en'),
    (error) => error instanceof LocalApiError && error.message === 'The Assistant catalog is invalid.',
  );
});
