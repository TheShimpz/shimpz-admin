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

test('Admin presentation uses only shared interactive primitives', () => {
  const nativePresentationTag = /<(?:a|button|details|dialog|iframe|input|textarea)(?:\s|>)/;
  for (const path of svelteFiles(new URL('../src/', import.meta.url))) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, nativePresentationTag, path.pathname);
  }

  for (const retiredShadow of ['ShimpzBrand.svelte', 'AssistantIcon.svelte']) {
    assert.equal(existsSync(new URL(`../src/lib/${retiredShadow}`, import.meta.url)), false);
  }
});
