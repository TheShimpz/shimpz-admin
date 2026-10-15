import { call } from '#lib/session/socket.js';
import { readRunDiagnostics, runBinding } from '#lib/routines/protocol.js';

/** The step records a run's history entry binds: its Routine, and a completed run's plan summary. */
export function entryBinding(entry) {
  return runBinding(entry.routineId, entry.detail.plan ?? null);
}

/**
 * One run's execution details as both run views read them: null until read, then Team's diagnostics, or the failure
 * that kept them unread. `read` starts one read and answers its cleanup, so only an effect's newest read applies.
 */
export class RunDiagnostics {
  value = $state(null);
  failure = $state(null);

  read(teamId, runId) {
    let current = true;
    this.value = null;
    this.failure = null;
    readRunDiagnostics(call, teamId, runId)
      .then((value) => { if (current) this.value = value; })
      .catch((failure) => { if (current) this.failure = failure; });
    return () => { current = false; };
  }
}
