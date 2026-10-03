// Team's human-request copy as the browser receives it (ADR-0091): every copy field of the canonical request is a
// reference into the Assistant's English catalog, and a separate `rendered` block carries the text to show in the
// challenge's locale. Shared by the browser tests, the unit tests, and the preview scenarios, which run in the browser.

export const PACK_DIGEST = `sha256:${'5'.repeat(64)}`;
const COPY_FIELDS = ['title', 'description', 'label', 'placeholder'];

// A stable lowercase 64-hex id per message. Team derives the real id as the SHA-256 of the template; Admin verified the
// fingerprint over it, and the browser only admits its shape, so a fixture needs only a distinct, stable id.
function messageId(text) {
  let hash = 0x811c9dc5;
  let id = '';
  for (let round = 0; round < 8; round += 1) {
    for (const character of `${round}:${text}`) {
      hash = Math.imul(hash ^ character.codePointAt(0), 0x01000193) >>> 0;
    }
    id += hash.toString(16).padStart(8, '0');
  }
  return id;
}

/** A reference to one English catalog message with its parameters. */
export function messageReference(text, params = {}) {
  return { message: messageId(text), params };
}

/**
 * Split a request written with plain English copy into Team's canonical request and the rendered copy. `shown`
 * replaces any rendered field (and `shown.options` any option's copy) with the text of another locale.
 */
export function localizeRequest(plain, shown = {}) {
  const request = { ...plain };
  const rendered = {};
  for (const field of COPY_FIELDS) {
    if (!Object.hasOwn(plain, field)) continue;
    rendered[field] = Object.hasOwn(shown, field) ? shown[field] : plain[field];
    request[field] = plain[field] === null ? null : messageReference(plain[field]);
  }
  if (plain.options) {
    rendered.options = plain.options.map((option, index) => ({
      label: shown.options?.[index]?.label ?? option.label,
      description: shown.options?.[index] ? shown.options[index].description : option.description,
    }));
    request.options = plain.options.map((option) => ({
      value: option.value,
      label: messageReference(option.label),
      description: option.description === null ? null : messageReference(option.description),
    }));
  }
  return { request, rendered };
}

/** The challenge fields that carry one request: the canonical request, its rendered copy, locale, and pack. */
export function localizedChallenge(plain, { locale = 'en', shown = {} } = {}) {
  const { request, rendered } = localizeRequest(plain, shown);
  return { request, rendered, locale, pack_digest: PACK_DIGEST };
}
