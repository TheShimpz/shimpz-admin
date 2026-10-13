<script>
  import { TextLink } from '@shimpz/frontend';
  let { tokens = [] } = $props();
</script>

{#each tokens as token}
  {#if token.type === 'code'}
    <code>{token.text}</code>
  {:else if token.type === 'strong'}
    <strong>{token.text}</strong>
  {:else if token.type === 'emphasis'}
    <em>{token.text}</em>
  {:else if token.type === 'link'}
    <TextLink href={token.href} external>{token.text}{#if token.host}{' '}<span class="link-host">({token.host})</span>{/if}</TextLink>
  {:else}
    {token.text}
  {/if}
{/each}

<style>
  .link-host { font-family: var(--font-mono); font-size: 0.86em; }
</style>
