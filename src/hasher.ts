import fs from 'node:fs';
import path from 'node:path';
import type { HashStore } from './types.js';
import { readJson, writeJson } from './utils/json.js';

export function loadHashStore(hashFile: string): HashStore {
  return readJson(hashFile) as HashStore;
}

export function saveHashStore(hashFile: string, store: HashStore): void {
  fs.mkdirSync(path.dirname(hashFile), { recursive: true });
  writeJson(hashFile, store as Record<string, unknown>);
}

/**
 * FNV-1a 32-bit hash — fast, zero-allocation, no imports.
 * Sufficient collision resistance for i18n change detection.
 * Output: 8 lowercase hex characters.
 */
export function hashValue(value: string): string {
  let h = 2166136261; // FNV-32 offset basis
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0; // FNV-32 prime, keep uint32
  }
  return h.toString(16).padStart(8, '0');
}

export function buildUpdatedHashStore(existing: HashStore, currentHashes: HashStore): HashStore {
  return { ...existing, ...currentHashes };
}
