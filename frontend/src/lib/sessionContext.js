import { writable } from 'svelte/store';

function emptyContext() {
  return { oauthCompletionMode: null };
}

export const sessionContext = writable(emptyContext());

export function clearSessionContext() {
  sessionContext.set(emptyContext());
}

export function setSessionContext(session) {
  const mode = session?.oauth_completion_mode;
  if (mode !== 'automatic' && mode !== 'code' && mode !== null) {
    throw new Error('invalid OAuth completion mode');
  }
  sessionContext.set({ oauthCompletionMode: mode });
}
