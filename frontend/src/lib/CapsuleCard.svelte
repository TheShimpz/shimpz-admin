<script>
  import DriverCredentialPanel from '$lib/DriverCredentialPanel.svelte';
  import { t } from '$lib/i18n.js';

  let { capsule, busy = false, showCredentials = true, onDelete } = $props();
  let running = $derived(capsule.status === 'running');
</script>

<article class="capsule-card">
  <header>
    <div class="runtime-status" class:running>
      <i aria-hidden="true"></i>
      <span>{capsule.status}</span>
    </div>
    <code>{capsule.id}</code>
  </header>

  <div class="identity">
    <h2>{capsule.name || capsule.id}</h2>
  </div>

  {#if showCredentials}
    <section class="drivers" aria-label={$t('capsules.drivers')}>
      <div class="drivers-heading">
        <div>
          <h3>{$t('capsules.drivers')}</h3>
          <p>{$t('capsules.driversLead')}</p>
        </div>
        <span>BYOK</span>
      </div>
      <DriverCredentialPanel capsuleId={capsule.id} driverId="r2" />
    </section>
  {/if}

  <footer>
    <a href={`/assistants/?capsule=${encodeURIComponent(capsule.id)}`}>{$t('store.nav')} <span aria-hidden="true">→</span></a>
    <button type="button" onclick={() => onDelete(capsule)} disabled={busy}>
      {$t('capsules.destroy')}
    </button>
  </footer>
</article>

<style>
  .capsule-card {
    position: relative;
    display: flex;
    min-width: 0;
    flex-direction: column;
    background: linear-gradient(145deg, var(--surface-2), var(--surface-1));
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    box-shadow: inset 0 0 0 1px var(--border);
    transition: transform 0.15s var(--ease), box-shadow 0.15s var(--ease), filter 0.15s var(--ease);
  }

  .capsule-card:hover {
    box-shadow: inset 0 0 0 1px rgba(0, 240, 255, 0.38);
    filter: drop-shadow(0 0 10px rgba(0, 240, 255, 0.1));
    transform: translateY(-2px);
  }

  .capsule-card > header {
    display: flex;
    min-height: 3.25rem;
    align-items: center;
    justify-content: space-between;
    padding: 0 1.1rem;
    border-bottom: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.28);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .runtime-status {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--text-faint);
  }

  .runtime-status i {
    width: 0.44rem;
    height: 0.44rem;
    flex: none;
    background: var(--text-faint);
    border-radius: 50%;
  }

  .runtime-status.running {
    color: var(--success);
  }

  .runtime-status.running i {
    background: var(--success);
    box-shadow: 0 0 8px rgba(5, 255, 161, 0.55);
  }

  .capsule-card > header code { max-width: 55%; overflow: hidden; color: var(--text-faint); font-size: 0.58rem; text-overflow: ellipsis; text-transform: none; white-space: nowrap; }

  .identity {
    padding: 1.35rem 1.1rem 1.15rem;
  }

  h2 {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: clamp(1.25rem, 2.4vw, 1.6rem);
    line-height: 1.25;
    letter-spacing: -0.04em;
  }

  .drivers {
    flex: 1;
    padding: 1.15rem 1.1rem 0.9rem;
  }

  .drivers-heading {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 1rem;
  }

  h3 {
    margin: 0;
    font-size: 0.78rem;
    letter-spacing: -0.01em;
  }

  .drivers-heading p {
    margin: 0.25rem 0 0;
    color: var(--text-faint);
    font-size: 0.72rem;
    line-height: 1.45;
  }

  .drivers-heading > span {
    padding: 0.15rem 0.4rem;
    border: 1px solid rgba(0, 240, 255, 0.35);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.5rem;
    font-weight: 600;
    letter-spacing: 0.12em;
  }

  footer {
    display: flex;
    min-height: 3.5rem;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.55rem 1.1rem;
    border-top: 1px solid var(--border);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  footer button {
    min-height: 2.35rem;
    border: 1px solid rgba(255, 96, 125, 0.35);
    padding: 0 0.65rem;
    background: transparent;
    color: var(--danger);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  footer a {
    display: inline-flex;
    min-height: 2.35rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.65rem;
    border: 1px solid var(--border-strong);
    color: var(--accent);
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-decoration: none;
  }

  footer button:hover:not(:disabled) {
    border-color: var(--danger);
    background: rgba(255, 96, 125, 0.06);
  }

  footer button:disabled {
    cursor: default;
    opacity: 0.45;
  }

</style>
