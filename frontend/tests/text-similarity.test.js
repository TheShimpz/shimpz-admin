import assert from 'node:assert/strict';
import test from 'node:test';

import { foldText, rankBySimilarity, similarity } from '../src/lib/textSimilarity.js';

test('text is compared without case, accents, or extra spaces', () => {
  assert.equal(foldText('  Atualização   SEMANAL '), 'atualizacao semanal');
  assert.equal(similarity('', 'anything'), 1);
  assert.equal(similarity('ATUALIZACAO', 'Atualização semanal do www'), 1);
  assert.equal(similarity('sem atu', 'Atualização semanal do www'), 1);
});

test('a typo or a partial word still matches, and unrelated text does not', () => {
  assert.ok(similarity('certficados', 'Verificação de certificados') >= 0.5);
  assert.ok(similarity('limpesa dns', 'Limpeza mensal de DNS') >= 0.5);
  assert.ok(similarity('pizza', 'Vigia de DNS') < 0.5);
});

test('ranking keeps only similar items, most similar first, ties in their own order', () => {
  const items = ['Vigia de DNS', 'Limpeza mensal de DNS', 'Verificação de certificados'];
  assert.deepEqual(rankBySimilarity(items, '', (item) => item), items);
  assert.deepEqual(rankBySimilarity(items, 'dns', (item) => item), ['Vigia de DNS', 'Limpeza mensal de DNS']);
  assert.deepEqual(rankBySimilarity(items, 'certifcados', (item) => item), ['Verificação de certificados']);
  assert.deepEqual(rankBySimilarity(items, 'pizza', (item) => item), []);
});
