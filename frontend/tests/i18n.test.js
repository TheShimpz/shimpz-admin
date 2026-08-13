import assert from 'node:assert/strict';
import test from 'node:test';

import { messages } from '../src/lib/messages.js';
import {
  assistantIntegrationLabels,
  assistantIntegrationMessageParts,
  localizedIntegrationList,
} from '../src/lib/assistantIntegrationMessages.js';
import { humanRequestContextParts } from '../src/lib/humanRequestMessages.js';

const expectedLocales = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];

function leafPaths(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      return leafPaths(child, path);
    }
    return [path];
  });
}

const retiredWorkloadTerms = {
  en: [/\bapps?\b/i, /\bdrivers?\b/i],
  pt: [/\bapps?\b/i, /\bdrivers?\b/i],
  es: [/\bapps?\b/i, /\bdrivers?\b/i],
  zh: [/应用/u, /驱动/u],
  fr: [/\bapps?\b/i, /\bdrivers?\b/i],
  de: [/\bapps?\b/i, /\bdrivers?\b/i],
  ja: [/アプリ/u, /ドライバ/u],
  ar: [/تطبيق/u, /برنامج تشغيل/u],
};

function workloadMessages(locale) {
  const copy = messages[locale];
  return [
    copy.auth.heroLead,
    copy.auth.teamReady,
    copy.teams.lead,
    copy.teams.createLead,
    copy.teams.emptyLead,
    copy.teams.destroyLead,
    copy.store.destinationLead,
  ];
}

test('every Admin locale implements the complete English message contract', () => {
  assert.deepEqual(Object.keys(messages), expectedLocales);
  const englishPaths = leafPaths(messages.en).sort();

  for (const locale of expectedLocales) {
    assert.deepEqual(leafPaths(messages[locale]).sort(), englishPaths, locale);
  }
});

test('Store destination copy scopes the listed Assistants to one Team', () => {
  assert.equal(
    messages.pt.store.destinationLead,
    'Os Assistants listados abaixo serão instalados somente no Time {team}.',
  );
});

test('Admin copy names installable Team workloads as Assistants', () => {
  for (const locale of expectedLocales) {
    for (const message of workloadMessages(locale)) {
      for (const retiredTerm of retiredWorkloadTerms[locale]) {
        assert.doesNotMatch(message, retiredTerm, `${locale}: ${message}`);
      }
    }
  }
});

test('human request context emphasizes only the Action and Assistant identity', () => {
  const challenge = {
    action: { id: 'change-dns-record' },
    assistant: { name: 'Shimpz Cloudflare', version: '0.4.1' },
    expires_in: 300,
  };
  for (const locale of expectedLocales) {
    const template = messages[locale].humanRequest.context;
    const parts = humanRequestContextParts(template, challenge, 42);
    assert.equal(parts.map(({ text }) => text).join(''), template
      .replace('{action}', challenge.action.id)
      .replace('{assistant}', challenge.assistant.name)
      .replace('{version}', challenge.assistant.version)
      .replace('{seconds}', '42'));
    assert.deepEqual(
      parts.filter(({ emphasized }) => emphasized).map(({ text }) => text),
      locale === 'zh' || locale === 'ja'
        ? [challenge.assistant.name, `v${challenge.assistant.version}`, challenge.action.id]
        : [challenge.action.id, challenge.assistant.name, `v${challenge.assistant.version}`],
    );
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
