<script>
  import { Button, DialogFrame, Modal, Notice, TextAreaField } from '@shimpz/frontend';
  import { showAdminNotice } from '$lib/adminNotice.js';
  import { t } from '$lib/i18n.js';
  import {
    loadInstructions,
    MAX_INSTRUCTION_CHARS,
    MAX_INSTRUCTIONS,
    parseInstructionLines,
    saveInstructions,
  } from '$lib/teamInstructions.js';

  // The Supervisor's standing instructions for one Team (ADR-0083): one rule per line, saved only on submit.
  let { onsettled = () => {} } = $props();

  let dialog = $state();
  let team = $state();
  let text = $state('');
  let loading = $state(false);
  // Save stays off until the current rules loaded, so a failed read can never overwrite them with an empty list.
  let loaded = $state(false);
  let saving = $state(false);
  let failure = $state('');
  let generation = 0;

  let copy = $derived($t('teamInstructions'));
  let parsed = $derived(parseInstructionLines(text));
  let problem = $derived(
    parsed.error
      ? $t(`teamInstructions.${parsed.error}`, { line: parsed.line, max: MAX_INSTRUCTIONS, chars: MAX_INSTRUCTION_CHARS })
      : '',
  );

  export async function open(target) {
    const current = ++generation;
    team = target;
    text = '';
    failure = '';
    loading = true;
    loaded = false;
    if (!dialog?.open) dialog?.showModal();
    try {
      const rules = await loadInstructions(fetch, target.id);
      if (current === generation) {
        text = rules.join('\n');
        loaded = true;
      }
    } catch {
      if (current === generation) failure = copy.loadFailed;
    } finally {
      if (current === generation) loading = false;
    }
  }

  function close() {
    if (saving) return;
    generation += 1;
    dialog?.close();
    team = undefined;
    onsettled();
  }

  function cancel(event) {
    event.preventDefault();
    close();
  }

  async function submit(event) {
    event.preventDefault();
    if (saving || loading || !loaded || !team || parsed.error) return;
    saving = true;
    failure = '';
    try {
      await saveInstructions(fetch, team.id, parsed.rules);
    } catch {
      failure = copy.saveFailed;
      return;
    } finally {
      saving = false;
    }
    showAdminNotice({
      tone: 'success',
      label: copy.savedLabel,
      message: $t('teamInstructions.savedMessage', { team: team.name }),
    });
    close();
  }
</script>

<Modal bind:element={dialog} labelledBy="team-instructions-title" oncancel={cancel}>
  <form onsubmit={submit}>
    <DialogFrame
      kicker={team?.name ?? ''}
      title={copy.title}
      titleId="team-instructions-title"
      lead={copy.lead}
    >
      <TextAreaField
        id="team-instructions-text"
        label={copy.label}
        bind:value={text}
        placeholder={copy.placeholder}
        hint={$t('teamInstructions.hint', { max: MAX_INSTRUCTIONS, chars: MAX_INSTRUCTION_CHARS })}
        error={problem}
        rows="8"
        disabled={loading || saving || !loaded}
        spellcheck="true"
      />
      {#if failure}<Notice variant="error">{failure}</Notice>{/if}
      {#snippet footer()}
        <Button variant="secondary" type="button" onclick={close} disabled={saving}>{copy.cancel}</Button>
        <Button type="submit" disabled={loading || saving || !loaded || Boolean(parsed.error)}>
          {saving ? copy.saving : copy.save}
        </Button>
      {/snippet}
    </DialogFrame>
  </form>
</Modal>

<style>
  form { margin: 0; }
</style>
