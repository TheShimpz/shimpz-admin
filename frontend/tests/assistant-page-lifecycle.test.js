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

test('clears a stale sidebar result only after an install is confirmed', () => {
  assert.match(
    source,
    /async function confirmInstall\(\) \{[\s\S]*?const capsule = runningCapsules\.find\([\s\S]*?if \(!capsule\) return;\s+evaluation = null;\s+busy = true;[\s\S]*?await installAssistant\(fetch, capsule\.id, HELLO_ID\);/,
  );
  assert.doesNotMatch(
    source,
    /async function beginInstall\(assistantId\) \{[\s\S]*?evaluation = null;[\s\S]*?async function confirmInstall\(\)/,
  );
});

test('uses Team terminology without exposing direct Power controls', () => {
  assert.doesNotMatch(source, /'[^'\n]*(?:Capsule|Cápsula)[^'\n]*'/);
  assert.doesNotMatch(source, /invokeHelloPulse|\/powers\/|runHello/);
});

test('leaves initial Team loading and selection exclusively to the persistent sidebar', () => {
  assert.match(
    source,
    /import \{ refreshTeamInventory, teamContext \} from '\$lib\/teamContext\.js';/,
  );
  assert.doesNotMatch(source, /loadTeamContext|refreshLocalData|loadLocalData|selectTeam/);
  assert.doesNotMatch(source, /<select|capsule-context|capsule-picker|installed-inventory/);
  assert.match(source, /await waitForTeamContext\(\)/);
  assert.match(source, /queueMicrotask\(\(\) => unsubscribe\(\)\)/);
});

test('refreshes shared inventory after Store mutations without requiring Power metadata', () => {
  assert.match(source, /await refreshTeamInventory\(fetch\)/);
  assert.match(
    source,
    /helloAvailable = \$derived\(\$teamContext\.catalog\.some\(\(entry\) => entry\.id === HELLO_ID\)\)/,
  );
  assert.doesNotMatch(source, /declaresHello/);
});
