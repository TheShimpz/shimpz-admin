// The Assistant page's copy and declarations (Assistant Spec v1): its localized description, the Creator's declared
// links, every Action with its effect and localized description, and the credentials it keeps. One validator admits
// them from Team's details (a staged snapshot or an installed binding) and from the public catalog entry alike.
import { HELP_URL_PATTERN } from './localChat.js';
import { codePointLength, exactKeys, isIdentifier } from './validate.js';

// The Creator's link kinds in their display order.
export const LINK_KINDS = ['site', 'github', 'x', 'youtube', 'linkedin', 'instagram'];
const LINK_ORIGINS = {
  site: ['https://'],
  github: ['https://github.com/'],
  x: ['https://x.com/'],
  youtube: ['https://youtube.com/', 'https://www.youtube.com/'],
  linkedin: ['https://linkedin.com/', 'https://www.linkedin.com/'],
  instagram: ['https://instagram.com/', 'https://www.instagram.com/'],
};
const MAX_LINK_CHARS = 256;
// Built on first use: this module and the chat module that owns the key-page grammar import one another indirectly.
let linkPattern = null;
export const SUMMARY_CHARS = 80;
export const DESCRIPTION_CHARS = 500;
export const LINE_CHARS = 120;
const MAX_ACTIONS = 128;
const MAX_INTEGRATIONS = 16;
const MAX_STORED_INPUTS = 8;
const EFFECTS = ['read_only', 'mutating'];
// Displayed copy is printable as Team admits it: no control, format (bidi, zero-width), surrogate, private-use, or
// unassigned character, and no separator other than the ASCII space.
const NON_PRINTABLE_RE = /[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

export class AssistantPageError extends Error {}

function invalid() {
  return new AssistantPageError('The Assistant page is invalid.');
}

/** Whether a value is one line of displayed public text of at most `maximum` characters. */
export function isDisplayText(value, maximum) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    value === value.normalize('NFC') &&
    codePointLength(value) <= maximum &&
    !NON_PRINTABLE_RE.test(value)
  );
}

/**
 * The Creator's declared links in display order. Each is one canonical public https page on its kind's own host
 * that the browser serializes unchanged, so a link opens exactly what its producer admitted.
 */
export function canonicalLinks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const kinds = Object.keys(value);
  if (kinds.some((kind) => !LINK_KINDS.includes(kind))) throw invalid();
  return LINK_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => {
    const url = value[kind];
    if (
      typeof url !== 'string' ||
      url.length > MAX_LINK_CHARS ||
      !(linkPattern ??= new RegExp(HELP_URL_PATTERN, 'u')).test(url) ||
      !LINK_ORIGINS[kind].some((origin) => url.startsWith(origin)) ||
      new URL(url).href !== url
    ) {
      throw invalid();
    }
    return { kind, url };
  });
}

function sortedUnique(items, maximum, minimum = 0) {
  if (!Array.isArray(items) || items.length < minimum || items.length > maximum) throw invalid();
  items.forEach((item, index) => {
    if (index > 0 && items[index - 1].id >= item.id) throw invalid();
  });
  return items;
}

function canonicalActions(value) {
  return sortedUnique(value, MAX_ACTIONS, 1).map((action) => {
    if (
      !exactKeys(action, ['description', 'effect', 'id']) ||
      !isIdentifier(action.id) ||
      !EFFECTS.includes(action.effect) ||
      !isDisplayText(action.description, LINE_CHARS)
    ) {
      throw invalid();
    }
    return { id: action.id, effect: action.effect, description: action.description };
  });
}

function canonicalIntegrations(value) {
  return sortedUnique(value, MAX_INTEGRATIONS).map((integration) => {
    if (
      !exactKeys(integration, ['id', 'provider']) ||
      !isIdentifier(integration.id) ||
      !isIdentifier(integration.provider)
    ) {
      throw invalid();
    }
    return { id: integration.id, provider: integration.provider };
  });
}

function canonicalStoredInputs(value) {
  return sortedUnique(value, MAX_STORED_INPUTS).map((input) => {
    if (!exactKeys(input, ['id', 'label']) || !isIdentifier(input.id) || !isDisplayText(input.label, LINE_CHARS)) {
      throw invalid();
    }
    return { id: input.id, label: input.label };
  });
}

/**
 * Admit the page copy and declarations shared by every source of an Assistant page: its description, links, Actions,
 * Integrations, and Stored Inputs. Lists keep their producer's id order; nothing is repaired or truncated.
 */
export function canonicalPageCopy(value) {
  if (!isDisplayText(value.description, DESCRIPTION_CHARS)) throw invalid();
  return {
    description: value.description,
    links: canonicalLinks(value.links),
    actions: canonicalActions(value.actions),
    integrations: canonicalIntegrations(value.integrations),
    storedInputs: canonicalStoredInputs(value.stored_inputs),
  };
}

/** Split Actions into the read group and the write group, each kept in id order. */
export function actionGroups(actions) {
  return {
    read: actions.filter((action) => action.effect === 'read_only'),
    write: actions.filter((action) => action.effect !== 'read_only'),
  };
}

/**
 * A row's description continues its slug, so its first letter is lowercased where that changes no meaning: never in
 * German, whose nouns keep their capital, and never when the first word is an acronym or a brand written with inner
 * capitals ("API", "WhatsApp").
 */
export function continuingText(text, locale) {
  if (locale === 'de') return text;
  const first = text.split(/\s/u, 1)[0];
  if ([...first].slice(1).some((character) => character !== character.toLocaleLowerCase(locale))) return text;
  const [head, ...rest] = [...text];
  return head.toLocaleLowerCase(locale) + rest.join('');
}

/**
 * What the page shows for one Assistant in one Team. An Assistant installed in the Team always shows its installed
 * binding and offers Uninstall. Otherwise the staged snapshot (which shadows its publication) or the publication is
 * the candidate, but only once every source that could name it has been read: a staged snapshot this machine could not
 * enumerate, or a publication the catalog could not list, leaves the candidate unverified rather than another one.
 */
export function pageTarget({ installed, localGroup, publication, localKnown = true, publicKnown = true }) {
  if (installed) return { mode: 'installed', installed };
  if (!localKnown) return { mode: 'unverified' };
  if (localGroup) return { mode: 'local', group: localGroup };
  if (publication) return { mode: 'public', publication };
  if (!publicKnown) return { mode: 'unverified' };
  return { mode: 'missing' };
}
