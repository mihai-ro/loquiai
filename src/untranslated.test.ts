import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isUntranslated } from './untranslated.js';

describe('isUntranslated', () => {
  test('a blank target for a source with text is untranslated', () => {
    assert.equal(isUntranslated('Hello', ''), true);
    assert.equal(isUntranslated('Hello', '   '), true);
  });

  test('a target with text is translated', () => {
    assert.equal(isUntranslated('Hello', 'Bonjour'), false);
  });

  test('a blank source has nothing to translate, whatever the target holds', () => {
    assert.equal(isUntranslated('', ''), false);
    assert.equal(isUntranslated('  ', ''), false);
    assert.equal(isUntranslated('', 'x'), false);
  });
});
