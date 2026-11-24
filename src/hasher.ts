import fs from 'node:fs';
import path from 'node:path';
import { LoquiError } from './errors.js';
import type { HashStore, LocaleHashes } from './types.js';
import { readJson, setOwn, writeJson } from './utils/json.js';

/** How often a key was turned down in a row, and the source hash it was turned down for. */
export interface Attempt {
  hash: string;
  n: number;
}

/** Owner id → locale → flat key → its attempts. */
export type Attempts = Record<string, Record<string, Record<string, Attempt>>>;

/** What the sidecar file holds: the hashes per locale, which input wrote which keys, and what keeps being turned down. */
export interface Sidecar {
  locales: LocaleHashes;
  /** Owner id → the flat keys that input's source had when it last saved. */
  owners: Record<string, string[]>;
  attempts: Attempts;
}

/**
 * Reads the sidecar. A v2 sidecar says nothing about which locale a hash was for, so it is
 * refused rather than guessed at: `loqui migrate` converts it. The top-level `$owners` key
 * is the file's own bookkeeping and is never read as a locale.
 */
export function readSidecar(hashFile: string): Sidecar {
  const raw = readJson(hashFile) as Record<string, unknown>;
  if (isV2Sidecar(raw)) {
    throw new LoquiError(
      'INVALID_CONFIG',
      `${hashFile} is a v2 hash sidecar, which v3 does not read. Convert it once with \`loqui migrate\`.`,
    );
  }
  const locales = Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('$'))) as LocaleHashes;
  return { locales, owners: readOwners(raw.$owners), attempts: readAttempts(raw.$attempts) };
}

/** A v2 sidecar is one flat map of hashes, so its values are strings where v3 has objects. */
export function isV2Sidecar(raw: Record<string, unknown>): boolean {
  return Object.values(raw).some((value) => typeof value === 'string');
}

/** What an input is called in `$owners`: its path from the sidecar, with `/` separators. */
export function ownerId(hashFile: string, inputPath: string): string {
  return path.relative(path.dirname(hashFile), inputPath).split(path.sep).join('/');
}

export function readOwners(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([id, keys]) => [
      id,
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [],
    ]),
  );
}

function readAttempts(value: unknown): Attempts {
  const attempts: Attempts = {};
  for (const [id, byLocale] of ownEntries(value)) {
    const locales: Record<string, Record<string, Attempt>> = {};
    for (const [locale, byKey] of ownEntries(byLocale)) {
      const keys: Record<string, Attempt> = {};
      for (const [key, attempt] of ownEntries(byKey)) {
        const { hash, n } = (attempt ?? {}) as Partial<Attempt>;
        if (typeof hash === 'string' && typeof n === 'number') setOwn(keys, key, { hash, n });
      }
      if (Object.keys(keys).length > 0) setOwn(locales, locale, keys);
    }
    if (Object.keys(locales).length > 0) setOwn(attempts, id, locales);
  }
  return attempts;
}

function ownEntries(value: unknown): [string, unknown][] {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : [];
}

/** The hashes per locale alone, for a reader that has no use for who wrote them. */
export function loadHashStore(hashFile: string): LocaleHashes {
  return readSidecar(hashFile).locales;
}

export function saveSidecar(hashFile: string, sidecar: Sidecar): void {
  fs.mkdirSync(path.dirname(hashFile), { recursive: true });
  const attempts = Object.keys(sidecar.attempts).length > 0 ? { $attempts: sidecar.attempts } : {};
  writeJson(hashFile, { ...sidecar.locales, $owners: sidecar.owners, ...attempts });
}

/**
 * One locale's entries after a run of one input over a sidecar several inputs share: what
 * the file held for keys this input did not write last time, plus this run's hashes. A key
 * this input wrote that its source no longer has is dropped, unless another input lists it.
 * Keys nobody is recorded as owning (a sidecar with no `$owners`) are kept: nothing says
 * whose they are.
 */
export function mergeOwnedHashes(
  loaded: HashStore | undefined,
  ownedBefore: ReadonlySet<string>,
  ownedByOthers: ReadonlySet<string>,
  run: HashStore,
): HashStore {
  const kept = Object.entries(loaded ?? {}).filter(([key]) => !ownedBefore.has(key) || ownedByOthers.has(key));
  return Object.fromEntries([...kept, ...Object.entries(run)]);
}

/** A locale's own store, never one inherited from `Object.prototype`. */
export function localeStore(hashes: LocaleHashes | undefined, locale: string): HashStore | undefined {
  return hashes && Object.hasOwn(hashes, locale) ? hashes[locale] : undefined;
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

/**
 * The sidecar after a run: for each locale in `to`, the current source hash of every key
 * that locale has nothing outstanding for, and the stored hash of the rest. A key the
 * source no longer has is dropped, or the sidecar only ever grows. A key a locale still
 * owes keeps its old hash (or none), so the next run sees it as outstanding for that
 * locale. Locales outside `to` pass through untouched.
 */
export function buildUpdatedHashes(
  previous: LocaleHashes,
  to: string[],
  currentHashes: HashStore,
  outstanding: (locale: string, key: string) => boolean,
): LocaleHashes {
  const updated: LocaleHashes = { ...previous };
  for (const locale of to) {
    const before = localeStore(previous, locale) ?? {};
    const store: HashStore = {};
    for (const [key, hash] of Object.entries(currentHashes)) {
      if (!outstanding(locale, key)) store[key] = hash;
      else if (Object.hasOwn(before, key)) store[key] = before[key];
    }
    updated[locale] = store;
  }
  return updated;
}
