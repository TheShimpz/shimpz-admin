import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../src/lib/AdminShell.svelte', import.meta.url), 'utf8');

test('owns the complete Admin authentication lifecycle in the persistent root layout', () => {
  assert.match(layout, /import AdminShell from '\$lib\/AdminShell\.svelte'/);
  assert.match(layout, /import AuthScreen from '\$lib\/AuthScreen\.svelte'/);
  assert.match(layout, /fetch\('\/api\/session'/);
  assert.match(layout, /'\/api\/admin\/setup' : '\/api\/login'/);
  assert.match(layout, /fetch\('\/api\/logout'/);
  assert.match(layout, /import \{ clearTeamContext \} from '\$lib\/teamContext\.js'/);
  assert.match(layout, /finally \{\s*clearTeamContext\(\);/);
  assert.match(layout, /goto\('\/chat\/', \{ replaceState: true \}\)/);
  assert.match(layout, /<AdminShell \{active\} authenticated onLogout=\{logout\}>/);

  assert.doesNotMatch(page, /<script>/);
  assert.doesNotMatch(page, /AuthScreen|AdminShell|\/api\/session|\/api\/login/);
});

test('renders the global navigation and Team context only for authenticated users', () => {
  assert.match(shell, /import LocaleMenu from '\$lib\/LocaleMenu\.svelte'/);
  assert.match(shell, /import TeamSidebar from '\$lib\/TeamSidebar\.svelte'/);
  assert.match(shell, /<TeamSidebar \{active\} \/>/);
  assert.match(shell, /let \{ active = '', authenticated = false, onLogout, children \} = \$props\(\)/);
  assert.match(shell, /onclick=\{\(\) => onLogout\?\.\(\)\}/);
  assert.match(shell, /<ShimpzBrand href=\{authenticated \? '\/chat\/' : '\/'\} \/>/);
  assert.doesNotMatch(shell, /id: 'integrations'/);
  assert.doesNotMatch(shell, /id: 'capsules'|href: '\/capsules\/'/);
  assert.doesNotMatch(shell, /Local Space|local-status/);
  assert.doesNotMatch(shell, /<footer>/);

  const chat = shell.indexOf("{ id: 'chat'");
  const assistants = shell.indexOf("{ id: 'assistants'");
  assert.ok(chat !== -1 && chat < assistants);

  const nav = shell.indexOf('<nav class="primary-nav"');
  const headerEnd = shell.indexOf('</header>');
  const sidebar = shell.indexOf('<aside class="shell-sidebar">');
  const teamContext = shell.indexOf('<TeamSidebar {active} />');
  assert.ok(nav !== -1 && nav < headerEnd && headerEnd < sidebar && sidebar < teamContext);
});

test('keeps Chat viewport-bound while normal pages use a constrained responsive workspace', () => {
  assert.match(shell, /--admin-divider: var\(--border-strong\);/);
  assert.match(shell, /\.topbar \{[\s\S]*border-bottom: 1px solid var\(--admin-divider\);/);
  assert.match(shell, /\.shell-sidebar \{[\s\S]*border-inline-end: 1px solid var\(--admin-divider\);/);
  assert.match(shell, /'header header' auto[\s\S]*'sidebar main' minmax\(0, 1fr\)/);
  assert.match(shell, /minmax\(18rem, 20rem\) minmax\(0, 1fr\)/);
  assert.match(shell, /\.admin-shell\.chat-mode \{[\s\S]*height: 100dvh;[\s\S]*overflow: hidden;/);
  assert.match(shell, /\.chat-mode \.workspace \{[\s\S]*padding: 0;[\s\S]*overflow: hidden;/);
  assert.match(shell, /\.content-frame \{[\s\S]*width: min\(100%, 1180px\);/);
  assert.match(shell, /@media \(max-width: 760px\)[\s\S]*'sidebar' auto[\s\S]*minmax\(0, 1fr\)/);
  assert.match(shell, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(shell, /\.workspace \{[\s\S]*min-width: 0;[\s\S]*min-height: 0;/);
});

test('keeps the authenticated header and Chat rail usable on narrow or low-height screens', () => {
  assert.match(shell, /<div class="locale-full"><LocaleMenu \/><\/div>/);
  assert.match(shell, /<div class="locale-compact"><LocaleMenu compact \/><\/div>/);
  assert.match(shell, /@media \(max-width: 380px\)[\s\S]*\.locale-full \{\s*display: none;[\s\S]*\.locale-compact \{\s*display: block;/);
  assert.match(shell, /@media \(max-width: 760px\)[\s\S]*\.topbar-inner \{[\s\S]*row-gap: 0;/);
  assert.match(shell, /@media \(max-width: 760px\) and \(max-height: 600px\)/);
  assert.match(shell, /\.chat-mode \.team-sidebar-region \{\s*max-height: 5\.25rem;/);
  assert.match(shell, /\.chat-mode \.shell-sidebar \{\s*grid-template-rows: minmax\(0, 1fr\);/);
});
