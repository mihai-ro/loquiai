const MASK_PREFIX = '⟦';
const MASK_SUFFIX = '⟧';
const REGEX_CACHE_MAX = 128;

function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) return undefined;
  const val = cache.get(key)!;
  cache.delete(key);
  cache.set(key, val);
  return val;
}

function lruSet<K, V>(cache: Map<K, V>, key: K, val: V, max: number): void {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= max) cache.delete(cache.keys().next().value!);
  cache.set(key, val);
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
  for (let idx = 0; idx < (customPatterns ?? []).length; idx++) {
    const pattern = customPatterns![idx];
    let re = lruGet(customRegexCache, pattern);
    if (!re) {
      try {
        re = new RegExp(pattern, 'g');
      } catch {
        throw new Error(
          `Invalid placeholder pattern at config.placeholderPatterns[${idx}]: ${JSON.stringify(pattern)}`
        );
      }
      lruSet(customRegexCache, pattern, re, REGEX_CACHE_MAX);
    }
    re.lastIndex = 0;
    result = result.replace(re, (match) => mask(match));
  }

  // {{double mustache}} — Vue, Angular, Handlebars, Jinja2
  result = result.replace(/\{\{.*?\}\}/g, (match) => mask(match));

  // ${template literals / interpolations} — JS, Angular
  result = result.replace(/\$\{[^}]+\}/g, (match) => mask(match));

  // ICU plural/select blocks (balanced braces, e.g. {count, plural, =1 {one} other {#}})
  result = maskIcuBlocks(result, mask);

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

function maskIcuBlocks(input: string, mask: (token: string) => string): string {
  const ICU_START = /\{[a-zA-Z_]\w*\s*,\s*(plural|select|selectordinal)/g;
  let result = input;

  let safetyLimit = 100;
  while (safetyLimit-- > 0) {
    ICU_START.lastIndex = 0;
    const match = ICU_START.exec(result);
    if (!match) break;

    const start = match.index;
    const full = extractBalancedBraces(result, start);
    if (!full) break;

    result = result.slice(0, start) + mask(full) + result.slice(start + full.length);
  }

  return result;
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
