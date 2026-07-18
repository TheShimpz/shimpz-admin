<script>
  import { onMount } from 'svelte';
  import AdminShell from '$lib/AdminShell.svelte';
  import AuthScreen from '$lib/AuthScreen.svelte';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import { t } from '$lib/i18n.js';

  let phase = $state('checking');
  let password = $state('');
  let confirmation = $state('');
  let error = $state('');
  let busy = $state(false);

  function enterAdmin() {
    location.replace('/chat/');
  }

  async function checkSession() {
    phase = 'checking';
    error = '';
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('session unavailable');
      const session = await response.json();
      if (!session.initialized) phase = 'setup';
      else if (!session.authenticated) phase = 'login';
      else enterAdmin();
    } catch {
      error = $t('auth.unreachable');
    }
  }

  async function submit() {
    if (busy) return;
    error = '';
    if (phase === 'setup' && password.length < 12) {
      error = $t('auth.tooShort');
      return;
    }
    if (phase === 'setup' && password !== confirmation) {
      error = $t('auth.mismatch');
      return;
    }

    busy = true;
    try {
      const response = await fetch(phase === 'setup' ? '/api/admin/setup' : '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        error = response.status === 401 ? $t('auth.badPassword') : (body.detail ?? `HTTP ${response.status}`);
        return;
      }
      password = confirmation = '';
      enterAdmin();
    } catch {
      error = $t('auth.unreachable');
    } finally {
      busy = false;
    }
  }

  onMount(checkSession);
</script>

<svelte:head>
  <title>Shimpz Team Admin</title>
  <meta name="description" content="Sign in to your local Shimpz Team Admin." />
</svelte:head>

<AdminShell actions={shellActions}>
  <AuthScreen
    {phase}
    bind:password
    bind:confirmation
    {error}
    {busy}
    onSubmit={submit}
    onRetry={checkSession}
  />
</AdminShell>

{#snippet shellActions()}
  <LocaleMenu compact />
{/snippet}
