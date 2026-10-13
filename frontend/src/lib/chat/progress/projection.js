import { humanizeId } from '../../ids.js';

const MAX_DISPLAY_DURATION_MS = 24 * 60 * 60 * 1000;

function identity(event) {
  return [
    event.segment ?? 0,
    event.origin,
    event.phase,
    event.assistant_id ?? '',
    event.action ?? '',
    event.index ?? 0,
    event.total ?? 0,
  ].join('\u0000');
}

export function createExecutionProjection() {
  return {
    steps: [], active: new Map(), currentIndex: -1, actionOccurrences: new Map(),
    observedActions: 0, observedModels: 0,
  };
}

function appendStep(projection, event, key, elapsedMs) {
  const step = {
    key: `${event.segment ?? 0}:${event.seq}:${key}`,
    identity: key,
    seq: event.seq,
    origin: event.origin,
    phase: event.phase,
    assistant_id: event.assistant_id,
    action: event.action,
    index: event.index,
    total: event.total,
    elapsed_ms: elapsedMs,
    observedActionsBefore: projection.observedActions,
    observedModelsBefore: projection.observedModels,
  };
  if (step.phase === 'model') projection.observedModels += 1;
  if (step.phase === 'action') {
    const actionKey = `${step.assistant_id}\u0000${step.action}`;
    step.actionOccurrence = (projection.actionOccurrences.get(actionKey) ?? 0) + 1;
    projection.actionOccurrences.set(actionKey, step.actionOccurrence);
    projection.observedActions += 1;
  }
  projection.steps.push(step);
}

export function extendExecutionProjection(projection, event) {
  const key = identity(event);
  if (event.state === 'started') {
    const positions = projection.active.get(key) ?? [];
    positions.push(projection.steps.length);
    projection.active.set(key, positions);
    appendStep(projection, event, key, null);
    projection.currentIndex = projection.steps.length - 1;
    return;
  }
  const positions = projection.active.get(key);
  const matchingIndex = positions?.pop();
  if (matchingIndex !== undefined) {
    projection.steps[matchingIndex].elapsed_ms = event.elapsed_ms;
    if (positions.length === 0) projection.active.delete(key);
    if (matchingIndex === projection.currentIndex) {
      projection.currentIndex = -1;
      for (const remaining of projection.active.values()) {
        projection.currentIndex = Math.max(projection.currentIndex, remaining.at(-1));
      }
    }
    return;
  }
  appendStep(projection, event, key, event.elapsed_ms);
}

// The receipt of one logical turn (ADR-0082): Team's measured steps of every segment the page observed, then one row
// for the rest of Team's clock (the gaps between steps, the person's wait during a pause, and anything this page never
// observed), so the rows add up to the turn's duration exactly, in whole milliseconds. Admin's own steps run outside
// that clock and stay in the live progress only.
export function receiptSteps(events, durationMs) {
  const projection = createExecutionProjection();
  for (const event of events) if (event.origin === 'team') extendExecutionProjection(projection, event);
  const steps = projection.steps;
  // A reply restored from history, or one whose Team steps this page never saw, has no receipt.
  if (steps.length === 0 || !Number.isSafeInteger(durationMs) || durationMs < 0) return steps;
  const measured = steps.reduce((sum, step) => sum + (Number.isSafeInteger(step.elapsed_ms) ? step.elapsed_ms : 0), 0);
  const rest = durationMs - measured;
  return rest > 0 ? [...steps, { key: 'rest', identity: 'rest', origin: 'team', phase: 'rest', elapsed_ms: rest }] : steps;
}

export function technicalStepLabel(step) {
  const position = step.phase === 'action' ? ` ${step.index}/${step.total}` : '';
  return `${step.origin} · ${step.phase}${position}`;
}

function isolate(value) {
  return `\u2068${value}\u2069`;
}

// One pass over the template: each value is inserted isolated and as written, never read for placeholders.
function fillNarrative(template, values) {
  return template.replace(/\{([a-zA-Z]+)\}/g, (placeholder, name) => (
    Object.hasOwn(values, name) ? isolate(String(values[name])) : placeholder
  ));
}

function displayAssistant(step, context) {
  const names = context.assistantNames;
  const reviewed = names instanceof Map ? names.get(step.assistant_id) : undefined;
  return reviewed ?? humanizeId(step.assistant_id);
}

function narrativeKey(step) {
  if (step.phase === 'team-context') {
    return step.observedModelsBefore > 0 ? 'teamContextFinal' : 'teamContextInitial';
  }
  if (step.phase === 'model') {
    return step.observedActionsBefore > 0 ? 'modelAfterAction' : 'modelInitial';
  }
  if (step.phase === 'action-preparation') {
    return step.observedActionsBefore > 0 ? 'actionPreparationAgain' : 'actionPreparation';
  }
  if (step.phase === 'action') {
    return step.actionOccurrence > 1 ? 'actionAgain' : 'action';
  }
  return {
    'admin-preparation': 'adminPreparation',
    'action-delivery': 'actionDelivery',
    'reply-validation': 'replyValidation',
    rest: 'rest',
  }[step.phase];
}

function narrativeLabel(step, labels, context) {
  const template = labels.narrative?.[narrativeKey(step)];
  if (typeof template !== 'string') return '';
  let label = fillNarrative(template, {
    team: context.teamName ?? labels.origins?.team ?? 'Team',
    assistant: displayAssistant(step, context),
    action: humanizeId(step.action),
  });
  if (step.phase === 'action' && step.total > 1 && typeof labels.narrative.actionPosition === 'string') {
    label += ` ${fillNarrative(labels.narrative.actionPosition, {
      index: step.index,
      total: step.total,
    })}`;
  }
  return label;
}

function fillStepPosition(template, step) {
  return template
    .replaceAll('{index}', String(step.index ?? ''))
    .replaceAll('{total}', String(step.total ?? ''));
}

export function localizedStepLabel(step, labels = {}, context = {}) {
  const narrative = narrativeLabel(step, labels, context);
  if (narrative) return narrative;
  const origin = labels.origins?.[step.origin] ?? step.origin;
  const phaseTemplate = labels.phases?.[step.phase];
  const phase = typeof phaseTemplate === 'string'
    ? fillStepPosition(phaseTemplate, step)
    : technicalStepLabel({ ...step, origin: '' }).replace(/^ · /, '');
  return `${origin} · ${phase}`;
}

export function localizedEventLabel(event, labels = {}, context = {}) {
  const state = labels.states?.[event.state] ?? event.state;
  return `${localizedStepLabel(event, labels, context)} · ${state}`;
}

export function formatExecutionDuration(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DISPLAY_DURATION_MS) return '';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
