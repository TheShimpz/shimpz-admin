<script>
  import '@shimpz/frontend/theme.css';
  import '../app.css';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, tick } from 'svelte';
  import QRCode from 'qrcode';
  import AdminShell from '$lib/AdminShell.svelte';
  import AuthScreen from '$lib/AuthScreen.svelte';
  import BootScreen from '$lib/BootScreen.svelte';
  import { clearAdminNotice } from '$lib/adminNotice.js';
  import { locale, LOCALES, t } from '$lib/i18n.js';
  import { clearModelContext, modelContext } from '$lib/modelContext.js';
  import { authenticateWithPasskey, passkeyFailure, registerPasskey } from '$lib/passkey.js';
  import { clearSessionContext, setSessionContext } from '$lib/sessionContext.js';
  import { clearTeamContext, teamContext } from '$lib/teamContext.js';

  let { children } = $props();

  let phase = $state('checking');
  let profile = $state('');
  let username = $state('');
  let password = $state('');
  let confirmation = $state('');
  let code = $state('');
  let enrollment = $state(null);
  let passkeyOptions = $state(null);
  let error = $state('');
  let busy = $state(false);
  let initialBoot = $state(true);
  let redirectAfterAuthentication = $state(false);

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

  function clearCredentials() {
    username = '';
    password = '';
    confirmation = '';
    code = '';
    enrollment = null;
    passkeyOptions = null;
  }

  async function enterReady(redirectToChat) {
    if (redirectToChat || page.url.pathname === '/') await goto('/chat/', { replaceState: true });
    phase = 'ready';
  }

  async function checkSession(options = {}) {
    const redirectToChat = options.redirectToChat === true;
    const skipPasskeyOffer = options.skipPasskeyOffer === true;
    clearAdminNotice();
    clearModelContext();
    clearSessionContext();
    clearTeamContext();
    phase = 'checking';
    error = '';

    try {
      const response = await fetch('/api/session', { method: 'POST', cache: 'no-store' });
      if (!response.ok) throw new Error('session unavailable');
      const session = await response.json();
      if (session?.profile !== 'local' && session?.profile !== 'hosted') {
        throw new Error('invalid session profile');
      }
      profile = session.profile;
      if (profile === 'local') {
        const authenticationState = session?.authentication_state;
        if (!['uninitialized', 'enrollment-required', 'configured', 'recovery-required'].includes(authenticationState)) {
          throw new Error('invalid authentication state');
        }
        if (authenticationState === 'recovery-required') {
          phase = 'recovery';
          return;
        }
        if (session?.authenticated === true) {
          if (authenticationState !== 'configured' || session?.origin_admitted !== true) {
            throw new Error('invalid authenticated session');
          }
          setSessionContext(session);
          const offerPasskey =
            !skipPasskeyOffer &&
            session?.authentication_method === 'totp' &&
            session?.passkey_enrollment_available === true &&
            session?.passkey_registered === false;
          if (offerPasskey) {
            redirectAfterAuthentication = redirectToChat;
            phase = 'passkey-offer';
          } else {
            await enterReady(redirectToChat);
          }
          return;
        }
        if (authenticationState === 'uninitialized' && session?.initialized === false) {
          phase = 'setup';
          return;
        }
        if (authenticationState === 'enrollment-required' && session?.initialized === true) {
          phase = 'enrollment-resume';
          return;
        }
        if (authenticationState === 'configured' && session?.initialized === true) {
          phase = 'login';
          return;
        }
        throw new Error('invalid local session');
      }
      if (session?.authenticated === true) {
        await enterReady(redirectToChat);
      } else if (session?.account_id === null) {
        phase = 'login';
      } else {
        throw new Error('invalid hosted session');
      }
    } catch {
      error = $t('auth.unreachable');
    }
  }

  function responseError(response, body) {
    if (response.status === 429) return $t('auth.tooManyAttempts');
    if (body.code === 'password-too-short') return $t('auth.tooShort');
    if (body.code === 'password-blocklisted') return $t('auth.commonPassword');
    if (response.status === 401) return $t('auth.badPassword');
    if (response.status === 403 && profile === 'hosted') return $t('auth.supervisorRequired');
    return typeof body.detail === 'string' && body.detail.length <= 160
      ? body.detail
      : `HTTP ${response.status}`;
  }

  async function focusPassword() {
    await tick();
    document.getElementById('admin-password')?.focus({ preventScroll: true });
  }

  async function submitPassword() {
    if (busy || !['setup', 'enrollment-resume', 'login'].includes(phase)) return;
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
    const submittedPhase = phase;
    try {
      const endpoint = submittedPhase === 'login' ? '/api/login' : '/api/admin/setup';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile === 'hosted' ? { username, password } : { password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.code === 'password-recovery-required') phase = 'recovery';
        else error = responseError(response, body);
        return;
      }
      if (profile === 'hosted') {
        clearCredentials();
        await checkSession({ redirectToChat: true });
        return;
      }
      if (submittedPhase !== 'login') {
        const secret = body?.enrollment?.secret;
        const uri = body?.enrollment?.uri;
        if (response.status !== 202 || typeof secret !== 'string' || typeof uri !== 'string') {
          throw new Error('invalid enrollment');
        }
        const qr = await QRCode.toDataURL(uri, { margin: 1, width: 184, errorCorrectionLevel: 'M' });
        enrollment = { secret, qr };
        password = confirmation = '';
        phase = 'totp-enrollment';
        return;
      }
      const methods = body?.methods;
      if (response.status !== 202 || !Array.isArray(methods) || !methods.includes('totp')) {
        throw new Error('invalid login ceremony');
      }
      passkeyOptions = methods.includes('passkey') ? body.passkey_options : null;
      password = '';
      phase = 'totp-login';
    } catch {
      error = $t('auth.unreachable');
    } finally {
      busy = false;
    }
  }

  async function submitTotp() {
    if (busy || !['totp-enrollment', 'totp-login'].includes(phase) || !/^[0-9]{6}$/.test(code)) return;
    error = '';
    busy = true;
    const enrollmentAttempt = phase === 'totp-enrollment';
    try {
      const response = await fetch(enrollmentAttempt ? '/api/admin/setup/totp' : '/api/login/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        phase = enrollmentAttempt ? 'enrollment-resume' : 'login';
        clearCredentials();
        error = response.status === 429 ? $t('auth.tooManyAttempts') : $t('auth.badCodeRetry');
        busy = false;
        await focusPassword();
        return;
      }
      clearCredentials();
      await checkSession({ redirectToChat: true });
    } catch {
      error = $t('auth.unreachable');
    } finally {
      busy = false;
    }
  }

  async function usePasskey() {
    if (busy || phase !== 'totp-login' || !passkeyOptions) return;
    error = '';
    busy = true;
    try {
      const credential = await authenticateWithPasskey(passkeyOptions);
      const response = await fetch('/api/login/passkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      });
      if (!response.ok) {
        phase = 'login';
        clearCredentials();
        error = $t('auth.passkeyRetry');
        busy = false;
        await focusPassword();
        return;
      }
      clearCredentials();
      await checkSession({ redirectToChat: true, skipPasskeyOffer: true });
    } catch (failure) {
      error = $t(`auth.passkey${passkeyFailure(failure) === 'canceled' ? 'Canceled' : 'Failed'}`);
    } finally {
      busy = false;
    }
  }

  async function registerLocalPasskey() {
    if (busy || phase !== 'passkey-offer') return;
    error = '';
    busy = true;
    try {
      const begin = await fetch('/api/admin/passkeys/registration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await begin.json().catch(() => ({}));
      if (!begin.ok || !body.options) throw new Error('passkey registration unavailable');
      const credential = await registerPasskey(body.options);
      const complete = await fetch('/api/admin/passkeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      });
      if (!complete.ok) throw new Error('passkey registration failed');
      await checkSession({ redirectToChat: redirectAfterAuthentication, skipPasskeyOffer: true });
    } catch (failure) {
      const kind = passkeyFailure(failure);
      error = $t(kind === 'canceled' ? 'auth.passkeyCanceled' : kind === 'registered' ? 'auth.passkeyRegistered' : 'auth.passkeyFailed');
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const unsubscribe = locale.subscribe((selectedLocale) => {
      const selected = LOCALES.find((item) => item.code === selectedLocale);
      document.documentElement.lang = selectedLocale;
      document.documentElement.dir = selected?.dir ?? 'ltr';
    });
    checkSession();
    return unsubscribe;
  });
</script>

<div class="initial-content" class:initial-content-hidden={initialBoot} inert={initialBoot ? true : undefined} aria-hidden={initialBoot ? 'true' : undefined}>
  {#if phase === 'ready'}
    <AdminShell {active} authenticated {profile}>{@render children()}</AdminShell>
  {:else}
    <AdminShell>
      <AuthScreen
        {phase}
        {profile}
        bind:username
        bind:password
        bind:confirmation
        bind:code
        {enrollment}
        passkeyAvailable={passkeyOptions !== null}
        {error}
        {busy}
        onSubmitPassword={submitPassword}
        onSubmitTotp={submitTotp}
        onUsePasskey={usePasskey}
        onRegisterPasskey={registerLocalPasskey}
        onSkipPasskey={() => enterReady(redirectAfterAuthentication)}
        onRetry={() => checkSession()}
      />
    </AdminShell>
  {/if}
</div>

{#if initialBoot}<BootScreen label={$t('auth.checking')} />{/if}

<style>
  .initial-content-hidden { visibility: hidden; }
</style>
