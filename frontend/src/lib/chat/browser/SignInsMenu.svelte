<script>
  import { Button, TextField } from '@shimpz/frontend';

  import ComposerPanel from '#lib/brain/ComposerPanel.svelte';
  import { hidePanel } from '#lib/brain/panel.js';
  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import { dateFormat } from '#lib/i18n/formats.js';
  import { locale, t } from '#lib/i18n/index.js';
  import { showAdminNotice } from '#lib/shell/notice.js';
  import SignInDialog from './SignInDialog.svelte';
  import { forgetSignIn, startSignIn, startUrl, teamSignIns } from './signIns.js';

  // A Team's Sign-ins in their own composer control (ADR-0117, Sign-ins amendment): each one's account label, site,
  // last use, and expiry with Forget, and where the person signs in to a site. Starting opens the sign-in dialog, which
  // outlives this panel; what shows here is the list Admin read, read again whenever it changes.
  let { teamId, disabled = false } = $props();

  let open = $state(false);
  let panel = $state();
  let url = $state('');
  let working = $state('');
  let error = $state('');
  let session = $state(null);
  let listed = $state(null);

  let copy = $derived($t('signIns'));
  let blocked = $derived(Boolean(working) || !$commandsReady);
  let signIns = $derived(listed?.teamId === teamId ? listed.value : null);
  let phase = $derived(listed?.teamId === teamId && listed.status === 'error' ? 'unavailable' : signIns ? 'ready' : 'loading');

  $effect(() => {
    const shownTeamId = open ? teamId : '';
    if (!shownTeamId) {
      listed = null;
      return undefined;
    }
    return teamSignIns(shownTeamId).subscribe((state) => { listed = { teamId: shownTeamId, ...state }; });
  });

  const REFUSALS = {
    'sign-in-url-invalid': 'urlInvalid',
    'browser-busy': 'busy',
  };

  function day(at) {
    return dateFormat($locale, { dateStyle: 'medium' }).format(new Date(at));
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
    working = 'starting';
    error = '';
    const forTeam = teamId;
    try {
      const started = await startSignIn(forTeam, url, $locale);
      session = { teamId: forTeam, ...started };
      url = '';
      hidePanel(panel);
      open = false;
    } catch (failed) {
      error = outcomeUnknown(failed) ? $t('shell.outcomeUnknown') : copy[REFUSALS[failed?.code]] ?? copy.startFailed;
    }
    working = '';
  }

  async function forget(signInId) {
    if (blocked) return;
    working = signInId;
    error = '';
    try {
      await forgetSignIn(teamId, signInId);
    } catch (failed) {
      error = outcomeUnknown(failed) ? $t('shell.outcomeUnknown') : copy.forgetFailed;
    }
    working = '';
  }

  function ended(message) {
    session = null;
    if (message) showAdminNotice({ tone: 'success', message });
  }
</script>

<ComposerPanel
  bind:open
  bind:panel
  label={copy.label}
  {disabled}
  busy={phase === 'loading' || blocked}
  focusTarget={'input'}
  content={`${phase}:${signIns?.length ?? 0}:${error}`}
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
    {:else if signIns.length === 0}
      <p class="status">{copy.empty}</p>
    {:else}
      <ul class="sign-ins" aria-label={copy.label}>
        {#each signIns as signIn (signIn.sign_in_id)}
          <li>
            <div class="sign-in">
              <strong><bdi>{signIn.label}</bdi></strong>
              <span><bdi>{signIn.site}</bdi></span>
              <span>{$t('signIns.dates', { used: day(signIn.last_used_at), expires: day(signIn.expires_at) })}</span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={blocked}
              aria-label={$t('signIns.forgetOne', { label: signIn.label, site: signIn.site })}
              onclick={() => forget(signIn.sign_in_id)}
            >
              {working === signIn.sign_in_id ? copy.forgetting : copy.forget}
            </Button>
          </li>
        {/each}
      </ul>
      <p class="summary">{copy.forgetNote}</p>
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
        {working === 'starting' ? copy.starting : copy.start}
      </Button>
    </form>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  {/snippet}
</ComposerPanel>

{#if session}
  <SignInDialog {session} onclose={ended} />
{/if}

<style>
  .sign-ins { display: grid; gap: var(--gap-item); margin: 0; padding: 0; list-style: none; }
  .sign-ins li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--gap-item); }
  .sign-in { display: grid; gap: 0.15rem; min-width: 0; }
  .sign-in strong { overflow: hidden; color: var(--shimpz-color-text); font-size: 0.8rem; text-overflow: ellipsis; white-space: nowrap; }
  .sign-in span { color: var(--shimpz-color-text-muted); font: 400 0.66rem/1.4 var(--shimpz-font-mono); }
  .start { display: grid; gap: var(--gap-inside); justify-items: start; }
  .start :global(.shimpz-field) { width: 100%; }
</style>
