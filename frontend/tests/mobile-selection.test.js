import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'acorn';

import config from '../playwright.config.js';

// The phone projects run only tests tagged @mobile (playwright.config.js). This static policy guard finds tests whose
// code takes a different path on a phone viewport or by touch and requires the tag on each. It recognizes the code
// signals below; a component whose behaviour differs without one still needs review when it changes.
const SIGNAL_MEMBERS = new Set(['viewportSize', 'setViewportSize', 'isMobile', 'hasTouch', 'tap', 'touchscreen']);
const SIGNAL_STRINGS = new Set(['Open the Team list', 'Input.dispatchTouchEvent']);
const E2E = new URL('../e2e/', import.meta.url);

function children(node) {
  return Object.entries(node)
    .filter(([key]) => key !== 'loc')
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value.type === 'string');
}

function walk(node, visit) {
  if (visit(node) === false) return;
  for (const child of children(node)) walk(child, visit);
}

function memberName(node) {
  return node?.type === 'MemberExpression' && !node.computed ? node.property.name : undefined;
}

function isProjectName(node) {
  return memberName(node) === 'name' && memberName(node.object) === 'project';
}

function stringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral') return node.quasis.map((quasi) => quasi.value.cooked).join('${}');
  return undefined;
}

// Whether a node is exactly the member chain `root.first.second...` of the identifier `root`.
function chain(node, root, ...members) {
  let current = node;
  for (const member of members.reverse()) {
    if (memberName(current) !== member) return false;
    current = current.object;
  }
  return current?.type === 'Identifier' && current.name === root;
}

// The phone-skip conditions this guard recognizes, read from the test's own fixtures, each for the phone project
// that would run the test: mobile-slow for a test tagged @slow, mobile otherwise. Touch and a phone viewport exclude
// both.
function excludesPhones(condition, slow, { info, page }) {
  // test.skip() without a condition skips the test on every project.
  if (condition === undefined) return true;
  if (info && chain(condition, info, 'project', 'use', 'hasTouch')) return true;
  if (condition?.type !== 'BinaryExpression') return false;
  const { left, operator, right } = condition;
  if (info && chain(left, info, 'project', 'name') && right.type === 'Literal') {
    return (operator === '===' && right.value === (slow ? 'mobile-slow' : 'mobile'))
      || (operator === '!==' && right.value === (slow ? 'desktop-slow' : 'desktop'));
  }
  return Boolean(page) && operator === '<=' && memberName(left) === 'width' && left.object.type === 'CallExpression'
    && chain(left.object.callee, page, 'viewportSize') && right.type === 'Literal' && right.value >= 390;
}

// The names a test function gives its page fixture and its test information.
function fixtures(test) {
  const [first, second] = test.params ?? [];
  const page = first?.type === 'ObjectPattern'
    ? first.properties.find((property) => property.key?.name === 'page' && property.value.type === 'Identifier')
    : undefined;
  return { page: page?.value.name, info: second?.type === 'Identifier' ? second.name : undefined };
}

function isSkip(node) {
  return node.type === 'CallExpression' && memberName(node.callee) === 'skip'
    && node.callee.object.type === 'Identifier' && node.callee.object.name === 'test';
}

// The skips a test runs before anything else that keep it off its phone project: only those exempt it. Its leading
// skip statements are read in order; the first other statement ends them.
function exemptions(test, slow) {
  const block = test.type === 'BlockStatement' ? test : test.body;
  const leading = [];
  for (const statement of block?.type === 'BlockStatement' ? block.body : []) {
    if (statement.type !== 'ExpressionStatement' || !isSkip(statement.expression)) break;
    leading.push(statement);
  }
  return leading.filter((statement) => excludesPhones(statement.expression.arguments[0], slow, fixtures(test)));
}

