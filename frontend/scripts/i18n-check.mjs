// i18n structural integrity — run through a real JS engine (node), no bundler, no deps.
// Emits a JSON report and exits non-zero if any locale drifts from the English baseline.
// Consumed by tests/test-admin-i18n.py (via the node docker image, since node isn't on the host).
import { messages } from '../src/lib/messages.js';

const EXPECTED = ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar'];

// Every leaf key-path (strings and arrays are leaves — array LENGTH may differ per language, only
// the presence of the key is enforced, so a locale can have 2 or 3 steps freely).
function paths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...paths(v, p));
    else out.push(p);
  }
  return out;
}

const codes = Object.keys(messages);
const en = new Set(paths(messages.en));
const report = { codes, expected: EXPECTED, parityOk: true, missing: {}, extra: {}, enFieldKeys: Object.keys(messages.en.fields) };

for (const code of EXPECTED) {
  if (!messages[code]) {
    report.missing[code] = ['<entire locale missing>'];
    report.parityOk = false;
    continue;
  }
  const cur = new Set(paths(messages[code]));
  const missing = [...en].filter((p) => !cur.has(p));
  const extra = [...cur].filter((p) => !en.has(p));
  if (missing.length) {
    report.missing[code] = missing;
    report.parityOk = false;
  }
  if (extra.length) {
    report.extra[code] = extra;
    report.parityOk = false;
  }
}

const codesOk = EXPECTED.every((c) => messages[c]) && codes.length === EXPECTED.length;
console.log(JSON.stringify(report, null, 2));
process.exit(report.parityOk && codesOk ? 0 : 1);
