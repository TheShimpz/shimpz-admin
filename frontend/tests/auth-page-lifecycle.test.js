import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../src/lib/AdminShell.svelte', import.meta.url), 'utf8');

test('sends authenticated setup and login flows directly to Chat', () => {
  assert.match(page, /location\.replace\('\/chat\/'\)/);
  assert.match(page, /else enterAdmin\(\)/);
  assert.doesNotMatch(page, /\/api\/integrations/);
  assert.doesNotMatch(page, /IntegrationDrawer/);
});

test('does not expose the retired Integrations workspace in Admin navigation', () => {
  assert.doesNotMatch(shell, /id: 'integrations'/);
  assert.doesNotMatch(shell, /href: '\/'/);
  assert.match(shell, /\{ id: 'chat', label: 'chat\.nav', href: '\/chat\/' \}/);
});