// What in a function body signals a phone-specific path, apart from the statements given.
function signals(body, helpers, skipped = []) {
  const found = [];
  walk(body, (node) => {
    if (skipped.includes(node)) return false;
    const member = memberName(node);
    if (SIGNAL_MEMBERS.has(member)) found.push(`.${member}`);
    if (isProjectName(node)) found.push('project.name');
    if (SIGNAL_STRINGS.has(stringValue(node))) found.push(JSON.stringify(stringValue(node)));
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && helpers.has(node.callee.name)) {
      found.push(`${node.callee.name}()`);
    }
    return undefined;
  });
  return found;
}

// Local helpers by name, those signalling a phone path found again until none is added, so a wrapper such as one
// that opens the Team list through the drawer marks its callers too.
function phoneHelpers(program) {
  const bodies = new Map();
  walk(program, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) bodies.set(node.id.name, node.body);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
      && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
      bodies.set(node.id.name, node.init.body);
    }
  });
  const helpers = new Set();
  for (let added = true; added;) {
    added = false;
    for (const [name, body] of bodies) {
      if (!helpers.has(name) && signals(body, helpers).length > 0) {
        helpers.add(name);
        added = true;
      }
    }
  }
  return helpers;
}

function tagsOf(options, title) {
  const tags = [...(title ?? '').matchAll(/@[\w-]+/g)].map(([tag]) => tag);
  const tag = options?.type === 'ObjectExpression'
    ? options.properties.find((property) => property.key?.name === 'tag')?.value
    : undefined;
  if (tag?.type === 'Literal') tags.push(tag.value);
  if (tag?.type === 'ArrayExpression') tags.push(...tag.elements.map((element) => element.value));
  return tags;
}

// Every test declaration with the tags it carries, its own and those of each enclosing describe.
function tests(program) {
  const found = [];
  const visit = (node, inherited) => {
    if (node.type === 'CallExpression' && node.arguments.length >= 2) {
      const [title, second, third] = node.arguments;
      const options = third ? second : undefined;
      const body = third ?? second;
      const describe = memberName(node.callee) === 'describe' && node.callee.object.name === 'test';
      const declared = node.callee.type === 'Identifier' && node.callee.name === 'test';
      if ((describe || declared) && stringValue(title) !== undefined) {
        const tags = [...inherited, ...tagsOf(options, stringValue(title))];
        if (declared) found.push({ title: stringValue(title), line: node.loc.start.line, tags, body });
        for (const child of children(body)) visit(child, tags);
        return;
      }
    }
    for (const child of children(node)) visit(child, inherited);
  };
  visit(program, []);
  return found;
}

function specs() {
  return readdirSync(E2E).filter((name) => name.endsWith('.spec.js')).sort().map((name) => ({
    name,
    program: parse(readFileSync(new URL(name, E2E), 'utf8'), {
      ecmaVersion: 'latest', sourceType: 'module', locations: true,
    }),
  }));
}

test('static selection: every test whose path differs on a phone or by touch is tagged @mobile', () => {
  const untagged = [];
  let tagged = 0;
  for (const { name, program } of specs()) {
    const helpers = phoneHelpers(program);
    for (const { title, line, tags, body } of tests(program)) {
      if (tags.includes('@mobile')) tagged += 1;
      const exempt = exemptions(body, tags.includes('@slow'));
      const found = signals(body, helpers, exempt);
      if (found.length > 0 && !tags.includes('@mobile') && exempt.length === 0) {
        untagged.push(`${name}:${line} ${title} (${[...new Set(found)].join(', ')})`);
      }
    }
  }
  assert.deepEqual(untagged, []);
  assert.ok(tagged > 0, 'no test is tagged @mobile');
});

