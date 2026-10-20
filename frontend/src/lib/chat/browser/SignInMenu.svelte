<script>
  import { Button, DialogFrame, Modal, TextField } from '@shimpz/frontend';

  import ComposerPanel from '#lib/brain/ComposerPanel.svelte';
  import { hidePanel } from '#lib/brain/panel.js';
  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import { dateFormat } from '#lib/i18n/formats.js';
  import { locale, t } from '#lib/i18n/index.js';
  import { showAdminNotice } from '#lib/shell/notice.js';
  import SignInDeletion from './SignInDeletion.svelte';
  import SignInDialog from './SignInDialog.svelte';
  import { startSignIn, startUrl, teamSignIn } from './signIns.js';

  // The Team's browser session in its own composer control (ADR-0117, 2026-10-20 amendment): its state, the sites
  // found in its saved cookies, and its dates; where the person signs in to a site, which opens the session; and its
  // deletion, which takes the password and a second factor. The sign-in and deletion dialogs outlive this panel; what
  // shows here is the session Admin read, read again whenever it changes.
  let { teamId, disabled = false } = $props();

  let open = $state(false);
  let panel = $state();
  let url = $state('');
  let working = $state(false);
  let error = $state('');
  let session = $state(null);
  let deleting = $state(null);
  let deletionDialog = $state();
  let read = $state(null);

  let copy = $derived($t('signIn'));
  let blocked = $derived(working || !$commandsReady);
  let current = $derived(read?.teamId === teamId && read.status !== 'loading' ? read : null);
  let phase = $derived(current === null ? 'loading' : current.status === 'error' ? 'unavailable' : 'ready');
  let signIn = $derived(phase === 'ready' ? current.value : null);
  const deletionTitle = $props.id();

  $effect(() => {
    const shownTeamId = open ? teamId : '';
    if (!shownTeamId) {
      read = null;
      return undefined;
    }
    return teamSignIn(shownTeamId).subscribe((state) => { read = { teamId: shownTeamId, ...state }; });
  });

  $effect(() => {
    if (!deletionDialog) return;
    if (deleting && !deletionDialog.open) deletionDialog.showModal();
    if (!deleting && deletionDialog.open) deletionDialog.close();
  });

  const REFUSALS = {
    'sign-in-url-invalid': 'urlInvalid',
    'browser-busy': 'busy',
    'sign-in-busy': 'inUse',
  };

  function day(at) {
    return dateFormat($locale, { dateStyle: 'medium' }).format(new Date(at));
  }

  function close() {
    hidePanel(panel);
    open = false;
  }

  async function start(event) {
    // This panel's form sits inside the chat's composer form: its submit never reaches the composer.
    event.preventDefault();
    event.stopPropagation();
    if (blocked) return;
    if (!startUrl(url)) {
      error = copy.urlInvalid;
      return;
    }
    working = true;
    error = '';
    const forTeam = teamId;
    try {
      const started = await startSignIn(forTeam, url, $locale);
      session = { teamId: forTeam, ...started };
      url = '';
      close();
    } catch (failed) {
      error = outcomeUnknown(failed) ? $t('shell.outcomeUnknown') : copy[REFUSALS[failed?.code]] ?? copy.startFailed;
    }
    working = false;
  }

  function deleteSession() {
    deleting = { teamId, signIn };
    close();
  }

  function ended(message, tone = 'success') {
    session = null;
    if (message) showAdminNotice({ tone, message });
  }

  function deleted(outcome) {
    deleting = null;
    showAdminNotice({ tone: 'success', message: outcome === 'pending' ? copy.deletePending : copy.deleted });
  }
</script>

<ComposerPanel
  bind:open
  bind:panel
  label={copy.label}
  {disabled}
  busy={phase === 'loading' || blocked}
  focusTarget={'input'}
  content={`${phase}:${signIn?.generation ?? 0}:${error}`}
  onclose={() => { error = ''; }}
>
  {#snippet icon()}
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h5v16h-5M10 8l4 4-4 4M14 12H3"></path></svg>
  {/snippet}
  {#snippet children(panelId)}
    <p class="title" id={`${panelId}-title`}>{copy.label}</p>
    <p class="summary">{copy.summary}</p>
    {#if phase === 'unavailable'}
      <p class="status" role="status">{copy.unavailable}</p>
    {:else if phase === 'loading'}
      <p class="status">…</p>
    {:else if signIn === null}
      <p class="status">{copy.empty}</p>
    {:else}
      <section class="session" aria-label={copy.label}>
        <p class="state" data-state={signIn.state}>{signIn.state === 'ready' ? copy.ready : copy.needsPerson}</p>
        <p class="detail">{copy.sitesLabel}</p>
        {#if signIn.sites.length}
          <ul class="sites">
            {#each signIn.sites as site (site)}<li><bdi>{site}</bdi></li>{/each}
          </ul>
        {:else}
          <p class="detail">{copy.noSites}</p>
        {/if}
        {#if signIn.sites_truncated}<p class="detail">{copy.moreSites}</p>{/if}
        <p class="detail">{$t('signIn.dates', { saved: day(signIn.saved_at), expires: day(signIn.expires_at) })}</p>
      </section>
    {/if}
    <form class="start" onsubmit={start}>
      <TextField
        id={`${panelId}-url`}
        label={copy.urlLabel}
        placeholder="https://example.com"
        bind:value={url}
        inputmode="url"
        autocomplete="url"
        spellcheck="false"
        disabled={blocked}
      />
      <Button type="submit" size="sm" variant="primary" disabled={blocked || !url.trim()}>
        {working ? copy.starting : copy.start}
      </Button>
    </form>
    {#if signIn !== null}
      <p class="summary">{copy.deleteNote}</p>
      <Button type="button" size="sm" variant="danger" disabled={blocked} onclick={deleteSession}>{copy.delete}</Button>
    {/if}
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  {/snippet}
</ComposerPanel>

{#if session}
  <SignInDialog {session} onclose={ended} />
{/if}

<Modal size="md" bind:element={deletionDialog} labelledBy={deletionTitle} oncancel={(event) => { event.preventDefault(); deleting = null; }}>
  {#if deleting}
    <DialogFrame kicker={copy.label} title={copy.deleteTitle} titleId={deletionTitle}>
      <SignInDeletion
        teamId={deleting.teamId}
        signIn={deleting.signIn}
        copy={copy.deletion}
        ondone={deleted}
        oncancel={() => { deleting = null; }}
      />
    </DialogFrame>
  {/if}
</Modal>

<style>
  .session { display: grid; gap: var(--gap-inside); }
  .state { margin: 0; color: var(--shimpz-color-cyan); font: 700 0.72rem/1.4 var(--shimpz-font-mono); }
  .state[data-state="needs-person"] { color: var(--shimpz-color-warning, var(--shimpz-color-danger)); }
  .detail { margin: 0; color: var(--shimpz-color-text-muted); font: 400 0.66rem/1.4 var(--shimpz-font-mono); }
  .sites { display: flex; flex-wrap: wrap; gap: var(--gap-inside); margin: 0; padding: 0; list-style: none; }
  .sites li { padding: 0.1rem 0.4rem; border: 1px solid var(--shimpz-color-border); color: var(--shimpz-color-text); font-size: 0.72rem; }
  .start { display: grid; gap: var(--gap-inside); justify-items: start; }
  .start :global(.shimpz-field) { width: 100%; }
</style>
