const HTTP_URL = /^https?:\/\//i;
const LIST_ITEM = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/;
const HEADING = /^(#{1,3})\s+(.+?)\s*$/;
const TABLE_DIVIDER = /^:?-{3,}:?$/;
const MAX_TABLE_COLUMNS = 32;
const MAX_TABLE_ROWS = 256;

function textToken(text) {
  return { type: 'text', text };
}

/** Preserve bounded external copy as literal text when it is placed in a Markdown message. */
export function escapeMarkdownText(value) {
  return String(value ?? '').replace(/[\\`*_[\]{}()<>#+\-.!|]/gu, '\\$&');
}

function appendText(tokens, text) {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.type === 'text') previous.text += text;
  else tokens.push(textToken(text));
}

function safeLink(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || !HTTP_URL.test(raw)) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

/** Parse a deliberately small inline Markdown subset into text-only display tokens. */
export function parseInline(source) {
  const input = String(source ?? '');
  const tokens = [];
  let cursor = 0;

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
      const end = input.indexOf(strongMarker, cursor + 2);
      if (end > cursor + 2) {
        tokens.push({ type: 'strong', text: input.slice(cursor + 2, end) });
        cursor = end + 2;
        continue;
      }
    }

    if (input[cursor] === '*' || input[cursor] === '_') {
      const marker = input[cursor];
      const end = input.indexOf(marker, cursor + 1);
      if (end > cursor + 1) {
        tokens.push({ type: 'emphasis', text: input.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }

    if (input[cursor] === '[') {
      const labelEnd = input.indexOf('](', cursor + 1);
      const hrefEnd = labelEnd === -1 ? -1 : input.indexOf(')', labelEnd + 2);
      if (labelEnd > cursor + 1 && hrefEnd > labelEnd + 2) {
        const label = input.slice(cursor + 1, labelEnd);
        const href = safeLink(input.slice(labelEnd + 2, hrefEnd).trim());
        if (href) tokens.push({ type: 'link', text: label, href });
        else appendText(tokens, label);
        cursor = hrefEnd + 1;
        continue;
      }
    }

    appendText(tokens, input[cursor]);
    cursor += 1;
  }
  return tokens;
}

function startsBlock(line) {
  return line.startsWith('```') || HEADING.test(line) || LIST_ITEM.test(line);
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
export function parseMarkdown(markdown) {
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
        inlines: parseInline(heading[2].replace(/\s+#+\s*$/, '')),
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
      index < lines.length && lines[index].trim() && !startsBlock(lines[index])
      && !parseTable(lines, index)
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join(' ')) });
  }
  return blocks;
}
