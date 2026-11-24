import fs from 'node:fs';
import { LoquiError } from '../errors.js';
import type { FlatDocument, FlatTranslations } from '../types.js';

/**
 * flattens a nested JSON document into dot-notation keys, splitting it by leaf type.
 *
 * Only real strings are translatable, so only those go to an engine. Everything else —
 * numbers, booleans, null, and empty containers — is carried verbatim in `values` and
 * restored unchanged, because coercing it to a string loses the original irreversibly.
 * Arrays flatten positionally (`items.0`, `items.1`) and their paths are recorded so
 * unflatten rebuilds an array rather than an object with "0"/"1" keys.
 *
 * { A: { B: "val" } }   → strings: { "A.B": "val" }
 * { n: 42, xs: ["a"] }  → strings: { "xs.0": "a" }, values: { n: 42 }, arrayPaths: ["xs"]
 */
export function flatten(obj: Record<string, unknown>): FlatDocument {
  const doc: FlatDocument = { strings: {}, values: {}, arrayPaths: [] };
  for (const [key, value] of Object.entries(obj)) {
    if (key === UNSAFE_KEY) continue;
    flattenValue(escapeSegment(key), value, doc);
  }
  return doc;
}

/**
 * A key may legitimately contain the separator — `{"nested":{"a.b":"x"}}` is valid
 * JSON and common in locale files. The dot is escaped inside a segment so splitting
 * can tell `a.b` (one key) from `a` → `b` (two levels); backslash escapes itself.
 * The escape lives in the flat key itself, so it survives every round trip that key
 * makes — through an engine, a hash sidecar, and back out of an existing target file.
 */
function escapeSegment(key: string): string {
  return key.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}

