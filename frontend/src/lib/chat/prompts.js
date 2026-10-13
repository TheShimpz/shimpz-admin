// Recalling sent prompts in the Chat composer with ArrowUp and ArrowDown, as one key press at a time. The composer owns
// the key event and the draft; this decides what the key does from the prompts sent so far, oldest first, the place
// in them the composer shows (`index` counts back from the newest, -1 when the draft is the person's own), and the
// draft. A plain ArrowUp in an empty composer starts at the newest prompt; while a recalled prompt is unchanged,
// ArrowUp walks back to the oldest and stays there and ArrowDown walks forward to an empty composer; an edited
// recalled prompt leaves the history. A key with a modifier, during an input method composition, or without any sent
// prompt never navigates.

/**
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean,
 *   isComposing?: boolean }} key
 * @param {{ prompts: string[], index: number, draft: string }} state
 * @returns {{ handled: boolean, index: number, draft: string }} `handled` when the key showed another draft, which
 *   the composer then shows in place of the key's own effect.
 */
export function promptHistoryStep(key, { prompts, index, draft }) {
  const unchanged = { handled: false, index, draft };
  if (
    !['ArrowUp', 'ArrowDown'].includes(key.key) ||
    key.ctrlKey ||
    key.metaKey ||
    key.shiftKey ||
    key.altKey ||
    key.isComposing ||
    prompts.length === 0
  ) return unchanged;
  const shown = (place) => ({ handled: true, index: place, draft: prompts[prompts.length - 1 - place] });
  if (index < 0) return key.key === 'ArrowUp' && draft === '' ? shown(0) : unchanged;
  if (draft !== prompts[prompts.length - 1 - index]) return { handled: false, index: -1, draft };
  if (key.key === 'ArrowUp') return shown(Math.min(index + 1, prompts.length - 1));
  return index === 0 ? { handled: true, index: -1, draft: '' } : shown(index - 1);
}
