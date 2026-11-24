const MASK_PREFIX = '⟦';
const MASK_SUFFIX = '⟧';
const REGEX_CACHE_MAX = 128;
/** No real translatable value holds this many ICU blocks; see maskIcuBlocks. */
const ICU_BLOCK_LIMIT = 1000;

function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const val = cache.get(key);
  if (val === undefined) return undefined;
  cache.delete(key);
  cache.set(key, val);
  return val;
}

function lruSet<K, V>(cache: Map<K, V>, key: K, val: V, max: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= max) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, val);
}

/**
 * A value whose ICU blocks cannot all be masked. Distinct from a bad config pattern so a
 * caller can skip the one value and carry on, while a config error still fails the run.
 */
export class IcuMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcuMaskError';
  }
}

const customRegexCache = new Map<string, RegExp>();

export interface MaskResult {
  masked: string;
  map: Record<string, string>;
}

export function maskPlaceholders(input: string, customPatterns?: string[]): MaskResult {
  const map: Record<string, string> = {};
  let counter = 0;
  let result = input;

  const mask = (token: string): string => {
    const key = `${MASK_PREFIX}${counter++}${MASK_SUFFIX}`;
    map[key] = token;
    return key;
  };

  // user-defined patterns applied first (most specific)
  // Compiled regex objects are cached so repeated calls don't recompile on every key.
  if (customPatterns) {
    for (let idx = 0; idx < customPatterns.length; idx++) {
      const pattern = customPatterns[idx];
      let re = lruGet(customRegexCache, pattern);
      if (!re) {
        try {
          re = new RegExp(pattern, 'g');
        } catch {
          throw new Error(
            `Invalid placeholder pattern at config.placeholderPatterns[${idx}]: ${JSON.stringify(pattern)}`,
          );
        }
        lruSet(customRegexCache, pattern, re, REGEX_CACHE_MAX);
      }
      re.lastIndex = 0;
      result = result.replace(re, (match) => mask(match));
    }
  }

  // ICU plural/select blocks, before the mustache rule: a branch may open with a variable
  // (`one {{count} file}`), whose braces `{{` would otherwise read as a mustache.
  result = maskIcuBlocks(result, mask);

  // {{double mustache}} — Vue, Angular, Handlebars, Jinja2
  result = result.replace(/\{\{.*?\}\}/g, (match) => mask(match));

  // ${template literals / interpolations} — JS, Angular
  result = result.replace(/\$\{[^}]+\}/g, (match) => mask(match));

  // {simple ICU variable} — after blocks are masked
  result = result.replace(/\{[a-zA-Z_][a-zA-Z0-9_.]*\}/g, (match) => mask(match));

  // HTML/XML tags
  result = result.replace(/<\/?[a-zA-Z][^>]*\/?>/g, (match) => mask(match));

  return { masked: result, map };
}

export function restorePlaceholders(masked: string, map: Record<string, string>): string {
  let result = masked;
  // Restore in reverse order: outer tokens (higher index, created later) are expanded first,
  // revealing any inner tokens they contain so those get restored in subsequent passes.
  for (const [key, original] of Object.entries(map).reverse()) {
    result = result.split(key).join(original);
  }
  return result;
}