test('static selection: the phone projects run exactly the @mobile tests and the desktop projects all of them', () => {
  const projects = Object.fromEntries(config.projects.map((project) => [project.name, project]));
  const selects = (project, title) => (!project.grep || project.grep.test(title))
    && !(project.grepInvert && project.grepInvert.test(title));
  for (const [title, desktop, desktopSlow, mobile, mobileSlow] of [
    ['a test', true, false, false, false],
    ['a test @mobile', true, false, true, false],
    ['a test @slow', false, true, false, false],
    ['a test @slow @mobile', false, true, false, true],
    ['a test @mobile @slow', false, true, false, true],
  ]) {
    assert.deepEqual(
      [selects(projects.desktop, title), selects(projects['desktop-slow'], title), selects(projects.mobile, title),
        selects(projects['mobile-slow'], title)],
      [desktop, desktopSlow, mobile, mobileSlow],
      title,
    );
  }
  assert.equal(projects.mobile.use.hasTouch, true);
  assert.equal(projects['mobile-slow'].use.hasTouch, true);
});

test('static selection: a phone signal is found through local helpers and only a recognized skip exempts it', () => {
  const program = parse(`
    async function openList(page) { if (page.viewportSize().width <= 820) await page.tap(); }
    async function wrapper(page) { await openList(page); }
    test('uses the wrapper', async ({ page }) => { await wrapper(page); });
    test('is tagged', { tag: '@mobile' }, async ({ page }) => { await wrapper(page); });
    test.describe('suite', { tag: ['@slow', '@mobile'] }, () => {
      test('inherits', async ({ page }) => { await openList(page); });
    });
    test('desktop only', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'one is enough');
      await openList(page);
    });
    test('skips wide screens only', async ({ page }) => {
      test.skip(page.viewportSize().width > 820, 'wrong way round');
    });
    test('slow but skips only the regular phone project', { tag: '@slow' }, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name === 'mobile', 'mobile-slow still runs it');
      await openList(page);
    });
    test('slow and skips its phone project', { tag: '@slow' }, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name === 'mobile-slow', 'kept off phones');
      await openList(page);
    });
    test('skips only in a branch', async ({ page }, testInfo) => {
      if (false) test.skip(testInfo.project.name === 'mobile', 'never runs');
      await openList(page);
    });
    test('skips only in an uncalled function', async ({ page }, testInfo) => {
      const later = () => test.skip(testInfo.project.name === 'mobile', 'never called');
      await openList(page);
    });
    test('skips on touch', async ({ page }, testInfo) => {
      test.skip(testInfo.project.use.hasTouch, 'pointer only');
      await openList(page);
    });
    test('skips everywhere', async ({ page }, testInfo) => {
      test.skip();
      await openList(page);
    });
    test('skips after its work', async ({ page }, testInfo) => {
      await openList(page);
      test.skip(testInfo.project.name === 'mobile', 'too late');
    });
    test('skips after returning', async ({ page }, testInfo) => {
      return;
      test.skip(testInfo.project.name === 'mobile', 'never reached');
    });
    test('skips on a touch flag of its own', async ({ page }) => {
      const pointer = { project: { use: { hasTouch: false } } };
      test.skip(pointer.project.use.hasTouch, 'not a fixture');
      await openList(page);
    });
    test('plain', async ({ page }) => { await page.click('a'); });
  `, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const helpers = phoneHelpers(program);
  assert.deepEqual([...helpers].sort(), ['later', 'openList', 'wrapper']);
  const verdict = Object.fromEntries(tests(program).map(({ title, tags, body }) => {
    const exempt = exemptions(body, tags.includes('@slow'));
    return [title, signals(body, helpers, exempt).length === 0 || tags.includes('@mobile') || exempt.length > 0];
  }));
  assert.deepEqual(verdict, {
    'uses the wrapper': false,
    'is tagged': true,
    inherits: true,
    'desktop only': true,
    'skips wide screens only': false,
    'slow but skips only the regular phone project': false,
    'slow and skips its phone project': true,
    'skips only in a branch': false,
    'skips only in an uncalled function': false,
    'skips on touch': true,
    'skips everywhere': true,
    'skips after its work': false,
    'skips after returning': false,
    'skips on a touch flag of its own': false,
    plain: true,
  });
});
