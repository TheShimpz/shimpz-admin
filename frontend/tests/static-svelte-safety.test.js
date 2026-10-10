import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
});

test('static supply chain: shared frontend is pinned to one immutable commit', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
  const dependency = packageJson.dependencies['@shimpz/frontend'];
  const immutableCodeload = /^https:\/\/codeload\.github\.com\/TheShimpz\/shimpz-frontend\/tar\.gz\/[0-9a-f]{40}$/;
  assert.match(dependency, immutableCodeload);
  // The lockfile resolves the package to exactly that tarball, with its integrity, and to nothing else.
  const resolutions = [...lock.matchAll(/^  '@shimpz\/frontend@[^']+':\n    resolution: \{([^}]*)\}$/gmu)].map(([, value]) => value);
  assert.equal(resolutions.length, 1);
  assert.match(resolutions[0], /\bintegrity: sha512-[A-Za-z0-9+/]+={0,2},/u);
  assert.equal(resolutions[0].match(/\btarball: (\S+)$/u)?.[1], dependency);
});
