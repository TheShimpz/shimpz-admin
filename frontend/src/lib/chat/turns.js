// The chat transcript as data: the turns a Team's conversation shows, how live frames and stored history rows become
// turns, and the words and states their cards show. Pure: the chat page owns the turns, their render identities (each
// function that adds a turn takes the one it should carry), the timers, and every request.
//
// `words` is the chat page's copy (`chatPage`) with `limit`, the localized Assistant-limit refusal, added.
import { receiptSteps } from './progress/projection.js';
import { fill } from '../i18n/fill.js';
import { escapeMarkdownText } from './markdown.js';
import { attachmentKind } from './attachments/files.js';
import { taskUsageSummary } from './usage.js';
import { ASSISTANT_LIMIT_REACHED } from '../api.js';

/** How the person answered each Routine card the transcript holds, by card id: created, changed, or revoked. */
export function cardAnswers(turns) {
  return new Map(turns.filter((turn) => turn.routineAnswer).map((turn) => [
    turn.routineAnswer.proposalId, turn.routineAnswer.status,
  ]));
}

/**
 * Whether a turn has nothing left to show: a card's answer that is not a change (a creation is said by its Routine's
 * own creation notice, a cancel by its card), or a reply with no text whose card created or changed its Routine.
 */
function settled(turn, answers) {
  if (turn.routineAnswer) return turn.routineAnswer.status !== 'changed';
  const answer = turn.routineProposal ? answers.get(turn.routineProposal.proposal_id) : undefined;
  return (answer === 'created' || answer === 'changed') && turn.text === '';
}

/** Turns as exchanges: a user message with the reply that answered it, or a reply that opens one on its own. */
export function groupExchanges(turns, answers = new Map()) {
  const grouped = [];
  for (const turn of turns) {
    if (settled(turn, answers)) continue;
    if (turn.role === 'user') {
      grouped.push({ key: turn.renderKey, user: turn, assistant: null });
    } else if (grouped.length > 0 && grouped.at(-1).assistant === null) {
      grouped.at(-1).assistant = turn;
    } else {
      grouped.push({ key: turn.renderKey, user: null, assistant: turn });
    }
  }
  return grouped;
}

/**
 * A reply's usage and the receipt rows its usage line opens (ADR-0082): only a reply with usage has a receipt, and with
 * one the duration shown is what its rows add up to, which is Team's duration unless steps measured on another clock
 * overrun it.
 */
export function shownUsage(turn) {
  const steps = turn.usage ? receiptSteps(turn.receipt ?? [], turn.usage.durationMs) : [];
  if (steps.length === 0) return { usage: turn.usage, steps };
  const total = steps.reduce((sum, step) => sum + (Number.isSafeInteger(step.elapsed_ms) ? step.elapsed_ms : 0), 0);
  return { usage: { ...turn.usage, seconds: Math.max(total, turn.usage.durationMs) / 1000 }, steps };
}

/** One stored file as its card shows it, from the reference a message or a reply keeps. */
function fileCard(file) {
  return {
    key: file.id,
    id: file.id,
    name: file.name,
    mediaType: file.media_type,
    size: file.size,
    kind: attachmentKind(file.media_type),
    note: '',
  };
}

/** What a reply carries beside its text, the same from a live `done` frame and from its stored history row. */
export function replyFields(source) {
  return {
    ...(source.clarification ? { clarification: source.clarification } : {}),
    ...(source.usage ? { usage: taskUsageSummary(source.usage) } : {}),
    // A stored reply keeps the steps its page was shown; a live one collects them from its progress frames.
    ...(source.receipt ? { receipt: source.receipt } : {}),
    ...(source.routine_proposal ? { routineProposal: source.routine_proposal } : {}),
    ...(source.routine_refusal ? { routineRefusal: source.routine_refusal } : {}),
    ...(source.routine_question ? { routineQuestion: source.routine_question } : {}),
    // The files a reply's Browser task downloaded, as cards under it; each came from the web (ADR-0117).
    ...(source.browser?.files.length ? { webFiles: source.browser.files.map(fileCard) } : {}),
  };
}