const ICU_START = /\{[a-zA-Z_]\w*\s*,\s*(plural|select|selectordinal)/y;
const ICU_HEADER = /\{\s*[a-zA-Z_]\w*\s*,\s*(plural|select|selectordinal)\s*,(\s*offset:\s*\d+)?/y;
const ICU_SELECTOR = /\s*(?:=\d+|[^\s{}]+)\s*\{/y;

const unclosed = () =>
  new IcuMaskError(
    'An ICU block is never closed — the string is almost certainly malformed. ' +
      'Refusing to translate it half-masked, which would leave the rest unprotected.',
  );

/**
 * Masks the structure of plural, select and selectordinal blocks and leaves the text of
 * their branches visible, so the model translates it: the header with any `offset:n`, each
 * case selector with its opening brace, each closing brace, and `#`. Syntax with no
 * branch text between it is one token, so a block's cases do not fill the string with
 * markers. A block nested in a branch is handled the same way.
 *
 * An unclosed or malformed block, or more than ICU_BLOCK_LIMIT of them, has to be loud:
 * returning a half-masked string would send the rest of the block to the model unprotected,
 * where nothing downstream can tell it was ever there.
 */
function maskIcuBlocks(input: string, mask: (token: string) => string): string {
  let out = '';
  let pending = '';
  let blocks = 0;

  const flush = (): void => {
    if (pending === '') return;
    out += mask(pending);
    pending = '';
  };
  const text = (visible: string): void => {
    if (visible === '') return;
    flush();
    out += visible;
  };

  const sticky = (re: RegExp, at: number): RegExpExecArray | null => {
    re.lastIndex = at;
    return re.exec(input);
  };

  /** Masks the block starting at `start` and returns where it ends. */
  const block = (start: number, insidePlural: boolean): number => {
    if (++blocks > ICU_BLOCK_LIMIT) {
      throw new IcuMaskError(
        `More than ${ICU_BLOCK_LIMIT} ICU blocks in a single value — the string is almost certainly malformed. ` +
          'Refusing to translate it half-masked, which would leave the rest unprotected.',
      );
    }
    const header = sticky(ICU_HEADER, start);
    if (!header)
      throw new IcuMaskError('An ICU block has no `, plural,` / `, select,` header — the string is malformed.');
    pending += header[0];
    const inPlural = insidePlural || header[1] !== 'select';
    let pos = start + header[0].length;

    for (;;) {
      const space = /^\s*/.exec(input.slice(pos))?.[0] ?? '';
      pending += space;
      pos += space.length;
      if (pos >= input.length) throw unclosed();
      if (input[pos] === '}') {
        pending += '}';
        return pos + 1;
      }
      const selector = sticky(ICU_SELECTOR, pos);
      if (!selector) throw new IcuMaskError('An ICU block has a case with no `{` — the string is malformed.');
      pending += selector[0];
      pos += selector[0].length;
      pos = branch(pos, inPlural);
    }
  };

  /** Masks a case's text up to and including its closing brace, and returns where it ends. */
  const branch = (from: number, inPlural: boolean): number => {
    let pos = from;
    let run = '';
    while (pos < input.length) {
      const char = input[pos];
      if (char === '}') {
        text(run);
        pending += '}';
        return pos + 1;
      }
      if (char === '{') {
        if (sticky(ICU_START, pos)) {
          text(run);
          run = '';
          pos = block(pos, inPlural);
          continue;
        }
        // Any other brace group stays visible, for the rules that mask variables.
        const group = extractBalancedBraces(input, pos);
        if (!group) throw unclosed();
        run += group;
        pos += group.length;
        continue;
      }
      if (char === '#' && inPlural) {
        text(run);
        run = '';
        flush();
        out += mask('#');
        pos++;
        continue;
      }
      run += char;
      pos++;
    }
    throw unclosed();
  };

  let pos = 0;
  while (pos < input.length) {
    const next = findIcuStart(input, pos);
    if (next === -1) break;
    text(input.slice(pos, next));
    pos = block(next, false);
  }
  text(input.slice(pos));
  flush();
  return out;
}

/** Index of the next ICU block opening at or after `from`, or -1. */
function findIcuStart(input: string, from: number): number {
  const re = new RegExp(ICU_START.source, 'g');
  re.lastIndex = from;
  return re.exec(input)?.index ?? -1;
}

function extractBalancedBraces(str: string, startIndex: number): string | null {
  let depth = 0;
  for (let i = startIndex; i < str.length; i++) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') {
      depth--;
      if (depth === 0) return str.slice(startIndex, i + 1);
    }
  }
  return null;
}
