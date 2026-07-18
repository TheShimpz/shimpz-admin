import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/routes/assistants/+page.svelte', import.meta.url),
  'utf8',
);

test('holds Store admission through modal close and intercepts Escape while busy', () => {
  assert.match(source, /storeActionLatch\.acquire\('install'\)/);
  assert.match(source, /storeActionLatch\.acquire\('uninstall'\)/);
  assert.match(source, /function closeInstallDialog\(\) \{\s+if \(busy\) return;/);
  assert.match(source, /function cancelInstallDialog\(event\) \{\s+event\.preventDefault\(\);\s+if \(busy\) return;/);
  assert.match(source, /<dialog[^>]+oncancel=\{cancelInstallDialog\}/);
  assert.match(source, /finally \{\s+storeActionLatch\.release\('uninstall'\);/);
});

test('pins Store protocol while preserving the independent reload counter', () => {
  assert.match(
    source,
    /\/embed\?store-protocol=\$\{STORE_LIFECYCLE_PROTOCOL_VERSION\}&admin-frame=\$\{frameReload\}/,
  );
});

test('publishes transient Store feedback through the global Admin notice', () => {
  assert.match(source, /import \{ showAdminNotice \} from '\$lib\/adminNotice\.js';/);
  assert.match(
    source,
    /await refreshInstalled\(team\.id\);\s+showAdminNotice\(\{\s+tone: 'success',\s+label: copy\.uninstall,\s+message: format\(copy\.removed,/,
  );
  assert.match(
    source,
    /catch \(error\) \{[\s\S]*?await refreshInstalled\(team\.id\);\s+showAdminNotice\(\{\s+tone: 'error',\s+label: copy\.failureTitle,\s+message: failure,/,
  );
  assert.doesNotMatch(source, /let (?:actionError|evaluation)|class="(?:action-error|sidebar-result)"/);
  assert.doesNotMatch(
    source,
    /async function confirmInstall\(\)[\s\S]*?showAdminNotice\([\s\S]*?async function runStoreInstall/,
  );
});

test('uses Team terminology without exposing direct Power controls', () => {
  assert.match(source, /Team/);
  assert.doesNotMatch(source, /invokeHelloPulse|\/powers\/|runHello/);
});

test('leaves initial Team loading and selection exclusively to the persistent sidebar', () => {
  assert.match(
    source,
    /import \{ refreshTeamInventory, teamContext \} from '\$lib\/teamContext\.js';/,
  );
  assert.doesNotMatch(source, /loadTeamContext|refreshLocalData|loadLocalData|selectTeam/);
  assert.doesNotMatch(source, /<select|team-context|team-picker|installed-inventory/);
  assert.match(source, /await waitForTeamContext\(\)/);
  assert.match(source, /queueMicrotask\(\(\) => unsubscribe\(\)\)/);
  assert.doesNotMatch(source, /href="\/teams\/"/);
  assert.match(source, /createFromSidebar: 'Close this dialog and create a Team from the sidebar\.'/);
});

test('refreshes shared inventory after Store mutations without requiring Power metadata', () => {
  assert.match(source, /await refreshTeamInventory\(fetch\)/);
  assert.match(
    source,
    /helloAvailable = \$derived\(\$teamContext\.catalog\.some\(\(entry\) => entry\.id === HELLO_ID\)\)/,
  );
  assert.doesNotMatch(source, /declaresHello/);
});
