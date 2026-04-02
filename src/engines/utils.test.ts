import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sanitizeForDisplay, truncate } from './utils.js';

describe('sanitizeForDisplay', () => {
  test('strips OpenAI-style sk- keys', () => {
    const text = 'API error with key sk-1234567890abcdefghij1234567890abcdef';
    const result = sanitizeForDisplay(text);
    assert.ok(result.includes('sk-***REDACTED***'));
    assert.ok(!result.includes('1234567890'));
  });

  test('strips Gemini gsk_ keys', () => {
    const text = 'gsk_1234567890abcdefghijklmnopqrstuvwxyz refused';
    const result = sanitizeForDisplay(text);
    assert.ok(result.includes('gsk_***REDACTED***'));
  });

  test('strips Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def12345678901234';
    const result = sanitizeForDisplay(text);
    assert.ok(result.includes('Bearer ***REDACTED***'));
  });

  test('strips JSON-stringified api_key values', () => {
    const text = '{"x-api-key": "sk-abcdefghijklmnopqrst"}';
    const result = sanitizeForDisplay(text);
    assert.ok(!result.includes('sk-abcdefghijklmnopqrst'));
    assert.ok(result.includes('REDACTED'));
  });

  test('truncates long text', () => {
    const text = 'x'.repeat(500);
    const result = sanitizeForDisplay(text, 100);
    assert.ok(result.length <= 102); // 100 + '…' + possible re-match expansion
    assert.ok(result.includes('…'));
  });

  test('preserves safe text unchanged', () => {
    const text = 'Translation failed: no valid response';
    const result = sanitizeForDisplay(text);
    assert.equal(result, text);
  });
});

describe('truncate', () => {
  test('truncates long strings', () => {
    const result = truncate('hello world', 5);
    assert.equal(result, 'hello…');
  });

  test('returns short strings unchanged', () => {
    const result = truncate('hi', 5);
    assert.equal(result, 'hi');
  });
});
