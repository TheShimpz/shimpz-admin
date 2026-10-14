const HTTP_URL = /^https?:\/\//i;
const URL_AUTHORITY = /^https?:\/\/([^/?#]*)/i;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
// A list item and a heading start their text at its first non-space character, so the space before it is matched once:
// `\s+(.+)$` let a long run of spaces be tried from every split, seconds on one reply line.
const LIST_ITEM = /^ {0,3}([-+*]|\d+[.)])\s+(\S.*)$/;
const HEADING = /^(#{1,3})\s+(\S.*)$/;
const TABLE_DIVIDER = /^:?-{3,}:?$/;
const CHAT_NOTICE = /^:(success|warning|error)\[([^\[\]\r\n]+)\]$/;
const MAX_TABLE_COLUMNS = 32;
const MAX_TABLE_ROWS = 256;
// The longest link destination shown as a link.
const MAX_LINK_CHARS = 2048;

// A heading's text without its trailing space or closing `#` run, read from the end once: an anchored `\s+#+\s*$` was
// tried from every space of a long run.
function headingText(text) {
  const trimmed = text.trimEnd();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === '#') end -= 1;
  if (end === trimmed.length || end === 0 || !/\s/u.test(trimmed[end - 1])) return trimmed;
  return trimmed.slice(0, end).trimEnd();
}

function textToken(text) {
  return { type: 'text', text };
}

/** Preserve bounded external copy as literal text when it is placed in a Markdown message. */
export function escapeMarkdownText(value) {
  return String(value ?? '').replace(/[\\`*_[\]{}()<>#+\-.!|~]/gu, '\\$&');
}

// A span's content as displayed: each backslash escape stands for the character it escapes.
function unescapeInline(text) {
  return text.replace(/\\(.)/gsu, '$1');
}

// Where a span's closing marker is, skipping escaped characters, or -1.
function closingMarker(input, marker, from) {
  for (let index = from; index < input.length; index += 1) {
    if (input[index] === '\\') index += 1;
    else if (input.startsWith(marker, index)) return index;
  }
  return -1;
}

function appendText(tokens, text) {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.type === 'text') previous.text += text;
  else tokens.push(textToken(text));
}

function safeLink(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_LINK_CHARS || !HTTP_URL.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

// A model-written label can name any place while its link leads elsewhere, carrying anything in its query. The link
// therefore always shows the host it opens in its ASCII form, unless the label's own characters already spell that
// ASCII host or that address with that ASCII host. URL parsing alone never proves this: it maps a look-alike or
// fullwidth label to the same punycode host the label visibly does not show.
function linkToken(label, url) {
  const host = url.host;
  const plain = label.trim();
  const shown = VISIBLE_ASCII.test(plain) && (plain.toLowerCase() === host || spellsAddress(plain, url));
  return { type: 'link', text: label, href: url.href, host: shown ? '' : host };
}

function spellsAddress(plain, url) {
  return safeLink(plain)?.href === url.href && URL_AUTHORITY.exec(plain)[1].toLowerCase() === url.host;
}

/** Parse a deliberately small inline Markdown subset into text-only display tokens. */
// Where a link destination starting at each position ends: its first `)` outside balanced parentheses (a URL such as
// https://en.wikipedia.org/wiki/Foo_(bar) keeps its own), or -1 when it never closes or closes past the longest
// destination a link may have. That `)` is where the parenthesis depth first drops below the depth at the start, so
// one pass over the line answers every start at once.
function destinationEnds(input) {
  const depth = new Int32Array(input.length + 1);
  for (let index = 0; index < input.length; index += 1) {
    depth[index + 1] = depth[index] + (input[index] === '(' ? 1 : input[index] === ')' ? -1 : 0);
  }
  const ends = new Int32Array(input.length).fill(-1);
  const lower = [];
  for (let index = input.length; index >= 0; index -= 1) {
    while (lower.length && depth[lower.at(-1)] >= depth[index]) lower.pop();
    if (index < input.length && lower.length && lower.at(-1) - 1 - index <= MAX_LINK_CHARS) ends[index] = lower.at(-1) - 1;
    lower.push(index);
  }
  return ends;
}

export function parseInline(source) {
  const input = String(source ?? '');
  const tokens = [];
  let cursor = 0;
  // The last search for a label's `](`: a search from a later position up to the `](` found finds the same one, and
  // none follows a position after which none was found. Destinations are all resolved in one pass when the first is
  // needed. A line of unclosed links is so read once, not once per opening.
  let label = { from: Infinity, at: -1 };
  let ends = null;
  const labelEnd = (from) => {
    if (from < label.from || (label.at !== -1 && from > label.at)) label = { from, at: input.indexOf('](', from) };
    return label.at;
  };
  const hrefEnd = (start) => {
    ends ??= destinationEnds(input);
    return start < ends.length ? ends[start] : -1;
  };

  while (cursor < input.length) {
    if (input[cursor] === '\\' && cursor + 1 < input.length) {
      appendText(tokens, input[cursor + 1]);
      cursor += 2;
      continue;
    }

    if (input[cursor] === '`') {
      const end = input.indexOf('`', cursor + 1);
      if (end > cursor + 1) {
        tokens.push({ type: 'code', text: input.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }

    const strongMarker = input.startsWith('**', cursor)
      ? '**'
      : input.startsWith('__', cursor) ? '__' : '';
    if (strongMarker) {
      const end = closingMarker(input, strongMarker, cursor + 2);
      if (end > cursor + 2) {
        tokens.push({ type: 'strong', text: unescapeInline(input.slice(cursor + 2, end)) });
        cursor = end + 2;
        continue;
      }
    }

    if (input[cursor] === '*' || input[cursor] === '_') {
      const marker = input[cursor];
      const end = closingMarker(input, marker, cursor + 1);
      if (end > cursor + 1) {
        tokens.push({ type: 'emphasis', text: unescapeInline(input.slice(cursor + 1, end)) });
        cursor = end + 1;
        continue;
      }
    }

    if (input[cursor] === '[') {
      const closes = labelEnd(cursor + 1);
      const ends = closes === -1 ? -1 : hrefEnd(closes + 2);
      if (closes > cursor + 1 && ends > closes + 2) {
        const text = unescapeInline(input.slice(cursor + 1, closes));
        const url = safeLink(input.slice(closes + 2, ends).trim());
        if (url) tokens.push(linkToken(text, url));
        else appendText(tokens, text);
        cursor = ends + 1;
        continue;
      }
    }

    appendText(tokens, input[cursor]);
    cursor += 1;
  }
  return tokens;
}

function chatNotice(line, enabled) {
  if (!enabled) return null;
  const match = CHAT_NOTICE.exec(line);
  if (!match) return null;
  return { type: 'notice', variant: match[1], text: match[2] };
}

function startsBlock(line, chatNotices) {
  return (
    line.startsWith('```') || HEADING.test(line) || LIST_ITEM.test(line)
    || chatNotice(line, chatNotices) !== null
  );
}

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const content = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const bounded = content.endsWith('|') && !content.endsWith('\\|') ? content.slice(0, -1) : content;
  const cells = [];
  let cell = '';
  let code = false;

  for (let index = 0; index < bounded.length; index += 1) {
    const character = bounded[index];
    if (character === '\\' && index + 1 < bounded.length) {
      cell += character + bounded[index + 1];
      index += 1;
    } else if (character === '`') {
      code = !code;
      cell += character;
    } else if (character === '|' && !code) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignment(cell) {
  const value = cell.replaceAll(' ', '');
  if (!TABLE_DIVIDER.test(value)) return '';
  if (value.startsWith(':') && value.endsWith(':')) return 'center';
  if (value.endsWith(':')) return 'right';
  return 'left';
}

function parseTable(lines, index) {
  if (index + 1 >= lines.length) return null;
  const header = tableCells(lines[index]);
  const divider = tableCells(lines[index + 1]);
  if (
    !header || !divider || header.length !== divider.length || header.length < 1
    || header.length > MAX_TABLE_COLUMNS || header.every((cell) => !cell)
  ) return null;
  const align = divider.map(tableAlignment);
  if (align.some((value) => !value)) return null;

  const rows = [];
  let cursor = index + 2;
  while (cursor < lines.length && lines[cursor].trim() && rows.length < MAX_TABLE_ROWS) {
    const cells = tableCells(lines[cursor]);
    if (!cells || cells.length > header.length) break;
    rows.push([
      ...cells.map(parseInline),
      ...Array.from({ length: header.length - cells.length }, () => []),
    ]);
    cursor += 1;
  }
  return {
    block: {
      type: 'table',
      align,
      header: header.map(parseInline),
      rows,
    },
    next: cursor,
  };
}

/**
 * Convert bounded Markdown into a closed AST. Raw HTML is always ordinary escaped text;
 * callers render only the node types returned here and never inject HTML.
 */
export function parseMarkdown(markdown, { chatNotices = false } = {}) {
  const lines = String(markdown ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const content = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', text: content.join('\n') });
      continue;
    }

    const notice = chatNotice(line, chatNotices);
    if (notice) {
      blocks.push(notice);
      index += 1;
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        inlines: parseInline(headingText(heading[2])),
      });
      index += 1;
      continue;
    }

    const firstItem = LIST_ITEM.exec(line);
    if (firstItem) {
      const ordered = /^\d/.test(firstItem[1]);
      const items = [];
      while (index < lines.length) {
        const item = LIST_ITEM.exec(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(parseInline(item[2]));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length && lines[index].trim() && !startsBlock(lines[index], chatNotices)
      && !parseTable(lines, index)
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join(' ')) });
  }
  return blocks;
}
