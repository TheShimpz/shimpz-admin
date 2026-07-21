import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ASSISTANT_ACCOUNTS_COPY,
  assistantAccountProviderLabel,
  assistantAccountsCopy,
} from '../src/lib/assistantAccountsCopy.js';

const dialogSource = readFileSync(
  new URL('../src/lib/AssistantAccountsDialog.svelte', import.meta.url),
  'utf8',
);
const drawerSource = readFileSync(
  new URL('../src/lib/AssistantAccountsDrawer.svelte', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(
  new URL('../src/routes/chat/+page.svelte', import.meta.url),
  'utf8',
);
const LOCALES = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];

test('localizes every Assistant account surface without partial fallback', () => {
  const baseline = Object.keys(ASSISTANT_ACCOUNTS_COPY.en).sort();
  assert.deepEqual(Object.keys(ASSISTANT_ACCOUNTS_COPY).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) {
    const copy = assistantAccountsCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(), baseline);
    assert.ok(Object.values(copy).every((value) => typeof value === 'string' && value.trim()));
  }
  assert.equal(assistantAccountsCopy('unsupported'), ASSISTANT_ACCOUNTS_COPY.en);
});

test('names the exact Account provider across authorization copy', () => {
  const copy = assistantAccountsCopy('en', 'cloudflare');
  assert.equal(copy.authorize, 'Continue to Cloudflare');
  assert.equal(copy.authorizing, 'Opening Cloudflare…');
  assert.match(copy.dialogLead, /directly on Cloudflare\.$/);
  assert.equal(assistantAccountProviderLabel('x'), 'X');
  assert.equal(assistantAccountProviderLabel('google-workspace'), 'Google Workspace');
  assert.equal(assistantAccountProviderLabel('Cloudflare'), '');
  assert.match(dialogSource, /assistantAccountsCopy\(\$locale, provider\)/);
  assert.match(dialogSource, /\{providerLabel\}/);
  assert.match(drawerSource, /assistantAccountsCopy\(\$locale, provider\)/);
  assert.match(drawerSource, /assistantAccountProviderLabel\(account\.provider\)/);
});

test('explains every requested account, permission, and Power without collecting values', () => {
  assert.match(dialogSource, /challenge\?\.requirements \?\? \[\] as requirement/);
  assert.match(dialogSource, /\{requirement\.assistant_name\}[\s\S]*\{requirement\.name\}[\s\S]*\{requirement\.summary\}/);
  assert.match(dialogSource, /\{#each requirement\.scopes as scope/);
  assert.match(dialogSource, /\{#each requirement\.powers as power/);
  assert.match(dialogSource, /\{power\.name\}[\s\S]*\{power\.summary\}/);
  assert.match(dialogSource, /onauthorize\?\.\(challenge\.challenge_id\)/);
  assert.doesNotMatch(dialogSource, /<input|<textarea|\{@html|fetch\(|localStorage|sessionStorage/i);
  assert.doesNotMatch(dialogSource, /token|secret|credential|code_verifier|client_id/i);
});

test('shows status-only accounts grouped by Assistant in a full-height drawer', () => {
  assert.match(drawerSource, /for \(const account of accounts\)/);
  assert.match(drawerSource, /\{#each groups as assistant \(assistant\.id\)\}/);
  assert.match(drawerSource, /\{#each assistant\.accounts as account \(account\.id\)\}/);
  assert.match(drawerSource, /accountLabel\(account\.account\)/);
  assert.match(drawerSource, /account\.scopes\.join\('\s*·\s*'\)/);
  assert.match(drawerSource, /connect\(pending\.challenge_id\)/);
  assert.match(drawerSource, /await onconnect\?\.\(challengeId\)/);
  assert.match(drawerSource, /ondisconnect\?\.\(account\)/);
  assert.match(drawerSource, /height: 100vh; height: 100dvh;[\s\S]*max-height: 100dvh;/);
  assert.doesNotMatch(drawerSource, /<input|<textarea|\{@html|fetch\(/i);
  assert.doesNotMatch(drawerSource, /token|secret|credential|code_verifier|client_id/i);
});

test('pauses chat for account challenges and leaves authorization to the controller', () => {
  assert.match(
    pageSource,
    /incoming\.type === 'accounts-required'[\s\S]*acceptAccountChallenge\(incoming\)/,
  );
  assert.match(
    pageSource,
    /function acceptAccountChallenge\(incoming\)[\s\S]*new Set\(\$teamContext\.selectedAssistantIds\)[\s\S]*busy = true;/,
  );
  assert.match(
    pageSource,
    /authorizeAssistantAccount\(fetch, teamId, challengeId\)[\s\S]*location\.assign\(authorization\.authorization_url\)/,
  );
  assert.doesNotMatch(pageSource, /window\.open\(authorization|target=['"]_blank/i);
  assert.match(pageSource, /disconnectAssistantAccount\(fetch, teamId, account\.assistant_id, account\.id\)/);
  assert.match(pageSource, /listAssistantAccounts\(fetch, teamId\)/);
});

test('clears account state on Team and socket boundaries and mounts both closed surfaces', () => {
  assert.match(pageSource, /function closeSocket\(\)[\s\S]*accountChallenge = undefined;[\s\S]*accountsReady = false;/);
  assert.match(pageSource, /function activateTeam\(nextTeamId\)[\s\S]*accounts = \[\];[\s\S]*accountsReady = false;/);
  assert.match(pageSource, /class:drawer-open=\{helpOpen \|\| secretsOpen \|\| accountsOpen\}/);
  assert.match(pageSource, /aria-controls="assistant-accounts-drawer"/);
  assert.match(pageSource, /<AssistantAccountsDrawer[\s\S]*pending=\{accountChallenge\}[\s\S]*ondisconnect=\{disconnectAccount\}/);
  assert.match(pageSource, /<AssistantAccountsDialog[\s\S]*challenge=\{accountChallenge\}[\s\S]*onauthorize=\{authorizeAccount\}/);
});
