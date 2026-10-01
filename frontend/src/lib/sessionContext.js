import { writable } from 'svelte/store';

function emptyContext() {
  return { oauthCompletionMode: null, profile: null };
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
  sessionContext.set({ oauthCompletionMode: mode, profile });
}

// The root layout provides this callback so a page that confirms its session has ended hands the browser back to
// the normal signed-out flow.
export const SESSION_ENDED = Symbol('shimpz.session-ended');
