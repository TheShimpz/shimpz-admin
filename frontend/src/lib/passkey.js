function decodeBase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid passkey options');
  }
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const decoded = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function supported() {
  return (
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator.credentials?.get === 'function' &&
    typeof navigator.credentials?.create === 'function'
  );
}

function validateCredential(credential, responseType) {
  if (
    !(credential instanceof PublicKeyCredential) ||
    !(credential.response instanceof responseType)
  ) {
    throw new Error('invalid passkey response');
  }
  const rawId = encodeBase64url(credential.rawId);
  const extensions = credential.getClientExtensionResults();
  const attachment = credential.authenticatorAttachment;
  if (
    credential.type !== 'public-key' ||
    credential.id !== rawId ||
    Object.keys(extensions).length !== 0 ||
    (attachment !== null && attachment !== 'platform' && attachment !== 'cross-platform')
  ) {
    throw new Error('invalid passkey response');
  }
  return { attachment, extensions, rawId };
}

export async function authenticateWithPasskey(options) {
  if (!supported()) throw new Error('passkeys are not supported');
  const credential = await navigator.credentials.get({
    publicKey: {
      allowCredentials: options.allowCredentials.map((descriptor) => ({
        id: decodeBase64url(descriptor.id),
        type: descriptor.type,
      })),
      challenge: decodeBase64url(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
    },
  });
  const { attachment, extensions, rawId } = validateCredential(
    credential,
    AuthenticatorAssertionResponse,
  );
  return {
    authenticatorAttachment: attachment,
    clientExtensionResults: extensions,
    id: credential.id,
    rawId,
    response: {
      authenticatorData: encodeBase64url(credential.response.authenticatorData),
      clientDataJSON: encodeBase64url(credential.response.clientDataJSON),
      signature: encodeBase64url(credential.response.signature),
      userHandle: credential.response.userHandle
        ? encodeBase64url(credential.response.userHandle)
        : null,
    },
    type: 'public-key',
  };
}

export async function registerPasskey(options) {
  if (!supported()) throw new Error('passkeys are not supported');
  const credential = await navigator.credentials.create({
    publicKey: {
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      challenge: decodeBase64url(options.challenge),
      excludeCredentials: options.excludeCredentials.map((descriptor) => ({
        id: decodeBase64url(descriptor.id),
        type: descriptor.type,
      })),
      pubKeyCredParams: options.pubKeyCredParams,
      rp: options.rp,
      timeout: options.timeout,
      user: { ...options.user, id: decodeBase64url(options.user.id) },
    },
  });
  const { attachment, extensions, rawId } = validateCredential(
    credential,
    AuthenticatorAttestationResponse,
  );
  return {
    authenticatorAttachment: attachment,
    clientExtensionResults: extensions,
    id: credential.id,
    rawId,
    response: {
      attestationObject: encodeBase64url(credential.response.attestationObject),
      clientDataJSON: encodeBase64url(credential.response.clientDataJSON),
    },
    type: 'public-key',
  };
}

export function passkeyFailure(error) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return 'canceled';
  if (error instanceof DOMException && error.name === 'InvalidStateError') return 'registered';
  return 'failed';
}
