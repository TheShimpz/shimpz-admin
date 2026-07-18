import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/routes/capsules/+page.svelte', import.meta.url), 'utf8');

test('renders Team management inside the centralized Admin shell', () => {
  assert.doesNotMatch(source, /AdminShell|LocaleMenu|shellActions|\/api\/logout/);
  assert.doesNotMatch(source, /class="logout"|\.logout\b/);
});

test('refreshes shared Team context after successful mutations without changing their outcome', () => {
  assert.match(source, /import \{ refreshTeams \} from '\$lib\/teamContext\.js'/);
  assert.match(
    source,
    /async function refreshSharedTeamContext\(preferredId = ''\) \{\s*try \{\s*await refreshTeams\(fetch, preferredId\);\s*\} catch \{/,
  );
  assert.match(
    source,
    /const created = await response\.json\(\)\.catch\(\(\) => \(\{\}\)\);[\s\S]*await refreshSharedTeamContext\(typeof created\.id === 'string' \? created\.id : ''\);/,
  );
  assert.match(
    source,
    /method: 'DELETE',[\s\S]*if \(!response\.ok\)[\s\S]*deleteDialog\?\.close\(\);[\s\S]*await refreshSharedTeamContext\(\);/,
  );

  const directRefreshes = source.match(/await refreshTeams\(/g) ?? [];
  assert.equal(directRefreshes.length, 1);
});
