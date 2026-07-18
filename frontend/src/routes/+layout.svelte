<script>
  import '../app.css';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import AdminShell from '$lib/AdminShell.svelte';
  import AuthScreen from '$lib/AuthScreen.svelte';
  import { locale, LOCALES, t } from '$lib/i18n.js';
  import { clearTeamContext } from '$lib/teamContext.js';

  let { children } = $props();

  let phase = $state('checking');
  let password = $state('');
  let confirmation = $state('');
  let error = $state('');
  let busy = $state(false);

  let active = $derived(
    page.url.pathname.startsWith('/chat')
      ? 'chat'
      : page.url.pathname.startsWith('/capsules')
        ? 'capsules'
        : page.url.pathname.startsWith('/assistants')
          ? 'assistants'
          : '',
  );

  async function enterAdmin() {
    phase = 'ready';
    await goto('/chat/', { replaceState: true });
  }

  async function checkSession() {
    clearTeamContext();
    phase = 'checking';
    error = '';

    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('session unavailable');

      const session = await response.json();
      if (session?.authenticated === true) {
        phase = 'ready';
        if (page.url.pathname === '/') await goto('/chat/', { replaceState: true });
      } else if (session?.initialized === false) {
        phase = 'setup';
      } else if (session?.initialized === true) {
        phase = 'login';
      } else {
        throw new Error('invalid session');
      }
    } catch {
      error = $t('auth.unreachable');
    }
  }

  async function submit() {
    if (busy || (phase !== 'setup' && phase !== 'login')) return;

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
      await enterAdmin();
    } catch {
      error = $t('auth.unreachable');
    } finally {
      busy = false;
    }
  }

  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      clearTeamContext();
      password = confirmation = '';
      error = '';
      phase = 'login';
      await goto('/', { replaceState: true });
    }
  }

  onMount(() => {
    const unsubscribe = locale.subscribe((code) => {
      const selected = LOCALES.find((item) => item.code === code);
      document.documentElement.lang = code;
      document.documentElement.dir = selected?.dir ?? 'ltr';
    });

    checkSession();
    return unsubscribe;
  });
</script>

{#if phase === 'ready'}
  <AdminShell {active} authenticated onLogout={logout}>
    {@render children()}
  </AdminShell>
{:else}
  <AdminShell>
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
{/if}
