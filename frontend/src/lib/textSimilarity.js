// Text similarity for finding an item by what a person types (ADR-0087): case, accents, and spacing never matter; a
// query found whole, or every word starting a word of the text, matches fully; otherwise the share of the query's
// letter trigrams the text contains tolerates typos and partial words.

/** Text folded for comparison: no accents, lower case, single spaces. */
export function foldText(text) {
  return String(text).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function trigrams(text) {
  const padded = ` ${text} `;
  const grams = new Set();
  for (let index = 0; index + 3 <= padded.length; index += 1) grams.add(padded.slice(index, index + 3));
  return grams;
}

/** How much `text` looks like `query`, from 0 to 1; an empty query matches everything fully. */
export function similarity(query, text) {
  const wanted = foldText(query);
  const found = foldText(text);
  if (!wanted || found.includes(wanted)) return 1;
  const words = found.split(' ');
  const queryWords = wanted.split(' ');
  const prefixes = queryWords.filter((word) => words.some((candidate) => candidate.startsWith(word))).length;
  const grams = trigrams(wanted);
  const own = trigrams(found);
  const shared = [...grams].filter((gram) => own.has(gram)).length;
  return Math.max(prefixes / queryWords.length, shared / grams.size);
}

/** The items that look like `query`, most similar first and otherwise in their own order. */
export function rankBySimilarity(items, query, textOf, threshold = 0.5) {
  if (!foldText(query)) return items;
  return items
    .map((item, index) => ({ item, index, score: similarity(query, textOf(item)) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
