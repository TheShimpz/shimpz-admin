// The next message's files (ADR-0093): the files the Supervisor selected for it, each read for what Team can do with it
// and then uploaded, one at a time, to the Team it was selected for. A Team change discards them, an upload that
// answers for an earlier Team is ignored, and a selection still being read blocks sending until its files join the
// message or are refused. The chat page owns one, says when files may join, and moves the focus.
import { attachmentReadability, attachmentRefusal, AttachmentUploadError, uploadTeamFile } from './files.js';

function carriesFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files');
}

/**
 * A file drag the composer did not take (dropped elsewhere, or while files cannot join a message) is refused; left to
 * the browser, it would open the file in place of Admin.
 */
export function refuseFileDrop(event) {
  if (!carriesFiles(event) || event.defaultPrevented) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'none';
}

export class MessageFiles {
  /** The selected files, each `queued`, `uploading`, or `ready` (with Team's id). */
  items = $state([]);
  /** The last refusal, in the Supervisor's words. */
  error = $state('');
  /** Whether files are dragged over the composer. */
  dragging = $state(false);
  // Selections whose files are still being read.
  #inspections = $state([]);
  #finished = $state(0);
  #teamId = '';
  #upload = null;
  #pumping = false;
  #nextKey = 0;
  #nextInspection = 0;
  #refusalText;
  #target;

  /**
   * `refusalText(reason, name)` words a refusal of the file `name`; `target()` names the Team files chosen, pasted, or
   * dropped now join a message to, or '' while none may join.
   */
  constructor(refusalText, target = () => '') {
    this.#refusalText = refusalText;
    this.#target = target;
  }

  /** The Team the files were selected for, or '' with none. */
  get teamId() {
    return this.#teamId;
  }

  /** Whether a selection is still being read. */
  get reading() {
    return this.#inspections.length > 0;
  }

  /** Whether any file has not reached Team yet, so the message cannot leave. */
  get pending() {
    return this.#inspections.length > 0 || this.items.some((item) => item.state !== 'ready');
  }

  /** The upload under way as `{ current, total }` of this round of uploads, or null. */
  get progress() {
    const pending = this.items.filter((item) => item.state !== 'ready').length;
    return pending ? { current: this.#finished + 1, total: this.#finished + pending } : null;
  }

  /** The files a message for `teamId` carries: these files when they were selected for it, none otherwise. */
  attached(teamId) {
    return this.#teamId === teamId ? this.items : [];
  }

  /** The message left with its files: the next one starts empty. */
  sent() {
    this.items = [];
    this.#teamId = '';
    this.error = '';
  }

  /** Forget every file and stop the upload under way. */
  clear() {
    this.#upload?.controller.abort();
    this.#upload = null;
    this.items = [];
    this.#inspections = [];
    this.#teamId = '';
    this.error = '';
    this.dragging = false;
  }

  remove(key) {
    if (this.#upload?.key === key) this.#upload.controller.abort();
    this.items = this.items.filter((item) => item.key !== key);
    this.error = '';
  }

  /** Stop every selection still being read and every file not yet uploaded; uploaded files stay. */
  cancelUploads() {
    this.#upload?.controller.abort();
    this.items = this.items.filter((item) => item.state === 'ready');
    this.#inspections = [];
  }

  #offer(files) {
    const teamId = this.#target();
    if (teamId && files.length) void this.add(files, teamId);
  }

  /** The files picked in the file input join the message; the input is emptied for the next pick. */
  chosen = (event) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    this.#offer(files);
  };

  /** Pasted files join the message; pasted text still lands in the draft as usual. */
  paste = (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    this.#offer(files);
  };

  /** A file drag over the composer is taken while files may join. */
  dragOver = (event) => {
    if (!carriesFiles(event) || !this.#target()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    this.dragging = true;
  };

  dragLeave = (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) this.dragging = false;
  };

  drop = (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    this.dragging = false;
    this.#offer([...(event.dataTransfer.files ?? [])]);
  };

  /** Read and queue `files` for a message to `teamId`, then upload them. */
  async add(files, teamId) {
    if (this.#teamId !== teamId) this.clear();
    this.#teamId = teamId;
    this.error = '';
    // The selection blocks sending before its first read, so a message never leaves without a file still being read.
    const inspection = this.#nextInspection++;
    this.#inspections = [...this.#inspections, inspection];
    const current = () => this.#teamId === teamId && this.#inspections.includes(inspection);
    try {
      for (const file of files) {
        // A Team change or a cancel ends the selection: no further file of it is read, even after a failed read.
        if (!current()) return;
        let readability = { kind: 'file', note: 'unreadable' };
        if (file.size > 0) {
          try {
            readability = await attachmentReadability(file);
          } catch {
            if (current()) this.error = this.#refusalText('unavailable', file.name);
            continue;
          }
        }
        // A selection that finishes reading after a Team change or a cancel belongs to no message.
        if (!current()) return;
        const refusal = attachmentRefusal(this.items, { size: file.size, ...readability });
        if (refusal) {
          this.error = this.#refusalText(refusal, file.name);
          if (refusal === 'too-many') break;
          continue;
        }
        this.items = [...this.items, {
          key: this.#nextKey++,
          file,
          name: file.name,
          size: file.size,
          ...readability,
          state: 'queued',
        }];
      }
    } finally {
      this.#inspections = this.#inspections.filter((entry) => entry !== inspection);
    }
    void this.#uploadQueued();
  }

  #update(key, patch) {
    this.items = this.items.map((item) => (item.key === key ? { ...item, ...patch } : item));
  }

  async #uploadQueued() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let item = this.items.find((entry) => entry.state === 'queued'); item;
        item = this.items.find((entry) => entry.state === 'queued')) {
        const teamId = this.#teamId;
        const controller = new AbortController();
        this.#upload = { key: item.key, controller };
        this.#update(item.key, { state: 'uploading' });
        try {
          const stored = await uploadTeamFile(fetch, teamId, item.file, controller.signal);
          if (controller.signal.aborted || this.#teamId !== teamId) continue;
          // Team keeps one copy of an identical file: one already in this message is not attached twice.
          if (this.items.some((entry) => entry.key !== item.key && entry.id === stored.id)) {
            this.items = this.items.filter((entry) => entry.key !== item.key);
          } else {
            this.#update(item.key, {
              state: 'ready',
              id: stored.id,
              name: stored.name,
              mediaType: stored.media_type,
              size: stored.size,
            });
          }
          this.#finished += 1;
        } catch (reason) {
          if (controller.signal.aborted || this.#teamId !== teamId) continue;
          this.items = this.items.filter((entry) => entry.key !== item.key);
          this.#finished += 1;
          this.error = this.#refusalText(
            reason instanceof AttachmentUploadError ? reason.reason : 'failed',
            item.name,
          );
        } finally {
          if (this.#upload?.controller === controller) this.#upload = null;
        }
      }
    } finally {
      this.#pumping = false;
      this.#finished = 0;
    }
  }
}
