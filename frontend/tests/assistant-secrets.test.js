import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ASSISTANT_SECRETS_COPY,
  assistantSecretsCopy,
} from '../src/lib/assistantSecretsCopy.js';

const dialogSource = readFileSync(
  new URL('../src/lib/AssistantSecretsDialog.svelte', import.meta.url),
  'utf8',
);
const drawerSource = readFileSync(
  new URL('../src/lib/AssistantSecretsDrawer.svelte', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(
  new URL('../src/routes/chat/+page.svelte', import.meta.url),
  'utf8',
);

const LOCALES = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];

test('localizes every Assistant secret surface without partial locale fallback', () => {
  const baseline = Object.keys(ASSISTANT_SECRETS_COPY.en).sort();
  assert.deepEqual(Object.keys(ASSISTANT_SECRETS_COPY).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) {
    const copy = assistantSecretsCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(), baseline);
    for (const value of Object.values(copy)) {
      assert.equal(typeof value, 'string');
      assert.ok(value.trim());
    }
  }
  assert.equal(assistantSecretsCopy('unsupported'), ASSISTANT_SECRETS_COPY.en);
});

test('keeps write-only drafts inside the modal and clears every terminal path', () => {
  assert.match(dialogSource, /let values = \$state\(\{\}\);/);
  assert.match(dialogSource, /function clearValues\(\) \{\s*values = \{\};\s*submitError = '';/);
  assert.match(dialogSource, /function close\(\)[\s\S]*clearValues\(\);\s*onclose\?\.\(\);/);
  assert.match(
    dialogSource,
    /try \{\s*onsubmit\?\.\(challenge\.challenge_id, outgoing\);\s*clearValues\(\);\s*\} catch \{\s*clearValues\(\);\s*submitError = copy\.submitFailed;/,
  );
  assert.match(dialogSource, /if \(challengeId === activeChallengeId\) return;[\s\S]*clearValues\(\);/);
  assert.match(dialogSource, /\$effect\(\(\) => \{\s*if \(!open\) clearValues\(\);/);
  assert.doesNotMatch(dialogSource, /localStorage|sessionStorage|indexedDB|fetch\(|console\.|\$teamContext/);
});

test('shows every missing secret with public Assistant, Power, and field details', () => {
  assert.match(dialogSource, /challenge\?\.requirements \?\? \[\][\s\S]*requirement\.secrets\.map/);
  assert.match(dialogSource, /\{#each challenge\?\.requirements \?\? \[\] as requirement/);
  assert.match(dialogSource, /\{#each requirement\.power_ids as powerId/);
  assert.match(dialogSource, /\{#each requirement\.secrets as secret/);
  assert.match(dialogSource, /\{requirement\.assistant_name\}[\s\S]*\{secret\.name\}[\s\S]*\{secret\.summary\}/);
  assert.match(dialogSource, /type="password"/);
  assert.match(
    dialogSource,
    /autocomplete="off"[\s\S]*data-1p-ignore[\s\S]*data-lpignore="true"[\s\S]*data-bwignore="true"[\s\S]*autocapitalize="none"[\s\S]*spellcheck="false"/,
  );
  assert.match(dialogSource, /assistant_id: field\.assistantId,[\s\S]*secret_id: field\.secretId,[\s\S]*value: values\[field\.key\]/);
  assert.doesNotMatch(dialogSource, /\{@html|type="text"|name="/i);
});

test('groups configured and missing metadata in a full-height right drawer', () => {
  assert.match(drawerSource, /\{#each assistants as assistant \(assistant\.id\)\}/);
  assert.match(drawerSource, /\{#each assistant\.secrets as secret \(secret\.id\)\}/);
  assert.match(drawerSource, /secret\.configured \? '✓' : '!'/);
  assert.match(drawerSource, /secret\.configured && secret\.mask[\s\S]*<code dir="ltr">\{secret\.mask\}<\/code>/);
  assert.match(drawerSource, /\{#if pending\}[\s\S]*onprovide\?\.\(\)[\s\S]*copy\.provide/);
  assert.match(drawerSource, /height: 100vh;\s*height: 100dvh;[\s\S]*max-height: 100dvh;/);
  assert.match(drawerSource, /inset-block: 0; inset-inline-end: 0;/);
  assert.doesNotMatch(drawerSource, /\{@html|type="password"|fetch\(/i);
});

test('syncs inventory, pauses for challenges, and submits only through WebSocket v3', () => {
  assert.match(pageSource, /active\.send\(JSON\.stringify\(createSyncFrame\(expectedTeamId\)\)\)/);
  assert.match(
    pageSource,
    /incoming = parseChatEvent\([\s\S]*if \(incoming\.type === 'secrets-required'\) \{\s*acceptSecretChallenge\(incoming\);\s*return;[\s\S]*if \(incoming\.type === 'secret-inventory'\) \{\s*acceptSecretInventory\(incoming\);\s*return;/,
  );
  assert.match(pageSource, /new Set\(\$teamContext\.selectedAssistantIds\)[\s\S]*incoming\.requirements\.some/);
  assert.match(
    pageSource,
    /new Set\(\$teamContext\.installedAssistants\.map[\s\S]*incoming\.assistants\.length !== installed\.size[\s\S]*incoming\.assistants\.some/,
  );
  assert.match(
    pageSource,
    /const frame = createSecretSubmitFrame\(teamId, challengeId, values\);[\s\S]*socket\.send\(JSON\.stringify\(frame\)\);/,
  );
  assert.match(pageSource, /secretChallenge = undefined;\s*secretsDialogOpen = false;/);
  assert.doesNotMatch(pageSource, /localStorage|sessionStorage|document\.cookie/);
});

test('cancels the suspended Team turn when the secret dialog is dismissed', () => {
  assert.match(
    pageSource,
    /function closeSecretsDialog\(\) \{\s*secretsDialogOpen = false;\s*secretChallenge = undefined;\s*stop\(\);\s*\}/,
  );
  assert.match(pageSource, /socket\.send\(JSON\.stringify\(createStopFrame\(teamId\)\)\);/);
  assert.match(
    pageSource,
    /<AssistantSecretsDialog[\s\S]*onclose=\{closeSecretsDialog\}[\s\S]*onsubmit=\{submitSecrets\}/,
  );
});

test('places one minimal secrets trigger beside Help and mounts both closed surfaces', () => {
  assert.match(
    pageSource,
    /class="secrets"[\s\S]*aria-controls="assistant-secrets-drawer"[\s\S]*<svg[\s\S]*class="help"[\s\S]*<button class="send"/,
  );
  assert.match(pageSource, /class:drawer-open=\{helpOpen \|\| secretsOpen \|\| accountsOpen\}/);
  assert.match(pageSource, /<AssistantSecretsDrawer[\s\S]*assistants=\{secretAssistants\}[\s\S]*pending=\{secretChallenge\}/);
  assert.match(pageSource, /<AssistantSecretsDialog[\s\S]*challenge=\{secretChallenge\}[\s\S]*onsubmit=\{submitSecrets\}/);
  assert.match(pageSource, /missing\.get\(secret\.id\)[\s\S]*configured: false, mask: null/);
  assert.match(pageSource, /function activateTeam\(nextTeamId\)[\s\S]*secretInventory = \[\];[\s\S]*secretInventoryReady = false;/);
});
