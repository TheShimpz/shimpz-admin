<script>
  import { Notice, RadioField, TextField } from '@shimpz/frontend';

  // The fields of one Supervisor confirmation (ADR-0051): the Supervisor password, then one second factor, a code by
  // default and a passkey beside it only where the confirmation offers one, and the refusal it words. `form` is the
  // host's Confirmation, which runs the confirmation and owns what is typed; `id` prefixes the fields' ids, so it can
  // focus `${id}-password` and `${id}-code`. `copy` labels the fields: password, method, methodCode, methodPasskey,
  // code, its optional codeHint, and passkeyHint.
  let { id, copy, form } = $props();
</script>

<TextField id={`${id}-password`} label={copy.password} type="password" bind:value={form.password}
  autocomplete="current-password" required disabled={form.busy} error={form.passwordError} />
{#if form.passkeyOffered}
  <fieldset class="method" disabled={form.busy}>
    <legend>{copy.method}</legend>
    <RadioField id={`${id}-method-code`} name={`${id}-method`} label={copy.methodCode} optionValue="totp" bind:value={form.method} />
    <RadioField id={`${id}-method-passkey`} name={`${id}-method`} label={copy.methodPasskey} optionValue="passkey" bind:value={form.method} />
  </fieldset>
{/if}
{#if form.method === 'totp'}
  <TextField id={`${id}-code`} label={copy.code} hint={copy.codeHint} type="text" bind:value={form.code}
    autocomplete="one-time-code" inputmode="numeric" pattern={'[0-9]{6}'} minlength="6" maxlength="6" required
    disabled={form.busy} error={form.codeError} />
{:else}
  <p class="hint">{copy.passkeyHint}</p>
{/if}
{#if form.error}<Notice variant="error">{form.error}</Notice>{/if}

<style>
  .method { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--gap-group); min-width: 0; margin: 0; padding: 0; border: 0; }
  .method legend { margin-block-end: var(--gap-item); padding: 0; color: var(--shimpz-color-text); font: 600 0.7rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.07em; }
  .hint { margin: 0; color: var(--shimpz-color-text-dim); font-size: 0.8rem; line-height: 1.45; }
</style>
