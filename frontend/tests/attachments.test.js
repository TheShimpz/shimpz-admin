import assert from 'node:assert/strict';
import test from 'node:test';

import { localizedChallenge } from '../e2e/localizedRequest.js';
import {
  AttachmentUploadError,
  attachmentKind,
  attachmentReadability,
  attachmentRefusal,
  formatFileSize,
  identifierName,
  MAX_ATTACHMENTS,
  parseFileDisclosure,
  parseRestrictedActions,
  uploadTeamFile,
} from '../src/lib/attachments.js';
import { listChatHistory } from '../src/lib/chatHistory.js';
import { parseChatEvent } from '../src/lib/localChat.js';

const MIB = 1024 * 1024;
const FILE_ID = 'f'.repeat(32);
const SHA = 'a'.repeat(64);
const RESTRICTED = {
  actions: [
    { assistant: 'shimpz-cloudflare', action: 'create-record' },
    { assistant: 'shimpz-cloudflare', action: 'list-zones' },
    { assistant: 'shimpz-mail', action: 'send' },
  ],
  total: 3,
};
const DISCLOSED = { id: FILE_ID, name: 'Contrato final.pdf', media_type: 'application/pdf', size: 482_133, sha256: SHA };

function bytes(...values) {
  return new Uint8Array(values);
}

function sized(prefix, size) {
  const content = new Uint8Array(size);
  content.set(prefix);
  return content;
}

