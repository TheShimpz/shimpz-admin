<script>
  import ShimpzBrand from '$lib/ShimpzBrand.svelte';
  import { t } from '$lib/i18n.js';

  let {
    phase,
    password = $bindable(''),
    confirmation = $bindable(''),
    error = '',
    busy = false,
    onSubmit,
    onRetry,
  } = $props();

  let setup = $derived(phase === 'setup');
</script>

<section class="auth-stage" aria-labelledby="auth-title">
  <div class="welcome">
    <p class="kicker">{$t('auth.firstRun')}</p>
    <ShimpzBrand variant="hero" />
    <div class="welcome-copy">
      <h2>{$t('auth.heroTitle')}</h2>
      <p>{$t('auth.heroLead')}</p>
    </div>
    <ul aria-label="Shimpz principles">
      <li><i aria-hidden="true"></i>{$t('auth.localControl')}</li>
      <li><i aria-hidden="true"></i>{$t('auth.capsuleIsolation')}</li>
      <li><i aria-hidden="true"></i>{$t('auth.driverReady')}</li>
    </ul>
  </div>

  <div class="auth-panel">
    {#if phase === 'checking'}
      <div class="checking" aria-live="polite">
        <div class="scanner" aria-hidden="true"><span></span></div>
        <p class="eyebrow">Space // handshake</p>
        <h1 id="auth-title">{$t('auth.checking')}</h1>
        <p>Loading the local control plane and checking your session.</p>
        {#if error}
          <p class="message error" role="alert">{error}</p>
          <button class="secondary" type="button" onclick={onRetry}>{$t('auth.retry')}</button>
        {/if}
      </div>
    {:else}
      <p class="eyebrow">{setup ? $t('auth.firstRun') : $t('auth.returning')}</p>
      <h1 id="auth-title">{setup ? $t('auth.setupTitle') : $t('auth.loginTitle')}</h1>
      <p class="lead">{setup ? $t('auth.setupLead') : $t('auth.loginLead')}</p>

      <form onsubmit={(event) => (event.preventDefault(), onSubmit())}>
        <label for="admin-password">{$t('auth.password')}</label>
        <input
          id="admin-password"
          type="password"
          bind:value={password}
          autocomplete={setup ? 'new-password' : 'current-password'}
          aria-describedby={setup ? 'password-hint' : undefined}
          required
          minlength={setup ? 12 : undefined}
          disabled={busy}
        />

        {#if setup}
          <p id="password-hint" class="hint">{$t('auth.passwordHint')}</p>
          <label for="admin-password-confirm">{$t('auth.confirm')}</label>
          <input
            id="admin-password-confirm"
            type="password"
            bind:value={confirmation}
            autocomplete="new-password"
            required
            minlength="12"
            disabled={busy}
          />
        {/if}

        {#if error}<p class="message error" role="alert">{error}</p>{/if}

        <button class="primary" type="submit" disabled={busy || !password}>
          <span>{busy ? $t('auth.checking') : setup ? $t('auth.create') : $t('auth.signIn')}</span>
          <span aria-hidden="true">→</span>
        </button>
      </form>

      <p class="privacy"><span aria-hidden="true">◆</span> Local-first administration. No cloud account required.</p>
    {/if}
  </div>
</section>

<style>
  .auth-stage {
    display: grid;
    min-height: min(42rem, calc(100vh - 13rem));
    grid-template-columns: minmax(0, 1.2fr) minmax(20rem, 0.8fr);
    align-items: center;
    gap: clamp(2rem, 7vw, 7rem);
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

  .kicker,
  .eyebrow {
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
    margin-top: clamp(1.7rem, 4vw, 3rem);
  }

  .welcome-copy h2 {
    max-width: 13ch;
    margin: 0;
    font-size: clamp(1.65rem, 3.4vw, 2.75rem);
    line-height: 1.12;
    letter-spacing: -0.045em;
    text-wrap: balance;
  }

  .welcome-copy p,
  .lead,
  .checking > p:not(.eyebrow):not(.message) {
    color: var(--text-dim);
    line-height: 1.7;
  }

  .welcome-copy p {
    max-width: 57ch;
    margin: 1rem 0 0;
    font-size: 1rem;
  }

  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem 1.2rem;
    padding: 1.5rem 0 0;
    margin: 1.5rem 0 0;
    border-top: 1px solid var(--border);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    list-style: none;
    text-transform: uppercase;
  }

  li {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  li i {
    width: 0.35rem;
    height: 0.35rem;
    background: var(--success);
    border-radius: 50%;
    box-shadow: 0 0 7px rgba(5, 255, 161, 0.55);
  }

  .auth-panel {
    position: relative;
    padding: clamp(1.5rem, 4vw, 2.4rem);
    background: linear-gradient(145deg, var(--surface-2), var(--surface-1));
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    box-shadow: inset 0 0 0 1px var(--border-strong), var(--shadow);
  }

  .auth-panel::before {
    position: absolute;
    top: 0;
    right: var(--cut);
    left: var(--cut);
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), var(--accent-alt), transparent);
    content: '';
    opacity: 0.8;
  }

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

  label {
    margin-top: 0.35rem;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  input {
    width: 100%;
    min-height: 3.2rem;
    border: 0;
    padding: 0.75rem 1rem;
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
    color: var(--text);
    font-family: var(--font-mono);
    outline: 0;
  }

  input:hover {
    box-shadow: inset 0 0 0 1px var(--text-faint);
  }

  input:focus {
    box-shadow: inset 0 0 0 1px var(--accent);
    filter: drop-shadow(0 0 7px rgba(0, 240, 255, 0.2));
  }

  .hint {
    margin: -0.1rem 0 0.25rem;
    color: var(--text-faint);
    font-size: 0.75rem;
  }

  button {
    min-height: 2.75rem;
    border: 0;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  button:disabled {
    cursor: default;
    opacity: 0.48;
  }

  .primary {
    display: flex;
    min-height: 3.15rem;
    align-items: center;
    justify-content: space-between;
    padding: 0 1.1rem;
    margin-top: 0.75rem;
    background: linear-gradient(100deg, var(--accent), var(--accent-alt));
    clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
    color: var(--accent-ink);
  }

  .primary:hover:not(:disabled) {
    filter: brightness(1.08) drop-shadow(0 0 12px rgba(0, 240, 255, 0.35));
  }

  .secondary {
    padding: 0 0.9rem;
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--accent);
  }

  .message {
    padding: 0.7rem 0.8rem;
    margin: 0.55rem 0 0;
    border-inline-start: 2px solid currentColor;
    background: rgba(255, 96, 125, 0.07);
    font-size: 0.82rem;
  }

  .error {
    color: var(--danger);
  }

  .privacy {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 1.25rem 0 0;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.62rem;
    line-height: 1.5;
    text-transform: uppercase;
  }

  .privacy span {
    color: var(--success);
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

    .auth-panel {
      width: min(100%, 34rem);
      margin: 0 auto;
    }
  }
</style>
