// The Actions Team withheld from a turn because its message's attachments were readable (ADR-0093): a closed note,
// never anything to run.

import { exactKeys, LocalApiError } from '../../api.js';
import { isActionId, isAssistantId } from '../../ids.js';

const encoder = new TextEncoder();

const MAX_RESTRICTED_ACTIONS = 16;
const MAX_RESTRICTED_ACTION_TOTAL = 2048;
const MAX_RESTRICTED_ACTIONS_BYTES = 2048;

/**
 * The Actions a completed turn withheld because readable attachment content was in it (Team
 * payload.canonical_restricted_actions): 1 to 16 distinct identities in identity order and the turn's total. It names
 * capabilities only and grants nothing.
 */
export function parseRestrictedActions(value) {
  if (
    !exactKeys(value, ['actions', 'total']) ||
    !Array.isArray(value.actions) ||
    value.actions.length < 1 ||
    value.actions.length > MAX_RESTRICTED_ACTIONS ||
    !Number.isSafeInteger(value.total) ||
    value.total < value.actions.length ||
    value.total > MAX_RESTRICTED_ACTION_TOTAL
  ) throw new LocalApiError('The local chat response is invalid.');
  const actions = value.actions.map((item) => {
    if (
      !exactKeys(item, ['assistant', 'action']) ||
      !isAssistantId(item.assistant) ||
      !isActionId(item.action)
    ) throw new LocalApiError('The local chat response is invalid.');
    return { assistant: item.assistant, action: item.action };
  });
  const ordered = actions.every((item, index) => {
    if (index === 0) return true;
    const previous = actions[index - 1];
    return previous.assistant < item.assistant || (previous.assistant === item.assistant && previous.action < item.action);
  });
  const projected = { actions, total: value.total };
  if (!ordered || encoder.encode(JSON.stringify(projected)).length > MAX_RESTRICTED_ACTIONS_BYTES) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return projected;
}
