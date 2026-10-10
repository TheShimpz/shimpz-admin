import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { LOCALES } from '../src/lib/locales.js';
import { messages } from '../src/lib/messages.js';
import {
  assistantIntegrationLabels,
  assistantIntegrationMessageParts,
  localizedIntegrationList,
} from '../src/lib/assistantIntegrationMessages.js';

const expectedLocales = LOCALES.map(({ code }) => code);

function leafPaths(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      return leafPaths(child, path);
    }
    return [path];
  });
}

test("Admin's interface languages are exactly the Team protocol's chat locales", () => {
  // The protocol mirror is the authority (ADR-0090): a chat turn may name only these languages.
  const source = readFileSync(new URL('../../backend/protocol/http/v1/payload.py', import.meta.url), 'utf8');
  const locales = source.match(/^CHAT_LOCALES = frozenset\(\{([^}]*)\}\)$/mu)[1].match(/[a-z]{2}/gu);
  assert.deepEqual([...expectedLocales].sort(), [...locales].sort());
  assert.equal(new Set(expectedLocales).size, expectedLocales.length);
});

test('every Admin locale implements the complete English message contract', () => {
  assert.deepEqual(Object.keys(messages), expectedLocales);
  const englishPaths = leafPaths(messages.en).sort();

  for (const locale of expectedLocales) {
    assert.deepEqual(leafPaths(messages[locale]).sort(), englishPaths, locale);
  }
});

function leafValue(value, path) {
  return path.split('.').reduce((node, key) => node[key], value);
}

test('every Admin message is non-empty and keeps the English placeholders in every locale', () => {
  const placeholders = (text) => [...text.matchAll(/\{[a-zA-Z]+\}/g)].map((match) => match[0]).sort();
  for (const path of leafPaths(messages.en)) {
    const english = leafValue(messages.en, path);
    if (typeof english !== 'string') continue;
    for (const locale of expectedLocales) {
      const localized = leafValue(messages[locale], path);
      assert.equal(typeof localized, 'string', `${locale}.${path}`);
      assert.notEqual(localized.trim(), '', `${locale}.${path}`);
      assert.deepEqual(placeholders(localized), placeholders(english), `${locale}.${path}`);
    }
  }
});

test('integration confirmation emphasizes every dynamic authorization identity', () => {
  const values = {
    actions: 'list-zones',
    assistants: 'Shimpz Cloudflare',
    provider: 'Cloudflare',
    providers: 'Cloudflare and GitHub',
  };
  for (const locale of expectedLocales) {
    for (const key of ['dialogTitle', 'dialogContextSingle', 'dialogContextMultiple']) {
      const template = messages[locale].assistantIntegrations[key];
      const parts = assistantIntegrationMessageParts(template, values);
      assert.equal(parts.map(({ text }) => text).join(''), template
        .replaceAll('{actions}', values.actions)
        .replaceAll('{assistants}', values.assistants)
        .replaceAll('{provider}', values.provider)
        .replaceAll('{providers}', values.providers));
      assert.deepEqual(parts.filter(({ emphasized }) => emphasized).map(({ text }) => text), [
        ...template.matchAll(/\{(actions|assistants|provider|providers)\}/gu),
      ].map((match) => values[match[1]]));
    }
  }
});

test('integration confirmation formats unique dynamic lists for the active locale', () => {
  assert.equal(localizedIntegrationList(['Cloudflare', 'Cloudflare'], 'en'), 'Cloudflare');
  assert.equal(localizedIntegrationList(['Cloudflare', 'GitHub'], 'en'), 'Cloudflare and GitHub');
  assert.equal(localizedIntegrationList([], 'pt'), '');
});

test('integration confirmation identifies each Assistant by its installed version', () => {
  const requirements = [
    { assistant_id: 'cloudflare-one', assistant_name: 'Shimpz Cloudflare' },
    { assistant_id: 'cloudflare-one', assistant_name: 'Shimpz Cloudflare' },
    { assistant_id: 'cloudflare-two', assistant_name: 'Shimpz Cloudflare' },
    { assistant_id: 'local-only', assistant_name: 'Local Assistant' },
  ];
  const installed = [
    { assistant: 'cloudflare-one', assistant_version: '0.4.1' },
    { assistant: 'cloudflare-two', assistant_version: '0.4.1' },
  ];

  assert.deepEqual(assistantIntegrationLabels(requirements, installed), [
    'Shimpz Cloudflare v0.4.1 (cloudflare-one)',
    'Shimpz Cloudflare v0.4.1 (cloudflare-two)',
    'Local Assistant',
  ]);
});
