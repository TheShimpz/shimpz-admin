import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ASSISTANT_APPROVALS_COPY,
  assistantApprovalsCopy,
} from '../src/lib/assistantApprovalsCopy.js';

const dialogSource = readFileSync(
  new URL('../src/lib/AssistantApprovalDialog.svelte', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(
  new URL('../src/routes/chat/+page.svelte', import.meta.url),
  'utf8',
);
const LOCALES = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];

test('localizes every explicit Power approval surface', () => {
  const baseline = Object.keys(ASSISTANT_APPROVALS_COPY.en).sort();
  assert.deepEqual(Object.keys(ASSISTANT_APPROVALS_COPY).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) {
    const copy = assistantApprovalsCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(), baseline);
    assert.ok(Object.values(copy).every((value) => typeof value === 'string' && value.trim()));
  }
  assert.equal(assistantApprovalsCopy('unsupported'), ASSISTANT_APPROVALS_COPY.en);
});

test('shows every exact operation without rendering trusted HTML or hidden authority', () => {
  assert.match(dialogSource, /challenge\?\.requirements \?\? \[\] as requirement, index/);
  assert.match(dialogSource, /\{requirement\.assistant_name\}[\s\S]*\{requirement\.power_id\}/);
  assert.match(dialogSource, /\{requirement\.power_summary\}/);
  assert.match(dialogSource, /requirement\.approval === 'once' \? copy\.once : copy\.always/);
  assert.match(dialogSource, /JSON\.stringify\(requirement\.input, null, 2\)/);
  assert.doesNotMatch(dialogSource, /\{@html|fetch\(|localStorage|sessionStorage|secret/i);
});

test('requires an explicit click and uses stop as the only cancellation path', () => {
  assert.match(dialogSource, /onclick=\{\(\) => onapprove\?\.\(\)\}/);
  assert.match(dialogSource, /oncancel=\{cancel\}/);
  assert.match(pageSource, /createApprovalSubmitFrame\(teamId, approvalChallenge\.challenge_id\)/);
  assert.match(
    pageSource,
    /function cancelApproval\(\) \{\s*approvalDialogOpen = false;\s*approvalChallenge = undefined;\s*stop\(\);/,
  );
  assert.match(pageSource, /incoming\.type === 'approval-required'[\s\S]*acceptApprovalChallenge\(incoming\)/);
  assert.match(pageSource, /new Set\(\$teamContext\.selectedAssistantIds\)[\s\S]*unexpected Assistant approval requirement/);
});

test('keeps modal actions full width and clears approval state on lifecycle boundaries', () => {
  assert.match(dialogSource, /footer button \{ width: 50%;[\s\S]*flex: 1 1 0;/);
  assert.match(pageSource, /function closeSocket\(\)[\s\S]*approvalChallenge = undefined;\s*approvalDialogOpen = false;/);
  assert.match(pageSource, /function activateTeam\(nextTeamId\)[\s\S]*approvalDialogOpen = false;\s*approvalChallenge = undefined;/);
  assert.match(pageSource, /<AssistantApprovalDialog[\s\S]*oncancel=\{cancelApproval\}[\s\S]*onapprove=\{submitApproval\}/);
});
