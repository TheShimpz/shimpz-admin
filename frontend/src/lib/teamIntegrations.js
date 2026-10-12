// A Team's Integrations and Stored Inputs as the chat's drawer shows them (ADR-0114): each a synced value of its own
// read on the Team's `team/{id}/integrations` topic, which Admin raises whenever either changes through it.
import { listAssistantIntegrations, listAssistantStoredInputs } from './localChat.js';
import { synced } from './synced.js';

/** One Team's Integrations and Stored Inputs, read while a screen shows them and again whenever they change. */
export function teamIntegrations(teamId) {
  const topic = `team/${teamId}/integrations`;
  return {
    teamId,
    integrations: synced(topic, async (call) => (await listAssistantIntegrations(teamId, call)).integrations),
    storedInputs: synced(topic, async (call) => (await listAssistantStoredInputs(teamId, call)).stored_inputs),
  };
}
