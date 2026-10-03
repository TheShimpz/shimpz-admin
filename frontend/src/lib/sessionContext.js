import { writable } from 'svelte/store';

function emptyContext() {
  return { oauthCompletionMode: null, profile: null, passkeyRegistered: false };
}

export const sessionContext = writable(emptyContext());

export function clearSessionContext() {
  sessionContext.set(emptyContext());
}

export function setSessionContext(session) {
  const mode = session?.oauth_completion_mode;
  const profile = session?.profile;
  if (mode !== 'automatic' && mode !== 'code' && mode !== null) {
    throw new Error('invalid OAuth completion mode');
  }
  if (!['local', 'hosted'].includes(profile)) throw new Error('invalid Admin profile');
  // Whether this address has a passkey is only a hint for what to offer first; Admin's own answer decides.
  sessionContext.set({ oauthCompletionMode: mode, profile, passkeyRegistered: session?.passkey_registered === true });
}

// The root layout provides this callback so a page that confirms its session has ended hands the browser back to
// the normal signed-out flow.
export const SESSION_ENDED = Symbol('shimpz.session-ended');
