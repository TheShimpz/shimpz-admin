<script>
  import { Button } from '@shimpz/frontend';

  // The one Admin dialog or prompt action: its label followed by the mnemonic icon of its kind, on the shared Button.
  // Every Admin button glitches on hover and focus (app.css), so an action chooses only its kind. Every other Button
  // attribute (type, disabled, onclick, aria, size, class) passes through unchanged; `variant` overrides the kind's
  // only for an alternative action that is not the dialog's primary one.
  const KINDS = {
    cancel: { variant: 'secondary', icon: 'M6 6l12 12M18 6 6 18' },
    confirm: { variant: 'primary', icon: 'M5 12h14M13 6l6 6-6 6' },
    danger: { variant: 'danger', icon: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5' },
    retry: { variant: 'primary', icon: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5' },
    dismiss: { variant: 'ghost', icon: 'M6 12h12' },
  };

  let { kind, variant, element = $bindable(), children, ...attributes } = $props();
  let action = $derived(KINDS[kind]);
</script>

<Button bind:element variant={variant ?? action.variant} {...attributes}>
  {@render children?.()}
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d={action.icon}></path></svg>
</Button>

<style>
  svg { flex: 0 0 auto; width: 0.95rem; height: 0.95rem; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
</style>
