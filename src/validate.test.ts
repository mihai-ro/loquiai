import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FlatTranslations } from './types.js';
import { type ValidationResult, validateLocales } from './validate.js';

describe('validateLocales', () => {
  test('returns no issues when all keys are present', () => {
    const source: FlatTranslations = {
      greeting: 'hello',
      farewell: 'goodbye',
    };
    const existing: Record<string, FlatTranslations> = {
      fr: { greeting: 'bonjour', farewell: 'au revoir' },
    };

    const results = validateLocales(source, existing);

    assert.equal(results.length, 1);
    const fr = results.find((r) => r.locale === 'fr') as ValidationResult;
    assert.equal(fr.missing.length, 0);
    assert.equal(fr.extra.length, 0);
    assert.equal(fr.ok.length, 2);
  });

  test('detects missing keys', () => {
    const source: FlatTranslations = {
      greeting: 'hello',
      farewell: 'goodbye',
      'user.profile.bio': 'bio',
    };
    const existing: Record<string, FlatTranslations> = {
      fr: { greeting: 'bonjour' },
    };

    const results = validateLocales(source, existing);

    const fr = results.find((r) => r.locale === 'fr') as ValidationResult;
    assert.equal(fr.missing.length, 2);
    assert.ok(fr.missing.includes('farewell'));
    assert.ok(fr.missing.includes('user.profile.bio'));
    assert.equal(fr.extra.length, 0);
  });

  test('detects extra keys', () => {
    const source: FlatTranslations = {
      greeting: 'hello',
    };
    const existing: Record<string, FlatTranslations> = {
      fr: {
        greeting: 'bonjour',
        'deprecated.oldKey': 'old value',
      },
    };

    const results = validateLocales(source, existing);

    const fr = results.find((r) => r.locale === 'fr') as ValidationResult;
    assert.equal(fr.missing.length, 0);
    assert.equal(fr.extra.length, 1);
    assert.ok(fr.extra.includes('deprecated.oldKey'));
  });

  test('handles mixed missing and extra keys', () => {
    const source: FlatTranslations = {
      greeting: 'hello',
      'new.greeting': 'hi',
      'user.profile.bio': 'bio',
    };
    const existing: Record<string, FlatTranslations> = {
      fr: {
        greeting: 'bonjour',
        'deprecated.oldKey': 'old value',
      },
    };

    const results = validateLocales(source, existing);

    const fr = results.find((r) => r.locale === 'fr') as ValidationResult;
    assert.equal(fr.missing.length, 2);
    assert.ok(fr.missing.includes('new.greeting'));
    assert.ok(fr.missing.includes('user.profile.bio'));
    assert.equal(fr.extra.length, 1);
    assert.ok(fr.extra.includes('deprecated.oldKey'));
    assert.equal(fr.ok.length, 1);
    assert.ok(fr.ok.includes('greeting'));
  });

  test('returns results for each target locale', () => {
    const source: FlatTranslations = { greeting: 'hello' };
    const existing: Record<string, FlatTranslations> = {
      fr: { greeting: 'bonjour' },
      de: { greeting: 'hallo' },
      es: { greeting: 'hola' },
    };

    const results = validateLocales(source, existing);

    assert.equal(results.length, 3);
    assert.ok(results.some((r) => r.locale === 'fr'));
    assert.ok(results.some((r) => r.locale === 'de'));
    assert.ok(results.some((r) => r.locale === 'es'));
  });
});
