const MAX_DISPLAY_DURATION_MS = 24 * 60 * 60 * 1000;

function identity(event) {
  return `${event.origin}\u0000${event.phase}\u0000${event.index ?? 0}\u0000${event.total ?? 0}`;
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
      index: event.index,
      total: event.total,
      elapsed_ms: event.elapsed_ms,
    });
  }
  return steps;
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
  const position = step.phase === 'power' ? ` ${step.index}/${step.total}` : '';
  return `${step.origin} · ${step.phase}${position}`;
}

function fillStepPosition(template, step) {
  return template
    .replaceAll('{index}', String(step.index ?? ''))
    .replaceAll('{total}', String(step.total ?? ''));
}

export function localizedStepLabel(step, labels = {}) {
  const origin = labels.origins?.[step.origin] ?? step.origin;
  const phaseTemplate = labels.phases?.[step.phase];
  const phase = typeof phaseTemplate === 'string'
    ? fillStepPosition(phaseTemplate, step)
    : technicalStepLabel({ ...step, origin: '' }).replace(/^ · /, '');
  return `${origin} · ${phase}`;
}

export function localizedEventLabel(event, labels = {}) {
  const state = labels.states?.[event.state] ?? event.state;
  return `${localizedStepLabel(event, labels)} · ${state}`;
}

export function formatExecutionDuration(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DISPLAY_DURATION_MS) return '';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
