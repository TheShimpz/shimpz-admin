import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { messages } from '../src/lib/messages.js';

const source = readFileSync(
  new URL('../src/routes/assistants/+page.svelte', import.meta.url),
  'utf8',
);
const dialog = readFileSync(
  new URL('../src/lib/AssistantActionDialog.svelte', import.meta.url),
  'utf8',
);

test('holds each Store admission through the shared action modal', () => {
  assert.match(source, /storeActionLatch\.acquire\('install'\)/);
  assert.match(source, /storeActionLatch\.acquire\('uninstall'\)/);
  assert.match(source, /import AssistantActionDialog from '\$lib\/AssistantActionDialog\.svelte';/);
  assert.match(source, /<AssistantActionDialog\s+bind:open=\{dialogOpen\}/);
  assert.match(source, /function closeAssistantDialog\(\) \{\s+if \(busy\) return;/);
  assert.match(source, /storeActionLatch\.release\(action\)/);
  assert.match(dialog, /open = \$bindable\(false\)/);
  assert.match(dialog, /<dialog[^>]+oncancel=\{cancel\}/);
  assert.match(dialog, /if \(!busy\) oncancel\(\)/);
});

test('pins Store protocol while preserving the independent reload counter', () => {
  assert.match(
    source,
    /\/embed\?store-protocol=\$\{STORE_LIFECYCLE_PROTOCOL_VERSION\}&admin-frame=\$\{frameReload\}/,
  );
});

test('closes successful install admission and publishes friendly transient feedback', () => {
  assert.match(source, /import \{ showAdminNotice \} from '\$lib\/adminNotice\.js';/);
  assert.match(
    source,
    /async function confirmInstall\(\)[\s\S]*?await refreshInstalled\(team\.id\);\s+const assistantName = pendingAssistantName;\s+finishAssistantDialog\(\);\s+showAdminNotice\(\{\s+tone: 'success',\s+label: \$t\('store\.assistantInstalledLabel'\),\s+message: \$t\('store\.assistantInstalledMessage'/,
  );
});

test('opens uninstall in the shared modal without native confirm and reports success globally', () => {
  assert.doesNotMatch(source, /window\.confirm|\bconfirm\(/);
  assert.match(
    source,
    /function beginStoreUninstall\(assistantId\)[\s\S]*?dialogAction = 'uninstall';[\s\S]*?dialogMode = 'uninstall';\s+showAssistantDialog\(\);/,
  );
  assert.match(
    source,
    /async function confirmUninstall\(\)[\s\S]*?await refreshInstalled\(team\.id\);\s+finishAssistantDialog\(\);\s+showAdminNotice\(\{\s+tone: 'success',\s+label: \$t\('store\.assistantUninstalledLabel'\),\s+message: \$t\('store\.assistantUninstalledMessage'/,
  );
  assert.match(source, /catch \(error\) \{[\s\S]*?dialogError = failure;\s+dialogMode = 'error';/);
  assert.match(dialog, /class:dialog-danger=\{destructive\}/);
});

test('localizes the new Assistant lifecycle feedback in every Admin locale', () => {
  const keys = [
    'assistantInstalledLabel',
    'assistantInstalledMessage',
    'assistantUninstallTitle',
    'assistantUninstallLead',
    'assistantUninstallConfirm',
    'assistantUninstalling',
    'assistantActionCancel',
    'assistantActionRetry',
    'assistantDestinationTeam',
    'assistantUninstalledLabel',
    'assistantUninstalledMessage',
    'assistantUninstallFailureTitle',
    'assistantUninstallFailureLead',
  ];
  for (const [locale, localeMessages] of Object.entries(messages)) {
    for (const key of keys) {
      assert.equal(typeof localeMessages.store[key], 'string', `${locale}.store.${key}`);
      assert.notEqual(localeMessages.store[key], '', `${locale}.store.${key}`);
    }
  }
});

test('offers an immersive Team destination chooser above the Store', () => {
  assert.match(
    source,
    /<header class="store-destination"[^>]*>[\s\S]*<button[\s\S]*class="destination-trigger"[\s\S]*aria-haspopup="dialog"[\s\S]*activeTeamRecord\?\.name[\s\S]*\$t\('store\.destinationLead', \{ team: activeTeamRecord\.name \}\)/,
  );
  assert.match(source, /<dialog[\s\S]*id="store-team-destination-dialog"[\s\S]*aria-labelledby="store-team-destination-title"/);
  assert.match(source, /\{#each runningTeams as team \(team\.id\)\}[\s\S]*chooseDestinationTeam\(team\.id\)[\s\S]*aria-current=/);
  assert.match(source, /<dialog[\s\S]*bind:this=\{createTeamDialog\}[\s\S]*<form class="destination-dialog-panel" onsubmit=\{submitDestinationTeam\}>/);
  assert.doesNotMatch(source, /<select/);
  assert.ok(source.indexOf('class="store-destination"') < source.indexOf('class="store-frame"'));
  for (const [locale, localeMessages] of Object.entries(messages)) {
    for (const key of ['destinationKicker', 'destinationLead']) {
      assert.equal(typeof localeMessages.store[key], 'string', `${locale}.store.${key}`);
      assert.notEqual(localeMessages.store[key], '', `${locale}.store.${key}`);
    }
  }
});

test('uses Team terminology without exposing direct Power controls', () => {
  assert.match(source, /Team/);
  assert.doesNotMatch(source, /invokeHelloPulse|\/powers\/|runHello/);
});

test('leaves initial Team loading in the sidebar while safely syncing Store destination changes', () => {
  assert.match(
    source,
    /import \{ createTeam, refreshTeamInventory, teamContext \} from '\$lib\/teamContext\.js';/,
  );
  assert.doesNotMatch(source, /loadTeamContext|refreshLocalData|loadLocalData/);
  assert.doesNotMatch(source, /<select|team-context|team-picker|installed-inventory/);
  assert.match(source, /next\.searchParams\.set\('team', teamId\)/);
  assert.match(source, /goto\(destinationUrl\(teamId\), \{ replaceState: true, keepFocus: true, noScroll: true \}\)/);
  assert.match(source, /const created = await createTeam\(fetch, newTeamName\)/);
  assert.match(source, /goto\(destinationUrl\(created\.id\), \{ replaceState: true, keepFocus: true, noScroll: true \}\)/);
  assert.match(source, /await waitForTeamContext\(\)/);
  assert.match(source, /queueMicrotask\(\(\) => unsubscribe\(\)\)/);
  assert.doesNotMatch(source, /href="\/teams\/"/);
  for (const code of ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar']) {
    assert.match(source, new RegExp(`\\b${code}: \\{`));
  }
});

test('refreshes shared inventory after Store mutations without requiring Power metadata', () => {
  assert.match(source, /await refreshTeamInventory\(fetch\)/);
  assert.match(
    source,
    /pendingAssistantAvailable = \$derived\([\s\S]*?RELEASED_STORE_ASSISTANT_IDS\.includes\(pendingAssistant\)[\s\S]*?entry\.id === pendingAssistant/,
  );
  assert.doesNotMatch(source, /declaresHello/);
});
