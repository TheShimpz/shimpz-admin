import assert from 'node:assert/strict';
import test from 'node:test';

import { acknowledgeWebFile, parseBrowserTerminal } from '../src/lib/chat/attachments/files.js';
import { listChatHistory } from '../src/lib/chat/history.js';
import { parseChatEvent, parseReceipt } from '../src/lib/chat/protocol.js';
import { historyTurn, replyFields } from '../src/lib/chat/turns.js';
import { recorder, response } from './socketStub.js';

// The files a turn's Browser task downloaded from the web, as the reply carries them (ADR-0117 §7).
const FILE = { id: 'f'.repeat(32), name: 'edital.pdf', media_type: 'application/pdf', size: 2048 };
const BROWSER = { files: [FILE], lost: [{ name: 'anexo.zip', reason: 'over-limit' }], skipped: 1 };
const DONE = { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: 'O prazo é 30/11.', clarification: null };

test('a reply that ran the Browser keeps exactly its closed terminal', () => {
  assert.deepEqual(parseChatEvent({ ...DONE, browser: BROWSER }, 'team_1', 'Marketing').browser, BROWSER);
  assert.equal(Object.hasOwn(parseChatEvent(DONE, 'team_1', 'Marketing'), 'browser'), false);
  assert.deepEqual(parseBrowserTerminal({ files: [], lost: [], skipped: 0 }), { files: [], lost: [], skipped: 0 });
  for (const browser of [
    null,
    { files: [], lost: [] },
    { ...BROWSER, extra: 1 },
    { ...BROWSER, skipped: -1 },
    { ...BROWSER, skipped: 1001 },
    { ...BROWSER, files: Array.from({ length: 9 }, (_, index) => ({ ...FILE, id: String(index).repeat(32) })) },
    { ...BROWSER, files: [{ ...FILE, size: 0 }] },
    { ...BROWSER, files: [FILE, FILE] },
    { ...BROWSER, lost: [{ name: 'a', reason: 'gone' }] },
    { ...BROWSER, lost: [{ name: '', reason: 'empty' }] },
    { ...BROWSER, lost: [{ name: 'a\u0007', reason: 'empty' }] },
    { ...BROWSER, lost: Array.from({ length: 129 }, () => ({ name: 'a', reason: 'empty' })) },
  ]) {
    assert.throws(() => parseChatEvent({ ...DONE, browser }, 'team_1', 'Marketing'), /response is invalid/);
  }
});

test('a Browser task is one Team step of the receipt', () => {
  const receipt = [
    { segment: 0, seq: 1, origin: 'team', phase: 'browser', state: 'started' },
    { segment: 0, seq: 2, origin: 'team', phase: 'browser', state: 'finished', elapsed_ms: 41_000 },
  ];
  assert.deepEqual(parseReceipt(receipt), receipt);
});

test('a reloaded reply shows the files its Browser task kept, each from the web', async () => {
  const row = {
    id: `${'a'.repeat(32)}:reply`,
    created_at: '2026-10-17T12:00:00Z',
    kind: 'message',
    role: 'assistant',
    text: 'O prazo é 30/11.',
    author: 'Marketing',
    browser: BROWSER,
  };
  const { entries } = await listChatHistory(async () => response(200, { entries: [row], before: null }), 'team_1');
  assert.deepEqual(entries[0].browser, BROWSER);
  const turn = historyTurn(entries[0], 'Marketing', 'row-1', {});
  assert.deepEqual(turn.webFiles, [{
    key: FILE.id, id: FILE.id, name: FILE.name, mediaType: FILE.media_type, size: FILE.size, kind: 'pdf', note: '',
  }]);
  // A turn that kept nothing shows no card.
  assert.equal(Object.hasOwn(replyFields({ browser: { files: [], lost: [], skipped: 0 } }), 'webFiles'), false);
  await assert.rejects(
    listChatHistory(async () => response(200, { entries: [{ ...row, browser: {} }], before: null }), 'team_1'),
    /history is invalid/,
  );
});

test('an acknowledgement names exactly its file and admits only Team’s exact answer', async () => {
  const accepted = recorder(200, { file_id: FILE.id, acknowledged: true });
  await acknowledgeWebFile('team_1', FILE.id, accepted.call);
  assert.deepEqual(accepted.calls, [{ method: 'files.acknowledge', params: { team_id: 'team_1', file_id: FILE.id } }]);
  for (const [status, body] of [
    [403, { detail: 'file acknowledgement unavailable', code: 'file-acknowledgement-required' }],
    [200, { file_id: 'e'.repeat(32), acknowledged: true }],
    [200, { file_id: FILE.id, acknowledged: false }],
    [200, { file_id: FILE.id, acknowledged: true, extra: 1 }],
  ]) {
    await assert.rejects(acknowledgeWebFile('team_1', FILE.id, recorder(status, body).call), /acknowledgement failed/);
  }
  for (const [teamId, fileId] of [['', FILE.id], ['team_1', 'x'], ['team_1', 7]]) {
    const refused = recorder(200, {});
    await assert.rejects(acknowledgeWebFile(teamId, fileId, refused.call), /acknowledgement is invalid/);
    assert.deepEqual(refused.calls, []);
  }
});