test('reads what Team reads, decided from the bytes rather than the name or type', async () => {
  const cases = [
    [new File([bytes(0xff, 0xd8, 0xff, 0xe0)], 'photo.txt'), { kind: 'image', note: '' }],
    [new File([bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)], 'chart'), { kind: 'image', note: '' }],
    [new File([new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')], 'a.webp'), { kind: 'image', note: '' }],
    [new File([new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WAVE')], 'a.wav'), { kind: 'file', note: 'unreadable' }],
    [new File([sized([0xff, 0xd8, 0xff], 8 * MIB + 1)], 'huge.jpg'), { kind: 'image', note: 'unreadable' }],
    [new File([new TextEncoder().encode('%PDF-1.7\n')], 'scan.pdf'), { kind: 'pdf', note: 'pdf-text' }],
    [new File([sized(new TextEncoder().encode('%PDF-'), 8 * MIB + 1)], 'big.pdf'), { kind: 'pdf', note: 'unreadable' }],
    [new File([bytes(0x00, 0x01, 0x02)], 'blob.bin'), { kind: 'file', note: 'unreadable' }],
    [new File([bytes(0xc3, 0x28)], 'broken.txt'), { kind: 'file', note: 'unreadable' }],
    [new File(['   \n\t'], 'blank.txt'), { kind: 'text', note: 'unreadable' }],
    [new File([bytes(0xef, 0xbb, 0xbf)], 'bom.txt'), { kind: 'file', note: 'unreadable' }],
    [new File(['x'.repeat(32_769)], 'long.txt'), { kind: 'text', note: 'unreadable' }],
    [new File(['é'.repeat(65_537)], 'wide.txt'), { kind: 'text', note: 'unreadable' }],
    [new File(['a'.repeat(MIB + 1)], 'over.txt'), { kind: 'text', note: 'unreadable' }],
    [new File(['Line\fone\r\n'], 'form.txt'), { kind: 'text', note: '', characters: 10, bytes: 10 }],
    [new File([bytes(0xef, 0xbb, 0xbf, 0x6f, 0x6b)], 'bom-ok.md'), { kind: 'text', note: '', characters: 2, bytes: 2 }],
  ];
  for (const [file, expected] of cases) assert.deepEqual(await attachmentReadability(file), expected, file.name);
});

test('admits a file to the message only within every per-file and per-message bound', () => {
  const image = { size: 10, kind: 'image', note: '' };
  const eight = Array.from({ length: MAX_ATTACHMENTS }, () => ({ size: 1, kind: 'file', note: 'unreadable' }));
  assert.equal(attachmentRefusal([], image), '');
  assert.equal(attachmentRefusal(eight, image), 'too-many');
  assert.equal(attachmentRefusal([], { ...image, size: 0 }), 'empty');
  assert.equal(attachmentRefusal([], { ...image, size: 25 * MIB + 1 }), 'too-large');
  assert.equal(attachmentRefusal([{ size: 20 * MIB, kind: 'file', note: 'unreadable' }], { ...image, size: 12 * MIB + 1 }), 'message-too-large');
  assert.equal(attachmentRefusal([image, image, image, image], image), 'too-many-images');
  assert.equal(attachmentRefusal([image, image, image, image], { ...image, note: 'unreadable' }), '');
  const text = { size: 1, kind: 'text', note: '', characters: 32_768, bytes: 32_768 };
  assert.equal(attachmentRefusal([text, text, text], text), '');
  assert.equal(attachmentRefusal([text, text, text, text], { ...text, characters: 1, bytes: 1 }), 'too-much-text');
  const wide = { size: 1, kind: 'text', note: '', characters: 1, bytes: 131_072 };
  assert.equal(attachmentRefusal([wide, wide, wide, wide], { ...wide, bytes: 1 }), 'too-much-text');
  assert.equal(attachmentRefusal([{ size: 1, kind: 'text', note: '' }], { size: 1, kind: 'text', note: '' }), '');
});

test('names sizes, kinds, and identifiers for people', () => {
  assert.equal(formatFileSize(512, 'en'), '512B');
  assert.equal(formatFileSize(1536, 'en'), '1.5 kB');
  assert.equal(formatFileSize(3 * MIB, 'en'), '3 MB');
  assert.equal(formatFileSize(0, 'en'), '0B');
  assert.deepEqual(
    ['image/png', 'image/gif', 'application/pdf', 'text/csv', 'application/json', 'application/zip', null]
      .map(attachmentKind),
    ['image', 'file', 'pdf', 'text', 'text', 'file', 'file'],
  );
  assert.equal(identifierName('list-dns_zones.v2'), 'List Dns Zones V2');
  assert.equal(identifierName(undefined), '');
});

test('admits only the exact file an authorization request discloses', () => {
  assert.deepEqual(parseFileDisclosure(DISCLOSED), DISCLOSED);
  assert.notEqual(parseFileDisclosure(DISCLOSED), DISCLOSED);
  for (const invalid of [
    null,
    { ...DISCLOSED, extra: true },
    { ...DISCLOSED, id: 'F'.repeat(32) },
    { ...DISCLOSED, name: '' },
    { ...DISCLOSED, name: ' padded.pdf' },
    { ...DISCLOSED, name: 'dir/file.pdf' },
    { ...DISCLOSED, name: 'dir\\file.pdf' },
    { ...DISCLOSED, name: '..' },
    { ...DISCLOSED, name: 'bell\u0007.pdf' },
    { ...DISCLOSED, name: `${'é'.repeat(128)}.pdf` },
    { ...DISCLOSED, media_type: 'Application/PDF' },
    { ...DISCLOSED, media_type: `application/${'x'.repeat(120)}` },
    { ...DISCLOSED, size: 0 },
    { ...DISCLOSED, size: 8 * MIB + 1 },
    { ...DISCLOSED, size: 1.5 },
    { ...DISCLOSED, sha256: 'z'.repeat(64) },
    { ...DISCLOSED, sha256: 7 },
    { ...DISCLOSED, id: 7 },
  ]) assert.throws(() => parseFileDisclosure(invalid), /response is invalid/, JSON.stringify(invalid));
});

test('admits only exact, ordered, bounded withheld Action identities', () => {
  assert.deepEqual(parseRestrictedActions(RESTRICTED), RESTRICTED);
  assert.deepEqual(parseRestrictedActions({ ...RESTRICTED, total: 40 }).total, 40);
  const many = Array.from({ length: 16 }, (_, index) => ({ assistant: 'shimpz-mail', action: `a${String(index).padStart(2, '0')}` }));
  assert.equal(parseRestrictedActions({ actions: many, total: 16 }).actions.length, 16);
  const wide = Array.from({ length: 16 }, (_, index) => ({
    assistant: `a${String(index).padStart(2, '0')}${'x'.repeat(77)}`,
    action: 'b'.repeat(60),
  }));
  for (const invalid of [
    null,
    { ...RESTRICTED, extra: 1 },
    { actions: [], total: 0 },
    { actions: [...many, { assistant: 'zz', action: 'zz' }], total: 17 },
    { ...RESTRICTED, total: 2 },
    { ...RESTRICTED, total: 2049 },
    { ...RESTRICTED, total: '3' },
    { actions: 'list', total: 1 },
    { actions: [RESTRICTED.actions[1], RESTRICTED.actions[0]], total: 2 },
    { actions: [RESTRICTED.actions[0], RESTRICTED.actions[0]], total: 2 },
    { actions: [{ assistant: 'shimpz-mail' }], total: 1 },
    { actions: [{ assistant: 'Shimpz', action: 'send' }], total: 1 },
    { actions: [{ assistant: 'a'.repeat(81), action: 'send' }], total: 1 },
    { actions: [{ assistant: 'shimpz-mail', action: 'Send' }], total: 1 },
    { actions: [{ assistant: 'shimpz-mail', action: 'a'.repeat(129) }], total: 1 },
    { actions: [{ assistant: 7, action: 'send' }], total: 1 },
    { actions: wide, total: 16 },
  ]) assert.throws(() => parseRestrictedActions(invalid), /response is invalid/, JSON.stringify(invalid));
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

const STORED = {
  team_id: 'marketing',
  file: { id: FILE_ID, name: 'notes.md', media_type: 'text/markdown', size: 12, sha256: SHA, created_at: 1_790_000_000 },
  used_bytes: 12,
  limit_bytes: 100,
  remaining_bytes: 88,
};

test('uploads one file as the single multipart part Admin admits, and keeps only its metadata', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const fetcher = async (path, init) => {
    calls.push([path, init]);
    return response(201, STORED);
  };
  const file = new File(['# notes'], 'notes.md', { type: 'text/markdown' });
  assert.deepEqual(await uploadTeamFile(fetcher, 'marketing', file, signal), {
    id: FILE_ID, name: 'notes.md', media_type: 'text/markdown', size: 12,
  });
  const [[path, init]] = calls;
  assert.equal(path, '/api/teams/marketing/files');
  assert.equal(init.method, 'POST');
  assert.equal(init.signal, signal);
  assert.deepEqual([...init.body.keys()], ['file']);
  assert.equal(init.body.get('file').name, 'notes.md');
});

test('explains an upload refusal by quota, size, or type, and fails closed on anything else', async () => {
  const file = new File(['x'], 'x.txt');
  const reasonOf = async (fetcher, teamId = 'marketing') => {
    try {
      await uploadTeamFile(fetcher, teamId, file);
    } catch (error) {
      assert.ok(error instanceof AttachmentUploadError);
      return error.reason;
    }
    assert.fail('the upload was admitted');
  };
  assert.equal(await reasonOf(async () => response(507, { detail: 'Team storage quota exceeded' })), 'quota');
  assert.equal(await reasonOf(async () => response(409, { code: 'storage-quota-exceeded' })), 'quota');
  assert.equal(await reasonOf(async () => response(413, { detail: 'file upload too large' })), 'too-large');
  for (const status of [400, 415, 422]) assert.equal(await reasonOf(async () => response(status, {})), 'invalid');
  assert.equal(await reasonOf(async () => response(502, {})), 'failed');
  assert.equal(await reasonOf(async () => { throw new TypeError('network'); }), 'failed');
  assert.equal(await reasonOf(async () => response(201, STORED), 'Marketing!'), 'failed');
  assert.equal(await reasonOf(null), 'failed');
  for (const body of [
    { ...STORED, team_id: 'sales' },
    { ...STORED, extra: true },
    { ...STORED, file: { ...STORED.file, id: 'x' } },
    { ...STORED, file: { ...STORED.file, name: 'a/b' } },
    { ...STORED, file: { ...STORED.file, media_type: 'TEXT' } },
    { ...STORED, file: { ...STORED.file, size: 25 * MIB + 1 } },
    { ...STORED, file: { ...STORED.file, sha256: 'x' } },
    { ...STORED, file: { ...STORED.file, extra: 1 } },
  ]) assert.equal(await reasonOf(async () => response(201, body)), 'failed', JSON.stringify(body));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    uploadTeamFile(async () => { throw new DOMException('aborted', 'AbortError'); }, 'marketing', file, controller.signal),
    (error) => error.name === 'AbortError',
  );
});

function humanChallenge(kind, extra = {}) {
  return {
    type: 'human-required',
    challenge_id: 'b'.repeat(32),
    expires_in: 300,
    assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
    action: { id: 'upload-file', summary: 'Upload the selected file.' },
    ...localizedChallenge({
      kind,
      ordinal: 0,
      title: 'Confirm this Action',
      description: 'The Action is waiting for your response.',
      fingerprint: 'c'.repeat(64),
      ...(kind === 'input:text' ? { label: 'Response', required: true, placeholder: '', min_length: 1, max_length: 80 } : {}),
    }),
    ...extra,
  };
}

test('a chat authorization request keeps the file it discloses; any other request with one fails closed', () => {
  for (const kind of ['approval', 'auth:password', 'auth:totp', 'auth:passkey']) {
    assert.deepEqual(parseChatEvent(humanChallenge(kind, { file: DISCLOSED }), 'team_1', 'Marketing').file, DISCLOSED);
  }
  assert.equal(Object.hasOwn(parseChatEvent(humanChallenge('approval'), 'team_1', 'Marketing'), 'file'), false);
  for (const invalid of [
    humanChallenge('input:text', { file: DISCLOSED }),
    humanChallenge('approval', { file: { ...DISCLOSED, size: 8 * MIB + 1 } }),
  ]) assert.throws(() => parseChatEvent(invalid, 'team_1', 'Marketing'), /response is invalid/);
});

test('a completed turn and its restored reply keep the Actions withheld for attachments', async () => {
  const done = { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: 'Read.', clarification: null };
  assert.deepEqual(
    parseChatEvent({ ...done, restricted_actions: RESTRICTED }, 'team_1', 'Marketing').restricted_actions,
    RESTRICTED,
  );
  assert.equal(Object.hasOwn(parseChatEvent(done, 'team_1', 'Marketing'), 'restricted_actions'), false);
  for (const restricted of [null, {}, { ...RESTRICTED, total: 1 }]) {
    assert.throws(
      () => parseChatEvent({ ...done, restricted_actions: restricted }, 'team_1', 'Marketing'),
      /response is invalid/,
    );
  }

  const reply = { id: `${'a'.repeat(32)}:reply`, kind: 'message', role: 'assistant', text: 'Read.', author: 'Marketing' };
  const history = (entry) => listChatHistory(async () => response(200, { entries: [entry], before: null }), 'marketing');
  assert.deepEqual((await history({ ...reply, restricted_actions: RESTRICTED })).entries[0].restricted_actions, RESTRICTED);
  for (const entry of [
    { ...reply, restricted_actions: { ...RESTRICTED, total: 0 } },
    { id: `${'a'.repeat(32)}:user`, kind: 'message', role: 'user', text: 'hi', restricted_actions: RESTRICTED },
  ]) await assert.rejects(history(entry), /history is invalid/);
});

test('both attachment guidance codes are admitted live and from history', async () => {
  for (const code of ['assistant-lifecycle-attachments', 'assistant-capability-attachments']) {
    const reply = 'Send that request again without attachments.';
    assert.equal(
      parseChatEvent({ type: 'assistant-guidance', team_id: 'team_1', code, reply }, 'team_1', 'Marketing').code,
      code,
    );
    const page = await listChatHistory(
      async () => response(200, { entries: [{ id: `${'a'.repeat(32)}:guidance`, kind: 'guidance', code, reply }], before: null }),
      'marketing',
    );
    assert.equal(page.entries[0].code, code);
  }
});
