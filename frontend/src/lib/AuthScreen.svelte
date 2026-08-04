<script>
  import { Button, Notice, Panel, ShimpzBrand, TextField } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';

  let {
    phase,
    profile = '',
    confirmOrigin = false,
    username = $bindable(''),
    password = $bindable(''),
    confirmation = $bindable(''),
    error = '',
    busy = false,
    onSubmit,
    onRetry,
  } = $props();

  let setup = $derived(phase === 'setup');
  let hosted = $derived(profile === 'hosted');
  let confirmationError = $derived(setup && error === $t('auth.mismatch') ? error : '');
  let formError = $derived(confirmationError ? '' : error);
</script>

<section class="auth-stage" aria-labelledby="auth-title">
  <div class="welcome">
    <p class="kicker">{phase === 'login' ? $t('auth.returning') : $t('auth.firstRun')}</p>
    <ShimpzBrand variant="hero" />
    <div class="welcome-copy">
      <h2>{$t('auth.heroTitle')}</h2>
    </div>
  </div>

  <Panel class="auth-panel" tone="accent">
    {#if phase === 'checking'}
      <div class="checking" aria-live="polite">
        <div class="scanner" aria-hidden="true"><span></span></div>
        <h1 id="auth-title">{$t('auth.checking')}</h1>
        {#if error}
          <Notice variant="error">{error}</Notice>
          <Button variant="secondary" type="button" onclick={onRetry}>{$t('auth.retry')}</Button>
        {/if}
      </div>
    {:else}
      <h1 id="auth-title">
        {setup
          ? $t('auth.setupTitle')
          : hosted
            ? $t('auth.hostedLoginTitle')
            : confirmOrigin
              ? $t('auth.originTitle')
              : $t('auth.loginTitle')}
      </h1>
      <p class="lead">
        {setup
          ? $t('auth.setupLead')
          : hosted
            ? $t('auth.hostedLoginLead')
            : confirmOrigin
              ? $t('auth.originLead')
              : $t('auth.loginLead')}
      </p>

      <form onsubmit={(event) => (event.preventDefault(), onSubmit())}>
        {#if hosted}
          <TextField
            id="account-username"
            label={$t('auth.username')}
            type="text"
            bind:value={username}
            autocomplete="username"
            maxlength="32"
            required
            disabled={busy}
          />
        {/if}
        <TextField
          id="admin-password"
          label={$t('auth.password')}
          type="password"
          bind:value={password}
          autocomplete={setup ? 'new-password' : 'current-password'}
          hint={setup ? $t('auth.passwordHint') : undefined}
          required
          minlength={setup ? 12 : undefined}
          disabled={busy}
        />

        {#if setup}
          <TextField
            id="admin-password-confirm"
            label={$t('auth.confirm')}
            type="password"
            bind:value={confirmation}
            autocomplete="new-password"
            required
          minlength="12"
          disabled={busy}
          error={confirmationError}
        />
      {/if}

        {#if formError}<Notice variant="error">{formError}</Notice>{/if}

        <Button type="submit" disabled={busy || !password || (hosted && !username)}>
          <span>{busy ? $t('auth.checking') : setup ? $t('auth.create') : $t('auth.signIn')}</span>
          <span aria-hidden="true">→</span>
        </Button>
      </form>
    {/if}
  </Panel>
</section>

<style>
  .auth-stage {
    display: grid;
    min-height: min(34rem, calc(100vh - 13rem));
    grid-template-columns: minmax(0, 1.2fr) minmax(20rem, 0.8fr);
    align-items: center;
    gap: clamp(2rem, 6vw, 5rem);
  }

  .welcome {
    position: relative;
    padding: 2rem 0;
  }

  .welcome::before {
    position: absolute;
    z-index: -1;
    top: 5%;
    left: 2%;
    width: min(34rem, 90%);
    height: 85%;
    background: radial-gradient(circle, rgba(0, 240, 255, 0.075), transparent 68%);
    content: '';
  }

  .kicker {
    margin: 0 0 1.2rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }

  .welcome-copy {
    max-width: 38rem;
    margin-top: clamp(1.25rem, 3vw, 2rem);
  }

  .welcome-copy h2 {
    max-width: 13ch;
    margin: 0;
    font-size: clamp(1.65rem, 3.4vw, 2.75rem);
    line-height: 1.12;
    letter-spacing: -0.045em;
    text-wrap: balance;
  }

  .lead {
    color: var(--text-dim);
    line-height: 1.7;
  }

  :global(.auth-panel) { display: grid; gap: 1rem; padding: clamp(1.5rem, 4vw, 2.4rem); }

  h1 {
    margin: 0;
    font-size: clamp(1.65rem, 3vw, 2.3rem);
    line-height: 1.18;
    letter-spacing: -0.045em;
    text-wrap: balance;
  }

  .lead {
    margin: 0.8rem 0 1.6rem;
  }

  form {
    display: grid;
    gap: 0.65rem;
  }

  .checking {
    min-height: 18rem;
    display: flex;
    justify-content: center;
    flex-direction: column;
  }

  .scanner {
    position: relative;
    width: 3rem;
    height: 3rem;
    margin-bottom: 1.5rem;
    border: 1px solid var(--border-strong);
    clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
    overflow: hidden;
  }

  .scanner::before,
  .scanner::after {
    position: absolute;
    background: var(--accent);
    content: '';
  }

  .scanner::before {
    top: 50%;
    right: 0.5rem;
    left: 0.5rem;
    height: 1px;
  }

  .scanner::after {
    top: 0.5rem;
    bottom: 0.5rem;
    left: 50%;
    width: 1px;
  }

  .scanner span {
    position: absolute;
    z-index: 2;
    inset: 0;
    background: linear-gradient(180deg, transparent, rgba(255, 42, 109, 0.45), transparent);
    animation: scan 1.5s ease-in-out infinite;
    transform: translateY(-100%);
  }

  @keyframes scan {
    100% { transform: translateY(100%); }
  }

  @media (max-width: 850px) {
    .auth-stage {
      grid-template-columns: 1fr;
      gap: 1rem;
    }

    .welcome {
      padding-bottom: 1rem;
    }

    :global(.auth-panel) {
      width: min(100%, 34rem);
      margin: 0 auto;
    }
  }
</style>