/** The text an install plan ended with: installed (or already installed), refused, or cut off. */
export function installText(state, outcome, code, words) {
  if (state === 'installed') return outcome === 'already-installed' ? words.install.already : words.install.complete;
  if (state === 'failed') return code === ASSISTANT_LIMIT_REACHED ? words.limit : words.install.failed;
  return words.disconnected;
}

/** One stored history row as a turn, carrying `renderKey` as its identity; every row keeps the time Admin wrote it. */
export function historyTurn(entry, author, renderKey, words) {
  const stored = { renderKey, historyId: entry.id, createdAt: entry.createdAt };
  if (entry.kind === 'message') {
    return {
      ...stored,
      role: entry.role,
      text: entry.text,
      ...(entry.role === 'assistant' ? { author: entry.author } : {}),
      ...replyFields(entry),
      // A reloaded message shows the files it carried as it did when sent, from their saved references.
      ...(entry.files
        ? {
          files: entry.files.map(fileCard),
        }
        : {}),
    };
  }
  if (entry.kind === 'guidance') {
    return { ...stored, role: 'assistant', text: escapeMarkdownText(entry.reply), author };
  }
  if (entry.kind === 'status') {
    // A turn that ended without a reply says how, as the page that watched it said (ADR-0119).
    const text = entry.state === 'stopped' ? words.turnStopped : projectedChatError(entry.status, entry.detail, words).message;
    return { ...stored, role: 'assistant', text: escapeMarkdownText(text), author, ending: entry.state };
  }
  if (entry.kind === 'assistant-install') {
    return {
      ...stored,
      role: 'assistant',
      text: installText(entry.state, entry.outcome, entry.code, words),
      author,
      installPlan: {
        plan_id: `history-${entry.id}`,
        state: entry.state,
        assistants: entry.assistants,
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
        ...(entry.status ? { status: entry.status } : {}),
        ...(entry.code ? { code: entry.code } : {}),
      },
    };
  }
  if (entry.kind === 'routine-run') {
    // The chat's view holds only a Routine's creation (history.js), which shows what its recording spent, as a reply
    // does: its usage line and its receipt.
    const spent = entry.usage
      ? { usage: taskUsageSummary(entry.usage), receipt: entry.receipt }
      : {};
    return { ...stored, role: 'assistant', text: '', author, routineRun: entry, ...spent };
  }
  if (entry.kind === 'routine-answer') {
    return { ...stored, role: 'assistant', text: '', author, routineAnswer: entry };
  }
  return {
    ...stored,
    role: 'assistant',
    text: '',
    author,
    lifecycle: {
      proposal_id: `history-${entry.id}`,
      assistant: entry.assistant,
      state: entry.state,
      completionAnnounced: true,
      ...(entry.state === 'uninstalled' ? { uninstalled: entry.uninstalled } : {}),
      ...(entry.status ? { status: entry.status } : {}),
    },
  };
}

function installPlanTurnIndex(turns, planId) {
  return turns.findLastIndex((turn) => turn.installPlan?.plan_id === planId);
}

const INSTALL_ITEM_TRANSITIONS = {
  pending: ['pending', 'installing', 'failed'],
  installing: ['installing', 'installed', 'failed'],
  installed: ['installed'],
};
const INSTALL_TRANSITIONS = {
  planned: ['installing', 'failed', 'stopped'],
  installing: ['installing', 'installed', 'failed', 'stopped'],
};

/**
 * The turns after one install plan frame: an already-installed answer or a new plan adds a turn carrying `renderKey`;
 * any later state updates its plan's turn in place, which must name the same Assistants and only move each forward.
 * Anything else throws.
 */
