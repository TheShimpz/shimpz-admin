const MAX_DISPLAY_DURATION_MS = 24 * 60 * 60 * 1000;

function identity(event) {
  return [
    event.origin,
    event.phase,
    event.assistant_id ?? '',
    event.action ?? '',
    event.index ?? 0,
    event.total ?? 0,
  ].join('\u0000');
}

function annotateNarrative(steps) {
  const actionOccurrences = new Map();
  let observedActions = 0;
  let observedModels = 0;
  for (const step of steps) {
    step.observedActionsBefore = observedActions;
    step.observedModelsBefore = observedModels;
    if (step.phase === 'model') observedModels += 1;
    if (step.phase !== 'action') continue;
    const key = `${step.assistant_id}\u0000${step.action}`;
    const occurrence = (actionOccurrences.get(key) ?? 0) + 1;
    actionOccurrences.set(key, occurrence);
    step.actionOccurrence = occurrence;
    observedActions += 1;
  }
  return steps;
}

export function executionSteps(events) {
  const steps = [];
  const active = new Map();
  for (const event of events) {
    const key = identity(event);
    if (event.state === 'started') {
      const positions = active.get(key) ?? [];
      positions.push(steps.length);
      active.set(key, positions);
      steps.push({
        key: `${event.seq}:${key}`,
        identity: key,
        seq: event.seq,
        origin: event.origin,
        phase: event.phase,
        assistant_id: event.assistant_id,
        action: event.action,
        index: event.index,
        total: event.total,
        elapsed_ms: null,
      });
      continue;
    }
    const positions = active.get(key);
    const matchingIndex = positions?.pop();
    if (matchingIndex !== undefined) {
      steps[matchingIndex].elapsed_ms = event.elapsed_ms;
      if (positions.length === 0) active.delete(key);
      continue;
    }
    steps.push({
      key: `${event.seq}:${key}`,
      identity: key,
      seq: event.seq,
      origin: event.origin,
      phase: event.phase,
      assistant_id: event.assistant_id,
      action: event.action,
      index: event.index,
      total: event.total,
      elapsed_ms: event.elapsed_ms,
    });
  }
  return annotateNarrative(steps);
}

export function executionStepCount(events) {
  const active = new Map();
  let count = 0;
  for (const event of events) {
    const key = identity(event);
    if (event.state === 'started') {
      active.set(key, (active.get(key) ?? 0) + 1);
      count += 1;
      continue;
    }
    const depth = active.get(key) ?? 0;
    if (depth > 1) active.set(key, depth - 1);
    else if (depth === 1) active.delete(key);
    else count += 1;
  }
  return count;
}

export function technicalStepLabel(step) {
  const position = step.phase === 'action' ? ` ${step.index}/${step.total}` : '';
  return `${step.origin} · ${step.phase}${position}`;
}

function humanizeIdentifier(value) {
  if (typeof value !== 'string') return '';
  return value.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

function isolate(value) {
  return `\u2068${value}\u2069`;
}

function fillNarrative(template, values) {
  return Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, isolate(String(value))),
    template,
  );
}

function displayAssistant(step, context) {
  const names = context.assistantNames;
  const reviewed = names instanceof Map ? names.get(step.assistant_id) : undefined;
  return reviewed ?? humanizeIdentifier(step.assistant_id);
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
  }[step.phase];
}

function narrativeLabel(step, labels, context) {
  const template = labels.narrative?.[narrativeKey(step)];
  if (typeof template !== 'string') return '';
  let label = fillNarrative(template, {
    team: context.teamName ?? labels.origins?.team ?? 'Team',
    assistant: displayAssistant(step, context),
    action: humanizeIdentifier(step.action),
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
