import assert from 'node:assert/strict';
import test from 'node:test';

import { messages } from '../src/lib/messages.js';

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
  ja: [/アプリ/u, /ドライバー/u],
  ar: [/التطبيق/u, /برنامج تشغيل/u],
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
  ];
}

test('every Admin locale implements the complete English message contract', () => {
  assert.deepEqual(Object.keys(messages), expectedLocales);
  const englishPaths = leafPaths(messages.en).sort();

  for (const locale of expectedLocales) {
    assert.deepEqual(leafPaths(messages[locale]).sort(), englishPaths, locale);
  }
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