export function installPlanTurns(turns, incoming, receipt, renderKey, words) {
  if (incoming.outcome === 'already-installed') {
    if (installPlanTurnIndex(turns, incoming.plan_id) !== -1) throw new Error('duplicate install result');
    return [...turns, {
      renderKey,
      role: 'assistant',
      text: words.install.already,
      author: incoming.team_name,
      receipt,
      installPlan: {
        plan_id: incoming.plan_id,
        state: incoming.state,
        outcome: incoming.outcome,
        assistants: incoming.assistants,
      },
    }];
  }
  if (incoming.state === 'planned') {
    if (installPlanTurnIndex(turns, incoming.plan_id) !== -1) throw new Error('duplicate install plan');
    return [...turns, {
      renderKey,
      role: 'assistant',
      text: words.install.working,
      author: incoming.team_name,
      receipt,
      installPlan: {
        plan_id: incoming.plan_id,
        state: incoming.state,
        assistants: incoming.assistants,
      },
    }];
  }
  const index = installPlanTurnIndex(turns, incoming.plan_id);
  if (index < 0) throw new Error('unknown install plan');
  const current = turns[index].installPlan;
  if (
    current.assistants.length !== incoming.assistants.length ||
    current.assistants.some((assistant, position) => {
      const next = incoming.assistants[position];
      return assistant.id !== next.id ||
        assistant.name !== next.name ||
        assistant.summary !== next.summary ||
        assistant.provenance !== next.provenance ||
        assistant.providers.join('\0') !== next.providers.join('\0');
    })
  ) throw new Error('mismatched install plan');
  if (current.assistants.some((assistant, position) => (
    !INSTALL_ITEM_TRANSITIONS[assistant.status]?.includes(incoming.assistants[position].status)
  ))) throw new Error('invalid install plan item transition');
  if (!INSTALL_TRANSITIONS[current.state]?.includes(incoming.state)) {
    throw new Error('invalid install plan transition');
  }
  return turns.map((turn, position) => position === index
    ? {
        ...turn,
        // An install under way keeps the words it showed; one that ended says how.
        text: incoming.state === 'installing' ? turn.text : installText(incoming.state, undefined, incoming.code, words),
        installPlan: {
          ...current,
          state: incoming.state,
          assistants: incoming.assistants,
          ...(incoming.status ? { status: incoming.status } : {}),
          ...(incoming.code ? { code: incoming.code } : {}),
        },
      }
    : turn);
}

/** The index of the newest turn whose uninstall card is `proposalId`, or -1. */
export function lifecycleTurnIndex(turns, proposalId) {
  return turns.findLastIndex((turn) => turn.lifecycle?.proposal_id === proposalId);
}

/**
 * The turns after one uninstall frame, and whether it ended the uninstall: a proposal adds a turn carrying `renderKey`
 * with its reply; a later state moves that card forward (an approval to working, then to its outcome; a proposal may
 * be cancelled or expire). Anything else throws.
 */
export function lifecycleTurns(turns, incoming, receipt, renderKey, words) {
  if (incoming.state === 'proposed') {
    if (lifecycleTurnIndex(turns, incoming.proposal_id) !== -1) throw new Error('duplicate lifecycle proposal');
    return {
      turns: [...turns, {
        renderKey,
        role: 'assistant',
        text: fill(words.uninstall.proposalReply, { assistant: escapeMarkdownText(incoming.assistant.name) }),
        author: incoming.team_name,
        receipt,
        lifecycle: {
          proposal_id: incoming.proposal_id,
          assistant: incoming.assistant,
          state: 'proposed',
        },
      }],
      terminal: true,
    };
  }
  const index = lifecycleTurnIndex(turns, incoming.proposal_id);
  if (index < 0) throw new Error('unknown lifecycle proposal');
  const current = turns[index].lifecycle;
  if (current.assistant.id !== incoming.assistant_id) throw new Error('mismatched lifecycle proposal');
  const allowed = current.state === 'proposed'
    ? ['uninstalling', 'cancelled', 'expired']
    : current.state === 'working' ? ['uninstalled', 'failed']
      : current.state === 'expired' ? ['expired'] : [];
  if (!allowed.includes(incoming.state)) throw new Error('invalid lifecycle transition');
  const updated = {
    ...current,
    state: incoming.state === 'uninstalling' ? 'working' : incoming.state,
    ...(incoming.state === 'uninstalled' ? { uninstalled: incoming.uninstalled } : {}),
    ...(incoming.state === 'failed' ? { status: incoming.status } : {}),
  };
  return {
    turns: turns.map((turn, turnIndex) => (turnIndex === index ? { ...turn, lifecycle: updated } : turn)),
    terminal: incoming.state !== 'uninstalling',
  };
}

