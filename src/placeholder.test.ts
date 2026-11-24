import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { IcuMaskError, maskPlaceholders, restorePlaceholders } from './placeholder.js';

describe('maskPlaceholders', () => {
  test('masks {{double mustache}} tokens', () => {
    const { masked, map } = maskPlaceholders('Hello {{name}}, welcome to {{place}}.');
    assert.ok(!masked.includes('{{'), 'should not contain {{ in masked output');
    assert.equal(Object.keys(map).length, 2);
    assert.ok(Object.values(map).includes('{{name}}'));
    assert.ok(Object.values(map).includes('{{place}}'));
  });

  test('masks ${template literal} tokens', () => {
    const { masked, map } = maskPlaceholders('Value: ${GLOSSARY.TERM} and ${count}.');
    assert.ok(!masked.includes('${'));
    assert.equal(Object.keys(map).length, 2);
  });

  test('masks simple {variable} ICU tokens', () => {
    const { masked, map } = maskPlaceholders('Hello {name}, you have {count} messages.');
    assert.ok(!masked.includes('{name}'));
    assert.ok(!masked.includes('{count}'));
    assert.equal(Object.keys(map).length, 2);
  });

  test('masks only the structure of an ICU plural block and leaves its branch text visible', () => {
    const input = '{count, plural, =1 {# item} other {# items}}';
    const { masked, map } = maskPlaceholders(input);
    assert.equal(masked, '⟦0⟧⟦1⟧ item⟦2⟧⟦3⟧ items⟦4⟧');
    assert.deepEqual(Object.values(map), ['{count, plural, =1 {', '#', '} other {', '#', '}}']);
    assert.equal(restorePlaceholders(masked, map), input);
  });

  test('masks the header offset, the selectors and what sits inside a branch', () => {
    const input = '{n, plural, offset:1 =0 {none} one {# {name}} other {# <b>x</b>}}';
    const { masked, map } = maskPlaceholders(input);
    assert.equal(masked, '⟦0⟧none⟦1⟧⟦2⟧ ⟦6⟧⟦3⟧⟦4⟧ ⟦7⟧x⟦8⟧⟦5⟧');
    assert.equal(map['⟦0⟧'], '{n, plural, offset:1 =0 {');
    assert.equal(map['⟦6⟧'], '{name}');
    assert.equal(restorePlaceholders(masked, map), input);
  });

  test('masks a block nested in a branch the same way, and # inside it', () => {
    const input = '{c, plural, one {a {g, select, male {he has #} other {she has #}} item} other {x}}';
    const { masked, map } = maskPlaceholders(input);
    assert.ok(!/plural|select|male|other/.test(masked.replace(/he|she/g, '')), masked);
    assert.match(masked, /he has ⟦\d+⟧/);
    assert.equal(restorePlaceholders(masked, map), input);
  });

  test('masks a variable that opens a branch, which `{{` would otherwise read as a mustache', () => {
    const input = '{count, plural, one {{count} file} other {{count} files}}';
    const { masked, map } = maskPlaceholders(input);
    assert.ok(!masked.includes('{') && !masked.includes('}'), masked);
    assert.equal(Object.values(map).filter((token) => token === '{count}').length, 2);
    assert.match(masked, / file/);
    assert.equal(restorePlaceholders(masked, map), input);
  });

  test('masks a mustache inside a branch as one token', () => {
    const input = '{count, plural, one {{{name}} item} other {# items}}';
    const { masked, map } = maskPlaceholders(input);
    assert.deepEqual(
      Object.values(map).filter((token) => token.includes('name')),
      ['{{name}}'],
    );
    assert.match(masked, / item/);
    assert.equal(restorePlaceholders(masked, map), input);
  });

  test('masks a mustache outside any ICU block as one token', () => {
    const { masked, map } = maskPlaceholders('Hello {{name}}');
    assert.equal(masked, 'Hello ⟦0⟧');
    assert.deepEqual(map, { '⟦0⟧': '{{name}}' });
  });

  test('round-trips a block nested directly after a case brace', () => {
    const input = '{count, plural, one {{g, select, male {he} other {they}}} other {many}}';
    const { masked, map } = maskPlaceholders(input);
    assert.match(masked, /he/);
    assert.ok(!/plural|select|male/.test(masked), masked);
    assert.equal(restorePlaceholders(masked, map), input);
  });

  test('leaves # visible outside a plural, where it is only text', () => {
    const { masked } = maskPlaceholders('{g, select, a {Item #1} other {Item #2}}');
    assert.match(masked, /Item #1/);
  });

  test('masks HTML tags', () => {
    const { masked, map } = maskPlaceholders('Click <strong>here</strong> or <br/>.');
    assert.ok(!masked.includes('<strong>'));
    assert.ok(!masked.includes('</strong>'));
    assert.ok(!masked.includes('<br/>'));
    assert.equal(Object.keys(map).length, 3);
  });

  test('applies custom patterns before built-ins', () => {
    const { masked, map } = maskPlaceholders('Price: %{amount} dollars', ['%\\{[^}]+\\}']);
    assert.ok(!masked.includes('%{amount}'));
    assert.ok(Object.values(map).includes('%{amount}'));
  });

  test('leaves plain text untouched', () => {
    const { masked, map } = maskPlaceholders('Just plain text here.');
    assert.equal(masked, 'Just plain text here.');
    assert.equal(Object.keys(map).length, 0);
  });

  test('handles mixed content', () => {
    const input = '{{greeting}}, ${user}! You have {count, plural, =1 {# msg} other {# msgs}}.';
    const { masked } = maskPlaceholders(input);
    assert.ok(!masked.includes('{{greeting}}'));
    assert.ok(!masked.includes('${user}'));
    assert.ok(!masked.includes('{count'));
  });
});

describe('restorePlaceholders', () => {
  test('round-trips correctly', () => {
    const original = 'Hello {{name}}, you have ${count} new <strong>messages</strong>.';
    const { masked, map } = maskPlaceholders(original);
    assert.notEqual(masked, original);
    assert.equal(restorePlaceholders(masked, map), original);
  });

  test('handles LLM duplicating a mask token', () => {
    const { map } = maskPlaceholders('{{name}}');
    const maskKey = Object.keys(map)[0];
    // simulate LLM repeating the mask token twice
    const duplicated = `${maskKey} ${maskKey}`;
    const restored = restorePlaceholders(duplicated, map);
    assert.equal(restored, '{{name}} {{name}}');
  });

  test('is a no-op when map is empty', () => {
    assert.equal(restorePlaceholders('hello world', {}), 'hello world');
  });

  test('restores variable nested inside an HTML attribute', () => {
    // {knowledgeBaseUrl} gets masked first (⟦0⟧), then the whole <a> tag is masked (⟦1⟧).
    // restorePlaceholders must expand ⟦1⟧ first to reveal ⟦0⟧, then expand ⟦0⟧.
    const original = `Visit our <a href='{knowledgeBaseUrl}' target='_blank'>Help Desk</a> for help.`;
    const { masked, map } = maskPlaceholders(original);
    assert.equal(restorePlaceholders(masked, map), original);
  });
});

describe('maskPlaceholders — ICU block limit', () => {
  test('masks a value with many ICU blocks', () => {
    const value = Array.from({ length: 200 }, (_, i) => `{n${i}, plural, one {#} other {#}}`).join(' ');
    const result = maskPlaceholders(value);

    assert.equal(Object.keys(result.map).length, 200 * 5);
    assert.ok(!result.masked.includes('plural'), 'every block should be masked');
  });

  test('refuses a value past the limit instead of half-masking it', () => {
    const value = Array.from({ length: 1001 }, (_, i) => `{n${i}, plural, one {#} other {#}}`).join(' ');

    assert.throws(
      () => maskPlaceholders(value),
      (err: unknown) => err instanceof Error && /ICU blocks/.test(err.message),
    );
  });
});

describe('maskPlaceholders — unbalanced ICU block', () => {
  const UNBALANCED = '{g, select, male {he} other {they}} bought {n, plural, one {# item} other {# items}';

  test('refuses a value with an unclosed block instead of sending it unmasked', () => {
    assert.throws(
      () => maskPlaceholders(UNBALANCED),
      (err: unknown) => err instanceof IcuMaskError && /ICU block/.test(err.message),
    );
  });

  test('refuses a block that closes too early the same way', () => {
    assert.throws(() => maskPlaceholders('{n, plural, one {# item} other {# items'), IcuMaskError);
  });

  test('raises the same error class past the block limit', () => {
    const value = Array.from({ length: 1001 }, (_, i) => `{n${i}, plural, one {#} other {#}}`).join(' ');

    assert.throws(() => maskPlaceholders(value), IcuMaskError);
  });

  test('a bad custom pattern is not an ICU failure', () => {
    assert.throws(
      () => maskPlaceholders('Hello', ['(']),
      (err: unknown) =>
        err instanceof Error && !(err instanceof IcuMaskError) && /Invalid placeholder pattern/.test(err.message),
    );
  });
});
