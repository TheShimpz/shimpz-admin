const MAX_DISPLAY_DURATION_MS = 24 * 60 * 60 * 1000;

function identity(event) {
  return `${event.origin}\u0000${event.phase}\u0000${event.index ?? 0}\u0000${event.total ?? 0}`;
}

export function executionSteps(events) {
  const steps = [];
  for (const event of events) {
    const key = identity(event);
    if (event.state === 'started') {
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
    const matching = steps.findLast((step) => step.identity === key && step.elapsed_ms === null);
    if (matching) {
      matching.elapsed_ms = event.elapsed_ms;
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

export function technicalStepLabel(step) {
  const position = step.phase === 'power' ? ` ${step.index}/${step.total}` : '';
  return `${step.origin} · ${step.phase}${position}`;
}

export function formatExecutionDuration(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DISPLAY_DURATION_MS) return '';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
