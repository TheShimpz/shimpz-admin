// What one chat task cost: the model tokens every Brain call of the turn used and how long the turn took. Cost is an
// estimate from the reviewed catalog prices; a model the catalog does not price contributes tokens but no cost.
import MODEL_CATALOG from './modelCatalog.json' with { type: 'json' };

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_TOKENS = 1_000_000_000;
const MAX_MODELS = 16;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const USAGE_KEYS = ['duration_ms', 'models'];
const MODEL_KEYS = ['input_tokens', 'model', 'output_tokens', 'provider'];

const PRICES = new Map(
  MODEL_CATALOG.providers.flatMap((provider) => provider.models.map((model) => [
    `${provider.id}:${model.id}`,
    { title: model.title, input: model.input_usd_per_million_cents, output: model.output_usd_per_million_cents },
  ])),
);

function count(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function exactRecord(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join() === keys.join()
  );
}

function identifier(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function invalid() {
  return new TypeError('invalid task usage');
}

/**
 * The exact task usage of a done frame, or null when the frame carries none (`undefined`). Any other value must be the
 * closed Team turn-usage shape: a duration and 1 to 16 distinct models sorted by provider then model; otherwise it
 * throws, so the whole frame is refused.
 */
export function parseTaskUsage(value) {
  if (value === undefined) return null;
  if (
    !exactRecord(value, USAGE_KEYS) ||
    !count(value.duration_ms, MAX_DURATION_MS) ||
    !Array.isArray(value.models) ||
    value.models.length < 1 ||
    value.models.length > MAX_MODELS
  ) throw invalid();
  let previous = null;
  const models = value.models.map((entry) => {
    if (
      !exactRecord(entry, MODEL_KEYS) ||
      !identifier(entry.provider) ||
      !identifier(entry.model) ||
      !count(entry.input_tokens, MAX_TOKENS) ||
      !count(entry.output_tokens, MAX_TOKENS)
    ) throw invalid();
    // Strictly ascending by provider, then model: distinct and in the one canonical order.
    if (
      previous &&
      (entry.provider < previous.provider || (entry.provider === previous.provider && entry.model <= previous.model))
    ) throw invalid();
    previous = entry;
    return { provider: entry.provider, model: entry.model, input_tokens: entry.input_tokens, output_tokens: entry.output_tokens };
  });
  return { duration_ms: value.duration_ms, models };
}

/** Totals for display: tokens, estimated USD (null when no used model is priced), seconds, and per-model detail. */
export function taskUsageSummary(usage) {
  let tokens = 0;
  let cents = 0;
  let priced = false;
  const detail = usage.models.map((entry) => {
    const price = PRICES.get(`${entry.provider}:${entry.model}`);
    tokens += entry.input_tokens + entry.output_tokens;
    if (price) {
      priced = true;
      cents += (entry.input_tokens * price.input + entry.output_tokens * price.output) / 1_000_000;
    }
    return { title: price?.title ?? entry.model, input: entry.input_tokens, output: entry.output_tokens };
  });
  return { tokens, usd: priced ? cents / 100 : null, seconds: usage.duration_ms / 1000, detail };
}

/** The one-line, locale-formatted label: "≈ US$ 0.0019 · 12,480 tokens · 6.2 s". */
export function formatTaskUsage(summary, locale, copy) {
  const number = new Intl.NumberFormat(locale);
  const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const parts = [];
  if (summary.usd !== null) {
    const money = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: summary.usd < 0.01 ? 4 : 2,
      maximumFractionDigits: summary.usd < 0.01 ? 4 : 2,
    });
    parts.push(`≈ ${money.format(summary.usd)}`);
  }
  parts.push(`${number.format(summary.tokens)} ${copy.tokens}`);
  parts.push(`${seconds.format(summary.seconds)} s`);
  return parts.join(' · ');
}

/** The hover detail: each model's input and output tokens. */
export function formatTaskUsageDetail(summary, locale, copy) {
  const number = new Intl.NumberFormat(locale);
  return summary.detail
    .map((entry) => `${entry.title}: ${number.format(entry.input)} ${copy.input} · ${number.format(entry.output)} ${copy.output}`)
    .join('\n');
}
