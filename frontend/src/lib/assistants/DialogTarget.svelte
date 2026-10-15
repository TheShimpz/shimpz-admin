<script>
  import { Card } from '@shimpz/frontend';

  // One thing a Store dialog acts on: what it is, its name, and its exact id. `nameDir` keeps a name that is not
  // language text, such as a version and platform, left to right.
  let { label, name, id = '', nameDir = undefined } = $props();
</script>

<Card class="dialog-target" padding="compact">
  <span class="label">{label}</span>
  <strong dir={nameDir}>{name}</strong>
  {#if id}<code dir="ltr">{id}</code>{/if}
</Card>

<style>
  :global(.dialog-target > [data-slot="card-content"]) { display: grid; gap: var(--gap-inside); }
  .label {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  strong { font-size: 0.9rem; }
  code { overflow-wrap: anywhere; color: var(--accent); font-size: 0.65rem; }
</style>
