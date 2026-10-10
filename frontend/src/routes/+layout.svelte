<script>
  import '@shimpz/frontend/theme.css';
  import '../app.css';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, setContext, tick } from 'svelte';
  import QRCode from 'qrcode';
  import AdminShell from '$lib/AdminShell.svelte';
  import AuthScreen from '$lib/AuthScreen.svelte';
  import BootScreen from '$lib/BootScreen.svelte';
  import { clearAdminNotice } from '$lib/adminNotice.js';
  import { locale, LOCALES, t } from '$lib/i18n.js';
  import { INITIAL_VIEW_READINESS } from '$lib/initialView.js';
  import { clearModelContext, modelContext } from '$lib/modelContext.js';
  import { authenticateWithPasskey, passkeyFailure, registerPasskey } from '$lib/passkey.js';
  import { clearTeamRoutines } from '$lib/routineContext.js';
  import { recoveryCodes as validRecoveryCodes } from '$lib/security.js';
  import { clearSessionContext, SESSION_ENDED, setSessionContext } from '$lib/sessionContext.js';
  import { clearTeamContext, teamContext } from '$lib/teamContext.js';

  let { children } = $props();

  let phase = $state('checking');
  let password = $state('');
  let confirmation = $state('');
  let code = $state('');
  let recoveryCode = $state('');
  let enrollment = $state(null);
  let recoveryCodes = $state(null);
  let passkeyOptions = $state(null);
  let error = $state('');
  let busy = $state(false);
  let initialBoot = $state(true);
  let redirectAfterAuthentication = $state(false);
  let assistantsViewSettled = $state(false);
  let assistantsViewDeadlineReached = $state(false);

  setContext(INITIAL_VIEW_READINESS, {
    settleAssistants() {
      assistantsViewSettled = true;
    },
  });
  setContext(SESSION_ENDED, () => checkSession());

  let active = $derived(
    page.url.pathname.startsWith('/chat')
      ? 'chat'
      : page.url.pathname.startsWith('/assistants')
        ? 'assistants'
        : '',
  );
  let sessionSettled = $derived(phase !== 'checking' || error !== '');
  // The Assistants catalog and each Assistant's own page settle the first view when their content is presentable.
  let exactAssistantsRoute = $derived(/^\/assistants(?:\/[a-z][a-z0-9-]*)?\/?$/.test(page.url.pathname));
  let initialStateSettled = $derived.by(() => {
    if (phase !== 'ready') return sessionSettled;
    if (!['ready', 'error'].includes($teamContext.phase)) return false;
    if (exactAssistantsRoute) return assistantsViewSettled || assistantsViewDeadlineReached;
    if ($teamContext.phase === 'error') return true;
    if (!$teamContext.selectedTeamId || active !== 'chat') return true;
    return $modelContext.phase === 'ready' || $modelContext.phase === 'error';
  });

  $effect(() => {
    if (
      !initialBoot ||
      phase !== 'ready' ||
      !exactAssistantsRoute ||
      assistantsViewSettled
    ) return;
    const timeout = globalThis.setTimeout(() => {
      assistantsViewDeadlineReached = true;
    }, 1000);
    return () => globalThis.clearTimeout(timeout);
  });

  $effect(() => {
    if (initialBoot && initialStateSettled) initialBoot = false;
  });

  function clearCredentials() {
    password = '';
    confirmation = '';
    code = '';
    recoveryCode = '';
    enrollment = null;
    passkeyOptions = null;
  }

  async function showEnrollment(body) {
    const secret = body?.enrollment?.secret;
    const uri = body?.enrollment?.uri;
    if (typeof secret !== 'string' || typeof uri !== 'string') throw new Error('invalid enrollment');
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 184, errorCorrectionLevel: 'M' });
    enrollment = { secret, qr };
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
    clearTeamRoutines();
    phase = 'checking';
    error = '';

    try {
      const response = await fetch('/api/session', { method: 'POST', cache: 'no-store' });
      if (!response.ok) throw new Error('session unavailable');
      const session = await response.json();
      if (session?.profile !== 'local') throw new Error('invalid session profile');
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
    } catch {
      error = $t('auth.unreachable');
    }
  }

  function responseError(response, body) {
    if (response.status === 429) return $t('auth.tooManyAttempts');
    if (body.code === 'password-too-short') return $t('auth.tooShort');
    if (body.code === 'password-blocklisted') return $t('auth.commonPassword');
    if (response.status === 401) return $t('auth.badPassword');
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
        body: JSON.stringify({ password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.code === 'password-recovery-required') phase = 'recovery';
        else error = responseError(response, body);
        return;
      }
      if (submittedPhase !== 'login') {
        if (response.status !== 202) throw new Error('invalid enrollment');
        await showEnrollment(body);
        password = confirmation = '';
        phase = 'totp-enrollment';
        return;
      }
      const methods = body?.methods;
      if (response.status !== 202 || !Array.isArray(methods) || !methods.includes('recovery-code')) {
        throw new Error('invalid login ceremony');
      }
      passkeyOptions = methods.includes('passkey') ? body.passkey_options : null;
      password = '';
      // Until the authenticator a recovery code replaced is enrolled again, another recovery code is the only way in.
      phase = methods.includes('totp') ? 'totp-login' : 'recovery-code';
    } catch {
      error = $t('auth.unreachable');
    } finally {
      busy = false;
    }
  }

  const TOTP_ENDPOINTS = {
    'totp-enrollment': '/api/admin/setup/totp',
    'totp-reenrollment': '/api/login/recovery/totp',
    'totp-login': '/api/login/totp',
  };

  async function submitTotp() {
    const endpoint = TOTP_ENDPOINTS[phase];
    if (busy || !endpoint || !/^[0-9]{6}$/.test(code)) return;
    error = '';
    busy = true;
    const submittedPhase = phase;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = await response.json().catch(() => ({}));
      // A wrong code while enrolling again keeps the enrollment: Admin hands back a fresh ticket for the next code.
      if (submittedPhase === 'totp-reenrollment' && response.status === 401) {
        code = '';
        error = $t('security.codeIncorrect');
        return;
      }
      if (!response.ok) {
        phase = submittedPhase === 'totp-enrollment' ? 'enrollment-resume' : 'login';
        clearCredentials();
        error = response.status === 429 ? $t('auth.tooManyAttempts') : $t('auth.badCodeRetry');
        busy = false;
        await focusPassword();
        return;
      }
      clearCredentials();
      if (submittedPhase !== 'totp-login') {
        // An enrollment shows its new recovery codes once, before the signed-in Admin opens.
        recoveryCodes = validRecoveryCodes(body?.recovery_codes);
        if (!recoveryCodes) throw new Error('invalid recovery codes');
        phase = 'recovery-codes';
        return;
      }
      await checkSession({ redirectToChat: true });
    } catch {
      error = $t('auth.unreachable');
    } finally {
      busy = false;
    }
  }

  async function submitRecoveryCode() {
    if (busy || phase !== 'recovery-code' || !recoveryCode.trim()) return;
    error = '';
    busy = true;
    try {
      const response = await fetch('/api/login/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: recoveryCode }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        phase = 'login';
        clearCredentials();
        error = response.status === 429 ? $t('auth.tooManyAttempts') : $t('security.recoveryCodeRetry');
        busy = false;
        await focusPassword();
        return;
      }
      if (response.status !== 202) throw new Error('invalid recovery');
      await showEnrollment(body);
      recoveryCode = '';
      phase = 'totp-reenrollment';
    } catch {
      error = $t('auth.unreachable');
    } finally {
      busy = false;
    }
  }

  async function recoveryCodesSaved() {
    recoveryCodes = null;
    await checkSession({ redirectToChat: true });
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
    <AdminShell {active} authenticated>{@render children()}</AdminShell>
  {:else}
    <AdminShell>
      <AuthScreen
        {phase}
        bind:password
        bind:confirmation
        bind:code
        bind:recoveryCode
        {enrollment}
        {recoveryCodes}
        passkeyAvailable={passkeyOptions !== null}
        {error}
        {busy}
        onSubmitPassword={submitPassword}
        onSubmitTotp={submitTotp}
        onUsePasskey={usePasskey}
        onRegisterPasskey={registerLocalPasskey}
        onSkipPasskey={() => enterReady(redirectAfterAuthentication)}
        onUseRecoveryCode={() => { error = ''; code = ''; phase = 'recovery-code'; }}
        onSubmitRecoveryCode={submitRecoveryCode}
        onRecoveryCodesSaved={recoveryCodesSaved}
        onRetry={() => checkSession()}
      />
    </AdminShell>
  {/if}
</div>

{#if initialBoot}<BootScreen label={$t('auth.checking')} />{/if}

<style>
  .initial-content-hidden { visibility: hidden; }
</style>