/** Splits a flat key on unescaped separators, undoing escapeSegment as it goes. */
export function splitFlatKey(flatKey: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < flatKey.length; i++) {
    const char = flatKey[i];
    if (char === '\\' && i + 1 < flatKey.length) {
      current += flatKey[++i];
    } else if (char === '.') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function flattenValue(flatKey: string, value: unknown, doc: FlatDocument): void {
  if (typeof value === 'string') {
    doc.strings[flatKey] = value;
    return;
  }

  if (Array.isArray(value)) {
    // an empty array has no children to carry it, so it is stored as a leaf
    if (value.length === 0) {
      doc.values[flatKey] = [];
      return;
    }
    doc.arrayPaths.push(flatKey);
    for (const [index, item] of value.entries()) {
      flattenValue(`${flatKey}.${index}`, item, doc);
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      doc.values[flatKey] = {};
      return;
    }
    for (const [key, child] of entries) {
      if (key === UNSAFE_KEY) continue;
      flattenValue(`${flatKey}.${escapeSegment(key)}`, child, doc);
    }
    return;
  }

  // number, boolean, null — kept exactly as parsed
  doc.values[flatKey] = value;
}

/**
 * The only key that is not plain data. `JSON.parse` yields it as an own property, but
 * assigning it onto an ordinary object rewrites that object's prototype. Every other
 * Object.prototype name is just a key, because containers here are null-prototype.
 */
const UNSAFE_KEY = '__proto__';

/**
 * unflattens dot-notation keys back into a nested document.
 * { A: { B: "val" } } ← strings: { "A.B": "val" }
 */
export function unflatten(doc: FlatDocument): Record<string, unknown> {
  const arrays = new Set(doc.arrayPaths);
  const result: Record<string, unknown> = Object.create(null);

  // Shallowest path first, so a leaf is always written before any child that shares its
  // path and the child wins. That matters when a target file disagrees with the source
  // about a path's shape — a locale file written by an older version holds "a,b" where
  // the source now has ["a","b"], and the array has to survive. The sort is stable, so
  // array indices keep their relative order.
  const entries = [...Object.entries(doc.strings), ...Object.entries(doc.values)].sort(
    (a, b) => splitFlatKey(a[0]).length - splitFlatKey(b[0]).length,
  );

  for (const [flatKey, value] of entries) {
    const parts = splitFlatKey(flatKey);
    if (parts.includes(UNSAFE_KEY)) continue;

    let cursor: Record<string, unknown> = result;
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const escaped = escapeSegment(part);
      prefix = prefix ? `${prefix}.${escaped}` : escaped;
      const existing = cursor[part];
      if (typeof existing !== 'object' || existing === null) {
        cursor[part] = arrays.has(prefix) ? [] : Object.create(null);
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }

  return result;
}

/**
 * Builds a document whose translatable strings are `strings` but whose structure and
 * non-string leaves come from `source`. Used to serialize a target locale: only the
 * strings were translated, so the rest mirrors the source it came from. The exception is a
 * non-string value the existing `target` holds under the same key with the same JSON type:
 * it is that locale's own (`rtl`, `firstDay`), and a stale one costs less than lost data.
 * No other key the target held is carried over: a target holds exactly the source's keys.
 * Strings inside arrays that have no translation are written empty.
 */
export function withStrings(source: FlatDocument, strings: FlatTranslations, target?: FlatDocument): FlatDocument {
  // An array has to keep its length and element types, so a string inside one that has
  // no translation is written empty. Outside an array an absent key is left absent: it
  // falls back at runtime, where an empty string would not.
  const arrays = new Set(source.arrayPaths);
  const filled = { ...strings };
  for (const key of Object.keys(source.strings)) {
    if (!Object.hasOwn(filled, key) && isInsideArray(key, arrays)) filled[key] = '';
  }
  const values = { ...source.values };
  if (target) {
    for (const [key, sourceValue] of Object.entries(source.values)) {
      if (Object.hasOwn(target.values, key) && jsonType(target.values[key]) === jsonType(sourceValue)) {
        setOwn(values, key, target.values[key]);
      }
    }
  }
  return { strings: filled, values, arrayPaths: [...source.arrayPaths] };
}

/** `null`, an array and an object each count as a type of their own, apart from `typeof`. */
function jsonType(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function isInsideArray(flatKey: string, arrayPaths: Set<string>): boolean {
  const parts = splitFlatKey(flatKey);
  let prefix = '';
  for (let i = 0; i < parts.length - 1; i++) {
    const escaped = escapeSegment(parts[i]);
    prefix = prefix ? `${prefix}.${escaped}` : escaped;
    if (arrayPaths.has(prefix)) return true;
  }
  return false;
}

/**
 * deep-sorts an object's keys alphabetically at every level.
 * Arrays keep their order — position is meaning — but objects inside them are sorted.
 */
export function deepSortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortValue(obj[key]);
  }
  return sorted;
}

function sortValue(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortValue);
  if (val !== null && typeof val === 'object') return deepSortKeys(val as Record<string, unknown>);
  return val;
}

/**
 * reads and parses a JSON file. A file that does not exist reads as an empty object; one
 * that cannot be read, parsed or is not an object is an error, because reading it as empty means the caller
 * rewrites it — a target file with a merge-conflict marker would be translated from
 * scratch and overwritten.
 */
export function readJson(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LoquiError(
      'PARSE_ERROR',
      `Could not parse ${filePath} as JSON: ${err instanceof Error ? err.message : err}`,
      {
        cause: err,
      },
    );
  }
  return assertJsonObject(parsed, filePath);
}

/**
 * Sets an own property, even one named `__proto__`, where plain assignment would replace the
 * object's prototype. Returns the value so a caller can set and use it in one step.
 */
export function setOwn<T>(target: object, key: string, value: T): T {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return value;
}

/** A document is a JSON object: `null`, an array, a string or a number is not one a run can use. */
export function assertJsonObject(value: unknown, filePath: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LoquiError('PARSE_ERROR', `${filePath} is valid JSON but not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * writes a string to a file atomically (tmp → rename) so a crash mid-write
 * never leaves a half-written file at the destination path.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * writes an object to a JSON file atomically (tmp → rename) so a crash mid-write
 * never leaves a half-written file at the destination path.
 */
export function writeJson(filePath: string, data: Record<string, unknown>): void {
  writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
