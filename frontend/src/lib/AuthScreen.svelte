<script>
  import { Button, Card, Notice, ShimpzBrand, TextField } from '@shimpz/frontend';
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
  let recovery = $derived(phase === 'recovery');
  let confirmationError = $derived(setup && error === $t('auth.mismatch') ? error : '');
  let formError = $derived(confirmationError ? '' : error);
</script>

<section class="auth-stage" aria-labelledby="auth-title">
  <div class="welcome">
    <p class="kicker">{phase === 'login' ? $t('auth.returning') : $t('auth.firstRun')}</p>
    <ShimpzBrand variant="hero" />
    <div class="welcome-copy">
      <p class="hero-title">{$t('auth.heroTitle')}</p>
    </div>
  </div>

  <Card class="auth-panel" tone="accent">
    {#if phase === 'checking'}
      <div class="checking" aria-live="polite">
        <div class="scanner" aria-hidden="true"><span></span></div>
        <h1 id="auth-title">{$t('auth.checking')}</h1>
        {#if error}
          <Notice variant="error">{error}</Notice>
          <Button variant="secondary" type="button" onclick={onRetry}>{$t('auth.retry')}</Button>
        {/if}
      </div>
    {:else if recovery}
      <h1 id="auth-title">{$t('auth.recoveryTitle')}</h1>
      <p class="lead">{$t('auth.recoveryLead')}</p>
      <div class="recovery-commands" aria-label={$t('auth.recoveryCommands')}>
        <code>shimpz reset</code>
        <code>shimpz install</code>
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
          minlength={setup ? 15 : undefined}
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
            minlength="15"
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
  </Card>
</section>

<style>
  .auth-stage {
    display: grid;
    min-height: min(30rem, calc(100vh - 10rem));
    grid-template-columns: minmax(0, 1.1fr) minmax(18.5rem, 0.9fr);
    align-items: center;
    gap: clamp(1.5rem, 5vw, 4rem);
  }

  .welcome {
    position: relative;
    padding: 1rem 0;
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
    margin: 0 0 0.8rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .welcome-copy {
    max-width: 38rem;
    margin-top: clamp(0.9rem, 2vw, 1.4rem);
  }

  .welcome-copy .hero-title {
    max-width: 13ch;
    margin: 0;
    font-size: clamp(1.5rem, 3vw, 2.3rem);
    line-height: 1.14;
    letter-spacing: -0.045em;
    text-wrap: balance;
  }

  .lead {
    color: var(--text-dim);
    line-height: 1.7;
  }

  :global(.auth-panel [data-slot="card-content"]) { display: grid; gap: 0.8rem; }

  h1 {
    margin: 0;
    font-size: clamp(1.4rem, 2.6vw, 1.9rem);
    line-height: 1.18;
    letter-spacing: -0.045em;
    text-wrap: balance;
  }

  .lead {
    margin: 0.5rem 0 1.1rem;
  }

  form {
    display: grid;
    gap: 0.55rem;
  }

  .recovery-commands {
    display: grid;
    gap: 0.5rem;
  }

  .recovery-commands code {
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--border);
    color: var(--accent);
    font-family: var(--font-mono);
  }

  .checking {
    min-height: 14rem;
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
