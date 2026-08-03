<script>
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
    <a href={token.href} target="_blank" rel="noopener noreferrer">{token.text}</a>
  {:else}
    {token.text}
  {/if}
{/each}
