import assert from 'node:assert/strict';
import test from 'node:test';

import { messages } from '../src/lib/messages.js';

test('localizes Team deletion success feedback in every Admin locale', () => {
  for (const [locale, localeMessages] of Object.entries(messages)) {
    assert.equal(
      typeof localeMessages.chatContext.deleteSuccessLabel,
      'string',
      `${locale}.chatContext.deleteSuccessLabel`,
    );
    assert.notEqual(localeMessages.chatContext.deleteSuccessLabel, '');
    assert.equal(
      typeof localeMessages.chatContext.deleteSuccessMessage,
      'string',
      `${locale}.chatContext.deleteSuccessMessage`,
    );
    assert.match(localeMessages.chatContext.deleteSuccessMessage, /\{team\}/);
  }
});
