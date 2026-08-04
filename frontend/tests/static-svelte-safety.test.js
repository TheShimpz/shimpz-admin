import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

function svelteFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name, directory.href.endsWith('/') ? directory : new URL(`${directory.href}/`));
    if (entry.isDirectory()) return svelteFiles(path);
    return entry.name.endsWith('.svelte') ? [path] : [];
  });
}

test('static security: Svelte templates expose no raw HTML sink', () => {
  for (const path of svelteFiles(new URL('../src/', import.meta.url))) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /\{@html|\b(?:innerHTML|outerHTML)\b/, path.pathname);
  }
});

test('static presentation: Admin uses only shared interactive primitives', () => {
  const nativePresentationTag = /<(?:a|button|details|dialog|iframe|input|textarea)(?:\s|>)/;
  for (const path of svelteFiles(new URL('../src/', import.meta.url))) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, nativePresentationTag, path.pathname);
  }

  for (const retiredShadow of ['ShimpzBrand.svelte', 'AssistantIcon.svelte']) {
    assert.equal(existsSync(new URL(`../src/lib/${retiredShadow}`, import.meta.url)), false);
  }
});

test('static supply chain: shared frontend is pinned to one immutable commit', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const dependency = packageJson.dependencies['@shimpz/frontend'];
  const resolved = packageLock.packages['node_modules/@shimpz/frontend'].resolved;
  const immutableCodeload = /^https:\/\/codeload\.github\.com\/TheShimpz\/shimpz-frontend\/tar\.gz\/[0-9a-f]{40}$/;
  assert.match(dependency, immutableCodeload);
  assert.equal(resolved, dependency);
});

test('static presentation: every Admin surface composes the canonical layout primitives', () => {
  const contracts = new Map([
    ['../src/lib/AdminShell.svelte', ['WorkspaceShell']],
    ['../src/lib/AuthScreen.svelte', ['Card']],
    ['../src/lib/LocaleMenu.svelte', ['DropdownMenu']],
    ['../src/lib/NotificationCenter.svelte', ['Card', 'ScrollArea', 'Toolbar']],
    ['../src/lib/ProviderSetupGate.svelte', ['Card']],
    ['../src/routes/chat/+page.svelte', ['EmptyState', 'Message', 'Notice', 'ScrollArea', 'Toolbar']],
    ['../src/routes/assistants/+page.svelte', ['Card', 'EmptyState', 'PageIntro', 'Skeleton', 'Toolbar']],
  ]);
  for (const [path, primitives] of contracts) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const primitive of primitives) assert.match(source, new RegExp(`\\b${primitive}\\b`));
  }
});