/**
 * The turns once the connection that carried them is gone: a proposal can no longer be answered, an approved uninstall
 * and an Assistant still installing have an unknown outcome, and an install plan under way stopped.
 */
export function expiredTurns(turns) {
  // The same array when nothing expired, so the transcript derived from it is not computed again for nothing.
  let changed = false;
  const expired = turns.map((turn) => {
    const next = expiredTurn(turn);
    changed ||= next !== turn;
    return next;
  });
  return changed ? expired : turns;
}

function expiredTurn(turn) {
  if (turn.lifecycle?.state === 'proposed') {
    return { ...turn, lifecycle: { ...turn.lifecycle, state: 'expired' } };
  }
  if (turn.lifecycle?.state === 'working') {
    return { ...turn, lifecycle: { ...turn.lifecycle, state: 'unknown' } };
  }
  if (['planned', 'installing'].includes(turn.installPlan?.state)) {
    return {
      ...turn,
      installPlan: {
        ...turn.installPlan,
        state: 'stopped',
        assistants: turn.installPlan.assistants.map((assistant) => (
          assistant.status === 'installing' ? { ...assistant, status: 'unknown' } : assistant
        )),
      },
    };
  }
  return turn;
}

/** An uninstall card's task state. */
export function lifecycleVisualState(state) {
  if (state === 'proposed') return 'pending';
  if (state === 'working') return 'working';
  if (state === 'uninstalled') return 'complete';
  if (state === 'cancelled' || state === 'expired') return 'cancelled';
  return 'failed';
}

/** An uninstall card's status words. */
export function lifecycleStatus(lifecycle, words) {
  const uninstall = words.uninstall;
  if (lifecycle.state === 'proposed') return uninstall.pending;
  if (lifecycle.state === 'working') return uninstall.working;
  if (lifecycle.state === 'uninstalled') return lifecycle.uninstalled ? uninstall.complete : uninstall.absent;
  if (lifecycle.state === 'cancelled') return uninstall.cancelled;
  if (lifecycle.state === 'expired') return uninstall.expired;
  if (lifecycle.state === 'unknown') return uninstall.unknown;
  return uninstall.failed;
}

/** One install plan Assistant's task state. */
export function installPlanVisualState(status) {
  if (status === 'pending') return 'pending';
  if (status === 'installing') return 'working';
  if (status === 'installed') return 'complete';
  return 'failed';
}

/** One install plan Assistant's status words. */
export function installPlanStatus(status, outcome, words) {
  if (status === 'pending') return words.install.pending;
  if (status === 'installing') return words.install.working;
  if (status === 'installed') return outcome === 'already-installed' ? words.install.already : words.install.complete;
  if (status === 'unknown') return words.disconnected;
  return words.install.failed;
}

/** A Local snapshot has no catalog icon; its icon appears only once installed, so a settled plan without one failed. */
export function installPlanIconStatus(assistant) {
  return assistant.status === 'pending' || assistant.status === 'installing' ? 'loading' : 'failed';
}

/** A failed turn's words by its HTTP status. */
export function friendlyChatError(status, words) {
  if (status === 409) return words.turnFailed;
  if (status === 429) return words.capacityFailed;
  if (status === 503) return words.runtimeFailed;
  return words.requestFailed;
}

/** A chat `error` frame as the page shows it: its words, and a technical detail unless the words say all. */
export function projectedChatError(status, detail, words) {
  if (status === 409 && detail === ASSISTANT_LIMIT_REACHED) return { message: words.limit, detail: '' };
  if (status === 403 && detail === 'authentication was not confirmed') {
    return { message: words.authenticationDenied, detail: '' };
  }
  if (status === 503 && detail === 'authentication is unavailable') {
    return { message: words.authenticationUnavailable, detail: '' };
  }
  const resetting = status === 409 && typeof detail === 'string' && detail.startsWith('space-resetting:');
  // A stored key record Admin did not write refuses every turn until the Space is reset, which its words say.
  const broken = status === 502 && typeof detail === 'string' && detail.startsWith('credential-record-invalid:');
  return {
    message: resetting ? words.spaceResetting : broken ? words.credentialRecordInvalid : friendlyChatError(status, words),
    detail: `HTTP ${status} · ${detail}`,
  };
}
