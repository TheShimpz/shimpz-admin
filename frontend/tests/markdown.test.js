import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeMarkdownText, parseInline, parseMarkdown } from '../src/lib/markdown.js';

test('keeps external display copy literal inside a Markdown response', () => {
  const source = '# Assistant [docs](https://example.com) `code` **bold** | value';
  const blocks = parseMarkdown(escapeMarkdownText(source));

  assert.deepEqual(blocks.map((block) => block.type), ['paragraph']);
  assert.deepEqual(blocks[0].inlines, [{ type: 'text', text: source }]);
});

test('parses the small supported Markdown surface into a closed AST', () => {
  const blocks = parseMarkdown(`# Weather Guide

Ask for **current weather** or *a forecast* with \`days\`.

- Find a place
- Read current conditions

1. Ask for Lisbon
2. Choose a result

\`\`\`
What is the weather in Lisbon?
\`\`\`

[Open the weather provider](https://open-meteo.com/)`);

  assert.deepEqual(blocks.map((block) => block.type), [
    'heading', 'paragraph', 'list', 'list', 'code', 'paragraph',
  ]);
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[1].inlines.map((token) => token.type), [
    'text', 'strong', 'text', 'emphasis', 'text', 'code', 'text',
  ]);
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[4].text, 'What is the weather in Lisbon?');
  assert.equal(blocks[5].inlines[0].href, 'https://open-meteo.com/');
});

test('keeps raw HTML inert text and refuses executable or credential-bearing links', () => {
  const tokens = parseInline(
    '<img src=x onerror=alert(1)> [run](javascript:alert(1)) '
      + '[data](data:text/html,<script>alert(1)</script>) '
      + '[credentials](https://user:password@example.com/) [safe](https://example.com/docs)',
  );

  assert.equal(tokens.some((token) => token.type === 'link' && token.text !== 'safe'), false);
  assert.deepEqual(
    tokens.filter((token) => token.type === 'link'),
    [{ type: 'link', text: 'safe', href: 'https://example.com/docs' }],
  );
  assert.match(tokens.map((token) => token.text).join(''), /<img src=x onerror=alert\(1\)>/);
});

test('does not expose any HTML node or attribute channel in its output model', () => {
  const blocks = parseMarkdown('# <svg onload=alert(1)>\n\n<script>alert(1)</script>');
  const encoded = JSON.stringify(blocks);

  assert.doesNotMatch(encoded, /"(?:html|attributes?|style|event)"\s*:/i);
  assert.match(encoded, /<svg onload=alert\(1\)>/);
  assert.match(encoded, /<script>alert\(1\)<\/script>/);
});

test('admits only exact whole-line semantic Notices on the Chat surface', () => {
  const source = `Before

:success[The deployment completed.]
:warning[Review the DNS TTL before publishing.]
:error[The provider rejected the request.]

After`;
  const body = parseMarkdown(source);
  const chat = parseMarkdown(source, { chatNotices: true });

  assert.equal(body.some((block) => block.type === 'notice'), false);
  assert.deepEqual(chat, [
    { type: 'paragraph', inlines: [{ type: 'text', text: 'Before' }] },
    { type: 'notice', variant: 'success', text: 'The deployment completed.' },
    { type: 'notice', variant: 'warning', text: 'Review the DNS TTL before publishing.' },
    { type: 'notice', variant: 'error', text: 'The provider rejected the request.' },
    { type: 'paragraph', inlines: [{ type: 'text', text: 'After' }] },
  ]);
});

test('keeps malformed, escaped, nested, and unknown Chat Notice directives literal', () => {
  const source = `:info[Unsupported]
:success[]
:success[a[b]
:success[**not recursively parsed**]
:warning[nested [content]]
Prefix :error[not a whole line]
\\:error[Escaped]
<script>:success[still inert]</script>`;
  const blocks = parseMarkdown(source, { chatNotices: true });

  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'notice', 'paragraph']);
  assert.deepEqual(blocks[1], {
    type: 'notice',
    variant: 'success',
    text: '**not recursively parsed**',
  });
  const literal = blocks
    .filter((block) => block.type === 'paragraph')
    .flatMap((block) => block.inlines)
    .map((token) => token.text)
    .join(' ');
  assert.match(literal, /:info\[Unsupported\]/);
  assert.match(literal, /:success\[\]/);
  assert.match(literal, /:success\[a\[b\]/);
  assert.match(literal, /:warning\[nested \[content\]\]/);
  assert.match(literal, /:error\[Escaped\]/);
  assert.match(literal, /<script>:success\[still inert\]<\/script>/);
});

test('neutralizes semantic Notice syntax when external display copy is escaped', () => {
  const source = ':error[Creator-authored status]';
  const blocks = parseMarkdown(escapeMarkdownText(source), { chatNotices: true });

  assert.deepEqual(blocks.map((block) => block.type), ['paragraph']);
  assert.deepEqual(blocks[0].inlines, [{ type: 'text', text: source }]);
});

test('parses bounded GitHub-style tables with alignment and safe inline tokens', () => {
  const blocks = parseMarkdown(`Records

| Type | Name | Value | Proxy |
| :--- | --- | ---: | :---: |
| CNAME | **docs.example.com** | \`target.example.net\` | Active |
| TXT | example.com | escaped \\| value |

Done.`);

  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'table', 'paragraph']);
  const table = blocks[1];
  assert.deepEqual(table.align, ['left', 'left', 'right', 'center']);
  assert.equal(table.header.length, 4);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0][1], [{ type: 'strong', text: 'docs.example.com' }]);
  assert.deepEqual(table.rows[0][2], [{ type: 'code', text: 'target.example.net' }]);
  assert.equal(table.rows[1][2][0].text, 'escaped | value');
  assert.deepEqual(table.rows[1][3], []);
});

test('keeps malformed and oversized table candidates as ordinary text', () => {
  const malformed = parseMarkdown('| A | B |\n| -- | --- |\n| one | two |');
  assert.deepEqual(malformed.map((block) => block.type), ['paragraph']);

  const header = `| ${Array.from({ length: 33 }, (_, index) => `h${index}`).join(' | ')} |`;
  const divider = `| ${Array.from({ length: 33 }, () => '---').join(' | ')} |`;
  const oversized = parseMarkdown(`${header}\n${divider}`);
  assert.deepEqual(oversized.map((block) => block.type), ['paragraph']);
});
