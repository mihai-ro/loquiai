import fs from 'node:fs';
import path from 'node:path';
import type { HashStore, LocaleHashes } from './types.js';
import { readJson, writeJson } from './utils/json.js';

/** What the sidecar file holds: the hashes per locale, and which input wrote which keys. */
export interface Sidecar {
  locales: LocaleHashes;
  /** Owner id → the flat keys that input's source had when it last saved. Empty for a v2 sidecar. */
  owners: Record<string, string[]>;
  /**
   * The flat map a v2 sidecar held, kept so a locale that has no hashes of its own yet can
   * still be compared against it, whichever run converted the file.
   */
  v2?: HashStore;
}

/**
 * Reads the sidecar. A v2 sidecar is a single flat store (its values are strings): it
 * never said which locale a hash was for, so it is kept as `v2` and every locale in `to`
 * without a store of its own inherits a copy. Top-level keys starting with `$` are
 * reserved for the file's own bookkeeping and never read as a locale.
 */
export function readSidecar(hashFile: string, to: string[]): Sidecar {
  const raw = readJson(hashFile) as Record<string, unknown>;
  const isV2 = Object.values(raw).some((value) => typeof value === 'string');
  const v2 = isV2 ? (raw as HashStore) : readV2(raw.$v2);
  const locales = isV2
    ? {}
    : (Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('$'))) as LocaleHashes);
  if (v2) {
    for (const locale of to) if (!Object.hasOwn(locales, locale)) locales[locale] = { ...v2 };
  }
  return { locales, owners: isV2 ? {} : readOwners(raw.$owners), v2 };
}

function readV2(value: unknown): HashStore | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, hash]) => typeof hash === 'string')) as HashStore;
}

function readOwners(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([id, keys]) => [
      id,
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [],
    ]),
  );
}

/** The hashes per locale alone, for a reader that has no use for who wrote them. */
export function loadHashStore(hashFile: string, to: string[]): LocaleHashes {
  return readSidecar(hashFile, to).locales;
}

export function saveSidecar(hashFile: string, sidecar: Sidecar): void {
  fs.mkdirSync(path.dirname(hashFile), { recursive: true });
  writeJson(hashFile, {
    ...sidecar.locales,
    $owners: sidecar.owners,
    ...(sidecar.v2 && { $v2: sidecar.v2 }),
  });
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
