import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildGlossaryModel,
  buildGlossaryPromptBlock,
  findTermsInText,
  loadGlossaryTerms,
  maskTerms,
} from './glossary.js';

describe('findTermsInText', () => {
  it('matches whole words case-insensitively', () => {
    assert.deepEqual(findTermsInText('Open the dashboard now', ['Dashboard']), ['Dashboard']);
  });
  it('does not match substrings', () => {
    assert.deepEqual(findTermsInText('Githubbing around', ['Git']), []);
  });
  it('returns longest term first when terms overlap', () => {
    assert.deepEqual(findTermsInText('Use GitHub today', ['Git', 'GitHub']), ['GitHub']);
  });
  it('matches accented terms (non-ASCII word boundary)', () => {
    assert.deepEqual(findTermsInText('Öffnen Sie Größe jetzt', ['Größe']), ['Größe']);
  });
  it('does not match accented term as substring', () => {
    assert.deepEqual(findTermsInText('Größenordnung', ['Größe']), []);
  });
  it('does not match term followed immediately by a digit', () => {
    assert.deepEqual(findTermsInText('Pro2024', ['Pro']), []);
  });
});

describe('loadGlossaryTerms', () => {
  it('loads per-locale files from a folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-'));
    fs.mkdirSync(path.join(dir, 'glossary'));
    fs.writeFileSync(path.join(dir, 'glossary/es.json'), JSON.stringify({ Dashboard: 'Tablero' }));
    fs.writeFileSync(path.join(dir, 'glossary/fr.json'), JSON.stringify({ Dashboard: 'Tableau de bord' }));
    const terms = loadGlossaryTerms('glossary', ['es', 'fr'], dir);
    assert.deepEqual(terms, { Dashboard: { es: 'Tablero', fr: 'Tableau de bord' } });
  });
  it('loads a combined single file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-'));
    fs.writeFileSync(path.join(dir, 'g.json'), JSON.stringify({ Dashboard: { es: 'Tablero' } }));
    const terms = loadGlossaryTerms('g.json', ['es'], dir);
    assert.deepEqual(terms, { Dashboard: { es: 'Tablero' } });
  });
  it('returns empty object when path does not exist', () => {
    const terms = loadGlossaryTerms('nonexistent.json', ['es'], '/tmp');
    assert.deepEqual(terms, {});
  });
});

describe('buildGlossaryModel', () => {
  it('returns null when nothing is configured', () => {
    assert.equal(buildGlossaryModel(undefined, undefined, ['es'], '/tmp'), null);
  });
  it('returns null when config is empty (no terms, no noTranslate)', () => {
    assert.equal(buildGlossaryModel({}, undefined, ['es'], '/tmp'), null);
  });
  it('uses inline terms when path is unset', () => {
    const model = buildGlossaryModel({ noTranslate: ['Loqui'] }, { Dashboard: { es: 'Tablero' } }, ['es'], '/tmp');
    assert.deepEqual(model, { terms: { Dashboard: { es: 'Tablero' } }, noTranslate: ['Loqui'] });
  });
  it('returns a model with only noTranslate when no terms exist', () => {
    const model = buildGlossaryModel({ noTranslate: ['Loqui'] }, undefined, ['es'], '/tmp');
    assert.deepEqual(model, { terms: {}, noTranslate: ['Loqui'] });
  });
});

describe('maskTerms', () => {
  it('masks matched terms with T-sentinels and returns a restore map', () => {
    const { masked, map, nextCounter } = maskTerms('Open GitHub please', ['GitHub'], 0);
    assert.equal(masked, 'Open ⟦T0⟧ please');
    assert.deepEqual(map, { '⟦T0⟧': 'GitHub' });
    assert.equal(nextCounter, 1);
  });
  it('preserves the original casing of the matched occurrence', () => {
    const { map } = maskTerms('open github', ['GitHub'], 0);
    assert.deepEqual(map, { '⟦T0⟧': 'github' });
  });
  it('is a no-op when no terms match', () => {
    const { masked, nextCounter } = maskTerms('nothing here', ['GitHub'], 3);
    assert.equal(masked, 'nothing here');
    assert.equal(nextCounter, 3);
  });
});

describe('buildGlossaryPromptBlock', () => {
  it('lists only terms present in the chunk text', () => {
    const terms = { Dashboard: { es: 'Tablero' }, Commit: { es: 'Confirmación' } };
    const block = buildGlossaryPromptBlock(terms, 'Open the Dashboard', ['es']);
    assert.match(block, /Dashboard/);
    assert.match(block, /Tablero/);
    assert.doesNotMatch(block, /Commit/);
  });
  it('returns empty string when no terms apply', () => {
    assert.equal(buildGlossaryPromptBlock({ Dashboard: { es: 'Tablero' } }, 'nothing', ['es']), '');
  });
});
