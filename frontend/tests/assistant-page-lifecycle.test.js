import assert from 'node:assert/strict';
import test from 'node:test';

import { messages } from '../src/lib/messages.js';

test('localizes Assistant lifecycle feedback in every Admin locale', () => {
  const keys = [
    'assistantInstalledLabel',
    'assistantInstalledMessage',
    'assistantUninstallTitle',
    'assistantUninstallLead',
    'assistantUninstallConfirm',
    'assistantUninstalling',
    'assistantActionCancel',
    'assistantActionRetry',
    'assistantDestinationTeam',
    'assistantUninstalledLabel',
    'assistantUninstalledMessage',
    'assistantUninstallFailureTitle',
    'assistantUninstallFailureLead',
  ];
  for (const [locale, localeMessages] of Object.entries(messages)) {
    for (const key of keys) {
      assert.equal(typeof localeMessages.store[key], 'string', `${locale}.store.${key}`);
      assert.notEqual(localeMessages.store[key], '', `${locale}.store.${key}`);
    }
  }
});
