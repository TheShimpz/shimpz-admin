<script>
  import { onMount } from 'svelte';
  import { DialogFrame, Modal, Notice, TextField } from '@shimpz/frontend';
  import DialogAction from '#lib/DialogAction.svelte';
  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import { t } from '#lib/i18n/index.js';
  import { controlBrowser } from './view.js';
  import { cancelSignIn, canonicalLabel, MAX_LABEL_CHARS, saveSignIn } from './signIns.js';

  // A sign-in session (ADR-0117, Sign-ins amendment): the Browser only the person drives, at the site they chose, with
  // Chrome's own address bar. The screen takes their pointer and keys; Esc goes to the page, so only Cancel or Save
  // ends the dialog. Save keeps the profile as a Sign-in under the person's label, after what it means is said; Cancel
  // keeps nothing. Saving takes Chromium's rest and stop (about 40 s), during which the screen ends by design. A screen
  // whose connection ended says so and can connect again: only Team's own answer says the session ended. The dialog is
  // its own form, so Enter in it never reaches the chat's composer around it.
  let { session, onclose } = $props();

  const titleId = $props.id();
  let dialog = $state();
  let screen = $state();
  // `loading`, `showing`, `lost` (the connection to the screen ended), or `ended` (Team ended the session).
  let status = $state('loading');
  let label = $state('');
  let working = $state('');
  let error = $state('');
  let copy = $derived($t('signInSession'));
  let kept = $derived(canonicalLabel(label));
  let connection = null;

  // What a saved Sign-in means, said before Save: every identity in it is delegated, it keeps the site's own state,
  // what the agent reads signed in reaches the model provider, and a dedicated account is the safer one.
  const TERMS = ['delegated', 'kept', 'provider', 'dedicated'];
  const REFUSALS = {
    'sign-in-windows': 'windows',
    'sign-in-identity-provider': 'identityProvider',
    'sign-in-label-invalid': 'labelInvalid',
    'sign-in-not-running': 'notRunning',
    'sign-in-unsaved': 'unsaved',
  };
  // Refusals that come before saving began: the session goes on.
  const KEPT_RUNNING = new Set(['sign-in-windows', 'sign-in-label-invalid']);

  function connect() {
    connection?.abort(new DOMException('The screen reconnected.', 'AbortError'));
    const controller = new AbortController();
    connection = controller;
    status = 'loading';
    import('@novnc/novnc')
      .then(({ default: RFB }) => controlBrowser(session.teamId, session.viewId, {
        signal: controller.signal,
        target: screen,
        RFB,
        onconnect() {
          if (!controller.signal.aborted) status = 'showing';
        },
      }))
      .catch(() => {
        if (!controller.signal.aborted && !working && status !== 'ended') status = 'lost';
      });
  }

  onMount(() => {
    dialog.showModal();
    connect();
    return () => {
      connection?.abort(new DOMException('The sign-in closed.', 'AbortError'));
      if (dialog?.open) dialog.close();
    };
  });

  function refusal(failed, fallback) {
    if (outcomeUnknown(failed)) return $t('shell.outcomeUnknown');
    return copy[REFUSALS[failed?.code]] ?? fallback;
  }

  async function save(event) {
    event.preventDefault();
    event.stopPropagation();
    if (working || !kept || status === 'ended') return;
    working = 'saving';
    error = '';
    try {
      await saveSignIn(session.teamId, session.sessionId, kept);
      onclose(copy.saved);
    } catch (failed) {
      error = refusal(failed, copy.unsaved);
      working = '';
      if (!KEPT_RUNNING.has(failed?.code)) status = 'ended';
    }
  }

  async function cancel() {
    if (working) return;
    if (status === 'ended') {
      onclose('');
      return;
    }
    working = 'cancelling';
    error = '';
    try {
      await cancelSignIn(session.teamId, session.sessionId);
    } catch (failed) {
      if (failed?.code !== 'sign-in-not-running') {
        // The session may still run on Team: the person hears so and can try again or leave it to end by itself.
        error = outcomeUnknown(failed) ? $t('shell.outcomeUnknown') : copy.cancelFailed;
        working = '';
        return;
      }
    }
    onclose('');
  }
</script>

<Modal
  size="xl"
  bind:element={dialog}
  labelledBy={titleId}
  oncancel={(event) => event.preventDefault()}
>
  <form onsubmit={save}>
    <DialogFrame kicker={copy.kicker} title={$t('signInSession.title', { site: session.site })} {titleId} lead={copy.lead}>
      <div class="screen" bind:this={screen} role="application" aria-label={copy.screen}></div>
      {#if status !== 'showing'}
        <p class="status" role="status">{copy[status]}</p>
      {/if}
      {#if status === 'lost'}
        <DialogAction kind="retry" type="button" disabled={Boolean(working)} onclick={connect}>{copy.reconnect}</DialogAction>
      {/if}
      {#if status !== 'ended'}
        <TextField
          id={`${titleId}-label`}
          label={copy.labelField}
          hint={copy.labelHint}
          bind:value={label}
          maxlength={MAX_LABEL_CHARS}
          autocomplete="off"
          disabled={Boolean(working)}
        />
        <ul class="terms" aria-label={copy.termsLabel}>
          {#each TERMS as term (term)}
            <li>{$t(`signInSession.terms.${term}`, { site: session.site })}</li>
          {/each}
        </ul>
      {/if}
      {#if error}<Notice variant="error">{error}</Notice>{/if}
      {#snippet footer()}
        <DialogAction kind="cancel" type="button" disabled={Boolean(working)} onclick={cancel}>
          {status === 'ended' ? copy.close : working === 'cancelling' ? copy.cancelling : copy.cancel}
        </DialogAction>
        {#if status !== 'ended'}
          <DialogAction kind="confirm" type="submit" disabled={Boolean(working) || !kept || !$commandsReady}>
            {working === 'saving' ? copy.saving : copy.save}
          </DialogAction>
        {/if}
      {/snippet}
    </DialogFrame>
  </form>
</Modal>

<style>
  /* noVNC fills this box and scales the Browser's screen to it. */
  .screen {
    width: 100%;
    aspect-ratio: 1280 / 800;
    overflow: hidden;
    border: 1px solid var(--border);
    background: #000;
  }
  .status { margin: 0; color: var(--text-dim); font-size: 0.74rem; }
  .terms { display: grid; gap: var(--gap-inside); margin: 0; padding-inline-start: 1.1rem; color: var(--text-dim); font-size: 0.78rem; line-height: 1.5; }
</style>
