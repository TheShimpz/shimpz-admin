<script>
  import '@shimpz/frontend/theme.css';
  import '../app.css';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import AdminShell from '$lib/AdminShell.svelte';
  import AuthScreen from '$lib/AuthScreen.svelte';
  import BootScreen from '$lib/BootScreen.svelte';
  import { clearAdminNotice } from '$lib/adminNotice.js';
  import { locale, LOCALES, t } from '$lib/i18n.js';
  import { clearModelContext, modelContext } from '$lib/modelContext.js';
  import { clearSessionContext, setSessionContext } from '$lib/sessionContext.js';
  import { clearTeamContext, teamContext } from '$lib/teamContext.js';

  let { children } = $props();

  let phase = $state('checking');
  let profile = $state('');
  let username = $state('');
  let password = $state('');
  let confirmation = $state('');
  let error = $state('');
  let busy = $state(false);
  let confirmOrigin = $state(false);
  let initialBoot = $state(true);

  let active = $derived(
    page.url.pathname.startsWith('/chat')
      ? 'chat'
      : page.url.pathname.startsWith('/assistants')
        ? 'assistants'
        : '',
  );
  let sessionSettled = $derived(phase !== 'checking' || error !== '');
  let initialStateSettled = $derived.by(() => {
    if (phase !== 'ready') return sessionSettled;
    if ($teamContext.phase === 'error') return true;
    if ($teamContext.phase !== 'ready') return false;
    if (!$teamContext.selectedTeamId || active !== 'chat') return true;
    return $modelContext.phase === 'ready' || $modelContext.phase === 'error';
  });

  $effect(() => {
    if (initialBoot && initialStateSettled) initialBoot = false;
  });

  async function checkSession(options = {}) {
    const redirectToChat = options.redirectToChat === true;
    clearAdminNotice();
    clearModelContext();
    clearSessionContext();
    clearTeamContext();
    phase = 'checking';
    error = '';
    confirmOrigin = false;

    try {
      const response = await fetch('/api/session', { method: 'POST', cache: 'no-store' });
      if (!response.ok) throw new Error('session unavailable');

      const session = await response.json();
      if (session?.profile !== 'local' && session?.profile !== 'hosted') {
        throw new Error('invalid session profile');
      }
      profile = session.profile;
      if (profile === 'local' && session?.password_state === 'recovery-required') {
        phase = 'recovery';
      } else if (session?.authenticated === true) {
        if (profile === 'local' && session?.origin_admitted !== true) {
          confirmOrigin = true;
          phase = 'login';
        } else {
          if (profile === 'local') setSessionContext(session);
          if (redirectToChat || page.url.pathname === '/') await goto('/chat/', { replaceState: true });
          phase = 'ready';
        }
      } else if (profile === 'local' && session?.initialized === false) {
        phase = 'setup';
      } else if (
        (profile === 'local' && session?.initialized === true) ||
        (profile === 'hosted' && session?.account_id === null)
      ) {
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
    if (profile === 'hosted' && !username) {
      error = $t('auth.usernameRequired');
      return;
    }
    if (phase === 'setup' && password.length < 15) {
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
        body: JSON.stringify(profile === 'hosted' ? { username, password } : { password }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (body.code === 'password-recovery-required') {
          phase = 'recovery';
          return;
        }
        error =
          response.status === 429
            ? $t('auth.tooManyAttempts')
            : body.code === 'password-too-short'
              ? $t('auth.tooShort')
              : body.code === 'password-blocklisted'
                ? $t('auth.commonPassword')
                : response.status === 401
                  ? $t('auth.badPassword')
                  : response.status === 403 && profile === 'hosted'
                    ? $t('auth.supervisorRequired')
                    : (body.detail ?? `HTTP ${response.status}`);
        return;
      }

      username = password = confirmation = '';
      await checkSession({ redirectToChat: true });
    } catch {
      error = $t('auth.unreachable');
    } finally {
      busy = false;
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

<div
  class="initial-content"
  class:initial-content-hidden={initialBoot}
  inert={initialBoot ? true : undefined}
  aria-hidden={initialBoot ? 'true' : undefined}
>
  {#if phase === 'ready'}
    <AdminShell {active} authenticated {profile}>
      {@render children()}
    </AdminShell>
  {:else}
    <AdminShell>
      <AuthScreen
        {phase}
        {profile}
        {confirmOrigin}
        bind:username
        bind:password
        bind:confirmation
        {error}
        {busy}
        onSubmit={submit}
        onRetry={() => checkSession()}
      />
    </AdminShell>
  {/if}
</div>

{#if initialBoot}
  <BootScreen label={$t('auth.checking')} />
{/if}

<style>
  .initial-content-hidden {
    visibility: hidden;
  }
</style>
