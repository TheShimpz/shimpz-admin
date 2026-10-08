import assert from 'node:assert/strict';
import test from 'node:test';

import { promptHistoryStep } from '../src/lib/promptHistory.js';

const prompts = ['First prompt', 'Second prompt'];
const up = { key: 'ArrowUp' };
const down = { key: 'ArrowDown' };

// Each key press as the composer applies it: the next index and draft, and whether the key showed a recalled prompt.
function press(key, state) {
  const step = promptHistoryStep(key, { prompts, ...state });
  return [step.handled, step.index, step.draft];
}

test('ArrowUp from an empty composer recalls the newest prompt and walks back to the oldest, where it stays', () => {
  assert.deepEqual(press(up, { index: -1, draft: '' }), [true, 0, 'Second prompt']);
  assert.deepEqual(press(up, { index: 0, draft: 'Second prompt' }), [true, 1, 'First prompt']);
  assert.deepEqual(press(up, { index: 1, draft: 'First prompt' }), [true, 1, 'First prompt']);
});

test('ArrowDown walks forward to an empty composer, and an empty composer of its own never moves', () => {
  assert.deepEqual(press(down, { index: 1, draft: 'First prompt' }), [true, 0, 'Second prompt']);
  assert.deepEqual(press(down, { index: 0, draft: 'Second prompt' }), [true, -1, '']);
  assert.deepEqual(press(down, { index: -1, draft: '' }), [false, -1, '']);
});

test("a draft of the person's own is never replaced, and an edited recalled prompt leaves the history", () => {
  assert.deepEqual(press(up, { index: -1, draft: 'Manual draft' }), [false, -1, 'Manual draft']);
  assert.deepEqual(press(down, { index: -1, draft: 'Manual draft' }), [false, -1, 'Manual draft']);
  assert.deepEqual(press(up, { index: 0, draft: 'Second prompt, edited' }), [false, -1, 'Second prompt, edited']);
  assert.deepEqual(press(down, { index: 1, draft: 'First prompt, edited' }), [false, -1, 'First prompt, edited']);
});

test('a key with a modifier, during an input method composition, or other than the arrows never navigates', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey', 'isComposing']) {
    assert.deepEqual(press({ ...up, [modifier]: true }, { index: -1, draft: '' }), [false, -1, '']);
    assert.deepEqual(press({ ...down, [modifier]: true }, { index: 0, draft: 'Second prompt' }), [false, 0, 'Second prompt']);
  }
  for (const key of ['Enter', 'ArrowLeft', 'a']) {
    assert.deepEqual(press({ key }, { index: 0, draft: 'Second prompt' }), [false, 0, 'Second prompt']);
  }
});

test('nothing is recalled before any prompt was sent', () => {
  assert.deepEqual(promptHistoryStep(up, { prompts: [], index: -1, draft: '' }), { handled: false, index: -1, draft: '' });
});
