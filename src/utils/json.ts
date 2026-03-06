import fs from 'fs';
import { FlatTranslations } from '../types.js';

/**
 * flattens a nested JSON object into dot-notation keys.
 * { A: { B: "val" } } → { "A.B": "val" }
 */
export function flatten(obj: Record<string, unknown>, prefix = '', result: FlatTranslations = {}): FlatTranslations {
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = prefix ? prefix + '.' + key : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as Record<string, unknown>, flatKey, result);
    } else {
      result[flatKey] = String(value ?? '');
    }
  }
  return result;
}

/**
 * unflattens dot-notation keys back into a nested object.
 * { "A.B": "val" } → { A: { B: "val" } }
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function unflatten(flat: FlatTranslations): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [flatKey, value] of Object.entries(flat)) {
    const parts = flatKey.split('.');
    if (parts.some((p) => UNSAFE_KEYS.has(p))) continue;
    let cursor: Record<string, unknown> = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof cursor[part] !== 'object' || cursor[part] === null) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return result;
}

/**
 * deep-sorts an object's keys alphabetically at every level.
 */
export function deepSortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    sorted[key] =
      val !== null && typeof val === 'object' && !Array.isArray(val)
        ? deepSortKeys(val as Record<string, unknown>)
        : val;
  }
  return sorted;
}

/** reads and parses a JSON file. Returns empty object if file doesn't exist. */
export function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

/** writes an object to a JSON file with 2-space indentation and a trailing newline. */
export function writeJson(filePath: string, data: Record<string, unknown>): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

