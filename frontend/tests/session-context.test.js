import assert from 'node:assert/strict';
import test from 'node:test';

import { get } from 'svelte/store';

import {
  clearSessionContext,
  sessionContext,
  setSessionContext,
} from '../src/lib/sessionContext.js';

test('admits only Admin-projected OAuth completion modes', () => {
  for (const mode of ['automatic', 'code', null]) {
    setSessionContext({ oauth_completion_mode: mode });
    assert.equal(get(sessionContext).oauthCompletionMode, mode);
  }

  for (const mode of [undefined, '', 'popup', 1]) {
    assert.throws(
      () => setSessionContext({ oauth_completion_mode: mode }),
      /invalid OAuth completion mode/,
    );
  }

  clearSessionContext();
  assert.deepEqual(get(sessionContext), { oauthCompletionMode: null });
});
