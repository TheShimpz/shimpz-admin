<script>
  import { onMount } from 'svelte';
  import { DialogFrame, Modal, Notice } from '@shimpz/frontend';
  import DialogAction from '#lib/DialogAction.svelte';
  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import { t } from '#lib/i18n/index.js';
  import { controlBrowser } from './view.js';
  import { cancelSignIn, saveSignIn } from './signIns.js';

  // A sign-in session (ADR-0117, 2026-10-20 amendment): the Team's browser session, restored when it has one, driven
  // only by the person at the site they chose, with Chrome's own address bar. The screen takes their pointer and keys;
  // Esc goes to the page, so only Cancel or Save ends the dialog. Save keeps the whole session, after what that means
  // is said; Cancel keeps nothing new, and a restored session then waits for the person's next Save. Saving takes Chromium's rest and stop (about 40 s), during which the screen ends by design. A screen
  // whose connection ended says so and can connect again: only Team's own answer says the session ended. The dialog is
  // its own form, so Enter in it never reaches the chat's composer around it.
  let { session, onclose } = $props();

  const titleId = $props.id();
  let dialog = $state();
  let screen = $state();
  // `loading`, `showing`, `lost` (the connection to the screen ended), or `ended` (Team ended the session).
  let status = $state('loading');
  let working = $state('');
  let error = $state('');
  let copy = $derived($t('signInSession'));
  let connection = null;

  // What a saved Sign-in means, said before Save: every identity in it is delegated, it keeps the site's own state,
  // what the agent reads signed in reaches the model provider, and a dedicated account is the safer one.
  const TERMS = ['delegated', 'kept', 'provider', 'dedicated'];
  const REFUSALS = {
    'sign-in-windows': 'windows',
    'sign-in-identity-provider': 'identityProvider',
    'sign-in-not-running': 'notRunning',
    'sign-in-unsaved': 'unsaved',
  };
  // Only Team saying so ends the session here: after any other failed Save it may still run, so Cancel still asks Team.
  const ENDED = 'sign-in-not-running';

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
        if (!controller.signal.aborted && status !== 'ended') status = 'lost';
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
    if (working || status === 'ended') return;
    working = 'saving';
    error = '';
    try {
      await saveSignIn(session.teamId, session.sessionId);
      onclose(copy.saved);
    } catch (failed) {
      error = refusal(failed, copy.unsaved);
      working = '';
      if (failed?.code === ENDED) status = 'ended';
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
      <!-- Saving ends the screen by design: its state shows only once the Save answered. -->
      {#if status !== 'showing' && working !== 'saving'}
        <p class="status" role="status">{copy[status]}</p>
      {/if}
      {#if status === 'lost' && !working}
        <DialogAction kind="retry" type="button" disabled={Boolean(working)} onclick={connect}>{copy.reconnect}</DialogAction>
      {/if}
      {#if status !== 'ended'}
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
          <DialogAction kind="confirm" type="submit" disabled={Boolean(working) || !$commandsReady}>
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
