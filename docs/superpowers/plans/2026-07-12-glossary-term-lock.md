# Glossary / Term-Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a terminology glossary (term-lock + do-not-translate) to Loqui, and rename the existing content-hash "glossary" (which is actually translation memory) to `translationMemory` to free the name.

**Architecture:** Two orthogonal parts. Part A is a pure rename of the existing content-hash cache. Part B adds a new `glossary` config attribute resolved from a per-locale folder, a combined file, or an inline source key; enforcement is hybrid — `noTranslate` terms are hard-masked like placeholders, glossary terms are prompt-injected then post-verified. File I/O lives in `lib.ts`; `translator.ts` stays fs-free and receives a resolved `GlossaryModel`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, Biome, node:test / the project's existing test runner (`*.test.ts`), pnpm.

## Global Constraints

- **Commits:** The user has NOT authorized commits. Treat every "Commit" step as gated: stage files and prepare the message, but run `git commit` only after the user explicitly authorizes. Never add `Co-Authored-By: Claude` trailers.
- **Imports:** ESM with explicit `.js` specifiers (e.g. `import { x } from './glossary.js'`). Match existing style.
- **Types:** strict TypeScript, no `any`, prefer `interface` for object shapes, union types over enums.
- **Rename is breaking:** documented in CHANGELOG + README. No compatibility shim/alias for the old `--glossary` flag (per repo convention: migrate callers, no shims).
- **Naming (verbatim):** new config attribute = `glossary`; renamed cache = `translationMemory`; new CLI flags = `--translation-memory`, `--translation-memory-file`; TM sidecar suffix = `.loqui-tm.json`.
- **Config defaults:** `glossary` is optional and defaults to unset (feature off). Do not add it to `CONFIG_DEFAULTS`.
- Run the full test suite with the project's script (check `package.json` — likely `pnpm test`) before each commit.

---

## File Structure

- `src/translation-memory.ts` — renamed from `src/glossary.ts` (content-hash cache; unchanged behavior).
- `src/glossary.ts` — **new**: `GlossaryModel` resolution (folder/file/inline), term matching, `noTranslate` masking, prompt-block builder, term verification. Pure + fs load helper.
- `src/types.ts` — rename `Glossary` → `TranslationMemory`; add `GlossaryConfig`, `GlossaryModel`; add `glossary?` to `LoquiConfig`.
- `src/translator.ts` — Part A renames; consume `GlossaryModel` (mask `noTranslate` in `maskChunk`, verify terms in `processChunk`, inject via engine).
- `src/engines/base.engine.ts` — inject glossary term block into `buildSystemPrompt`.
- `src/lib.ts` — Part A option renames; resolve glossary from fs, strip inline `glossary` key from raw source.
- `src/index.ts` — Part A flag renames + help text.
- `loqui.schema.json` — rename TM property; add `glossary` object.
- `CHANGELOG.md`, `README.md` — breaking rename note; glossary docs.

---

## PART A — Rename cache `glossary` → `translationMemory`

### Task 1: Rename the module and its type

**Files:**
- Rename: `src/glossary.ts` → `src/translation-memory.ts`
- Rename: `src/glossary.test.ts` → `src/translation-memory.test.ts`
- Modify: `src/types.ts` (the `Glossary` type)

**Interfaces:**
- Produces: `loadTranslationMemory(path: string): TranslationMemory`, `saveTranslationMemory(path: string, tm: TranslationMemory): void`, `lookupTranslationMemory(tm: TranslationMemory, hash: string, locales: string[]): Record<string,string> | null`, `updateTranslationMemory(tm: TranslationMemory, hash: string, translations: Record<string,string>): void`. `TranslationMemory` is the type currently named `Glossary`.

- [ ] **Step 1: Move the files with git**

```bash
git mv src/glossary.ts src/translation-memory.ts
git mv src/glossary.test.ts src/translation-memory.test.ts
```

- [ ] **Step 2: Rename symbols in `src/translation-memory.ts`**

Replace `Glossary` → `TranslationMemory`, `loadGlossary` → `loadTranslationMemory`, `saveGlossary` → `saveTranslationMemory`, `lookupGlossary` → `lookupTranslationMemory`, `updateGlossary` → `updateTranslationMemory`. Update the doc comments ("glossary" → "translation memory"). The import `import type { Glossary } from './types.js'` becomes `import type { TranslationMemory } from './types.js'`.

- [ ] **Step 3: Rename the type in `src/types.ts`**

Find the `Glossary` type declaration and rename it to `TranslationMemory` (keep the same shape: `Record<string, Record<string, string>>` or whatever it currently is). Update its doc comment.

- [ ] **Step 4: Update `src/translation-memory.test.ts`**

Update the import path/specifier (already moved) and every symbol reference (`loadGlossary` → `loadTranslationMemory`, etc.). Do not change test assertions — behavior is identical.

- [ ] **Step 5: Run the TM tests, expect PASS**

Run: `pnpm test -- translation-memory` (or the project's file-scoped test command)
Expected: all previously-passing tests PASS. If the runner can't scope, run full `pnpm test` and confirm no new failures beyond the not-yet-updated importers (translator/lib) — those are fixed in Task 2.

- [ ] **Step 6: Commit (gated)**

```bash
git add src/translation-memory.ts src/translation-memory.test.ts src/types.ts
git commit -m "refactor: rename glossary module to translation-memory"
```

### Task 2: Update all importers + CLI + schema + docs

**Files:**
- Modify: `src/translator.ts` (imports + `glossary*` locals/fields)
- Modify: `src/lib.ts` (options + sidecar path)
- Modify: `src/index.ts` (CLI flags + help)
- Modify: `loqui.schema.json`
- Modify: `CHANGELOG.md`, `README.md`

**Interfaces:**
- Consumes: the renamed exports from Task 1.
- Produces: `TranslateJobOptions.translationMemory?: TranslationMemory`, `TranslateJobOptions.translationMemoryPath?: string`, `TranslateJobResult.updatedTranslationMemory`. `LibOptions.translationMemory?: boolean`, `LibOptions.translationMemoryFile?: string`. CLI flags `--translation-memory`, `--translation-memory-file`.

- [ ] **Step 1: Update `src/translator.ts` imports and identifiers**

Change `import { lookupGlossary, updateGlossary } from './glossary.js'` →
`import { lookupTranslationMemory, updateTranslationMemory } from './translation-memory.js'`.
Rename job-option fields `glossary`→`translationMemory`, `glossaryPath`→`translationMemoryPath`, local `glossary`→`translationMemory`, `glossaryCache`→`tmCache`, `sourceHashesForGlossary`→`sourceHashesForTm`, result field `updatedGlossary`→`updatedTranslationMemory`, and calls `lookupGlossary`/`updateGlossary` → `lookupTranslationMemory`/`updateTranslationMemory`. Update the `Glossary` type import → `TranslationMemory`. Change the log string `` `[${namespace}] All ${allKeysNeeded.size} key(s) served from glossary.` `` → `...served from translation memory.`

- [ ] **Step 2: Update the type on `TranslateJobOptions`/`TranslateJobResult` in `src/types.ts` (or `translator.ts` where declared)**

Locate where `glossary?: Glossary` / `glossaryPath?: string` / `updatedGlossary` are declared (see `translator.ts:26-27` region and the result type) and rename per the Interfaces block above.

- [ ] **Step 3: Update `src/lib.ts`**

Change `import { loadGlossary, saveGlossary } from './glossary.js'` →
`import { loadTranslationMemory, saveTranslationMemory } from './translation-memory.js'`.
Rename options `glossary`→`translationMemory`, `glossaryFile`→`translationMemoryFile`; local `useGlossary`→`useTranslationMemory`, `glossaryFilePath`→`tmFilePath`, `glossary`→`translationMemory`, `updatedGlossary`→`updatedTranslationMemory`. Change the default sidecar suffix `` `.${base}.loqui-glossary.json` `` → `` `.${base}.loqui-tm.json` ``. Update the `translateJson` call args (`glossary:` → `translationMemory:`, `glossaryPath:` → `translationMemoryPath:`).

- [ ] **Step 4: Update `src/index.ts` CLI**

Rename flags `--glossary` → `--translation-memory` and `--glossary-file` → `--translation-memory-file` in the flag list, the parsed args object (`glossaryFile`→`translationMemoryFile`, `glossary`→`translationMemory`), the help text (`--glossary` line → `--translation-memory   Enable translation memory (content-hash cache sidecar)`; `--glossary-file` line updated), and the `runTranslate` options object.

- [ ] **Step 5: Update `loqui.schema.json`**

There is no `glossary` property in the schema today (it's CLI/lib-only), so confirm with `grep -n glossary loqui.schema.json`. If a property exists, rename it to `translationMemory`. If none exists, no change here — note it in the commit body.

- [ ] **Step 6: Run full test suite, expect PASS**

Run: `pnpm test`
Expected: all PASS (all importers now reference the renamed module).

- [ ] **Step 7: Update CHANGELOG + README**

`CHANGELOG.md`: add a `### BREAKING` entry: "Renamed the content-hash translation cache from `glossary` to `translationMemory`. CLI: `--glossary` → `--translation-memory`, `--glossary-file` → `--translation-memory-file`. Sidecar file renamed `*.loqui-glossary.json` → `*.loqui-tm.json` (rename existing files to keep the cache). The name `glossary` now refers to the new terminology glossary feature."
`README.md`: update any `--glossary` references to `--translation-memory`.

- [ ] **Step 8: Commit (gated)**

```bash
git add src/translator.ts src/lib.ts src/index.ts src/types.ts loqui.schema.json CHANGELOG.md README.md
git commit -m "refactor: rename glossary CLI/options to translationMemory (BREAKING)"
```

---

## PART B — New `glossary` (term-lock)

### Task 3: Glossary types

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GlossaryConfig {
    path?: string;
    noTranslate?: string[];
  }
  export interface GlossaryModel {
    terms: Record<string, Record<string, string>>; // term -> { locale -> target }
    noTranslate: string[];
  }
  ```
  and `glossary?: GlossaryConfig` added to `LoquiConfig`.

- [ ] **Step 1: Add the interfaces to `src/types.ts`**

```ts
/** Terminology glossary configuration. All fields optional; absence disables the feature. */
export interface GlossaryConfig {
  /** File OR folder. Folder = per-locale term files `{path}/{locale}.json` ({ term: target }).
   *  File = combined `{ term: { locale: target } }`. Unset = fall back to an inline `glossary`
   *  key in the source file. */
  path?: string;
  /** Strings emitted verbatim in every locale (brand/product names). */
  noTranslate?: string[];
}

/** Normalized in-memory glossary used during a run. */
export interface GlossaryModel {
  /** term -> { locale -> locked target translation } */
  terms: Record<string, Record<string, string>>;
  noTranslate: string[];
}
```

- [ ] **Step 2: Add `glossary` to `LoquiConfig`**

In the `LoquiConfig` interface (`src/types.ts:19`), after `placeholderPatterns`, add:

```ts
  /** Terminology glossary: lock specific term translations and mark do-not-translate strings. */
  glossary?: GlossaryConfig;
```

- [ ] **Step 3: Typecheck, expect PASS**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors (types only; nothing consumes them yet).

- [ ] **Step 4: Commit (gated)**

```bash
git add src/types.ts
git commit -m "feat: add GlossaryConfig and GlossaryModel types"
```

### Task 4: Glossary matching + masking helpers (pure)

**Files:**
- Create: `src/glossary.ts`
- Test: `src/glossary.test.ts`

**Interfaces:**
- Consumes: `GlossaryModel` from Task 3; sentinel scheme compatible with `placeholder.ts` (`⟦n⟧`).
- Produces:
  ```ts
  export function findTermsInText(text: string, terms: string[]): string[]; // matched terms, longest-first, word-boundary, case-insensitive
  export function maskTerms(input: string, terms: string[], startCounter: number):
    { masked: string; map: Record<string, string>; nextCounter: number };
  ```

- [ ] **Step 1: Write failing tests in `src/glossary.test.ts`**

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findTermsInText, maskTerms } from './glossary.js';

describe('findTermsInText', () => {
  it('matches whole words case-insensitively', () => {
    assert.deepEqual(findTermsInText('Open the dashboard now', ['Dashboard']), ['Dashboard']);
  });
  it('does not match substrings', () => {
    assert.deepEqual(findTermsInText('Githubbing around', ['Git']), []);
  });
  it('returns longest term first when terms overlap', () => {
    assert.deepEqual(findTermsInText('Use GitHub today', ['Git', 'GitHub']), ['GitHub']);
  });
});

describe('maskTerms', () => {
  it('masks matched terms with T-sentinels and returns a restore map', () => {
    const { masked, map, nextCounter } = maskTerms('Open GitHub please', ['GitHub'], 0);
    assert.equal(masked, 'Open ⟦T0⟧ please');
    assert.deepEqual(map, { '⟦T0⟧': 'GitHub' });
    assert.equal(nextCounter, 1);
  });
  it('preserves the original casing of the matched occurrence', () => {
    const { map } = maskTerms('open github', ['GitHub'], 0);
    assert.deepEqual(map, { '⟦T0⟧': 'github' });
  });
  it('is a no-op when no terms match', () => {
    const { masked, nextCounter } = maskTerms('nothing here', ['GitHub'], 3);
    assert.equal(masked, 'nothing here');
    assert.equal(nextCounter, 3);
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `pnpm test -- glossary`
Expected: FAIL — `findTermsInText`/`maskTerms` not exported.

- [ ] **Step 3: Implement the helpers in `src/glossary.ts`**

```ts
const MASK_PREFIX = '⟦';
const MASK_SUFFIX = '⟧';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a case-insensitive, word-boundary regex for a term. */
function termRegex(term: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
}

/** Terms actually present in `text`, longest-first (so overlaps resolve to the longer term). */
export function findTermsInText(text: string, terms: string[]): string[] {
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  return ordered.filter((term) => termRegex(term).test(text));
}

/**
 * Mask do-not-translate terms with placeholder-compatible sentinels (`⟦n⟧`).
 * Longest-first prevents a shorter term from masking inside a longer one.
 * The restore map preserves the matched occurrence's original casing.
 */
export function maskTerms(
  input: string,
  terms: string[],
  startCounter: number,
): { masked: string; map: Record<string, string>; nextCounter: number } {
  const map: Record<string, string> = {};
  let counter = startCounter;
  let result = input;
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  for (const term of ordered) {
    result = result.replace(termRegex(term), (match) => {
      // 'T'-prefixed range keeps these sentinels disjoint from maskPlaceholders' `⟦n⟧`.
      const key = `${MASK_PREFIX}T${counter++}${MASK_SUFFIX}`;
      map[key] = match;
      return key;
    });
  }
  return { masked: result, map, nextCounter: counter };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test -- glossary`
Expected: PASS.

- [ ] **Step 5: Commit (gated)**

```bash
git add src/glossary.ts src/glossary.test.ts
git commit -m "feat: add glossary term matching and masking helpers"
```

### Task 5: Glossary loading + model resolution (fs)

**Files:**
- Modify: `src/glossary.ts`
- Modify: `src/glossary.test.ts`

**Interfaces:**
- Consumes: `GlossaryModel`, `GlossaryConfig` (Task 3); `readJson` from `./utils/json.js` (used by translation-memory.ts).
- Produces:
  ```ts
  export function loadGlossaryTerms(glossaryPath: string, locales: string[], baseDir: string): Record<string, Record<string, string>>;
  export function buildGlossaryModel(
    config: GlossaryConfig | undefined,
    inlineTerms: Record<string, Record<string, string>> | undefined,
    locales: string[],
    baseDir: string,
  ): GlossaryModel | null; // null when nothing is configured
  ```

- [ ] **Step 1: Write failing tests (use a temp dir)**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGlossaryModel, loadGlossaryTerms } from './glossary.js';

describe('loadGlossaryTerms', () => {
  it('loads per-locale files from a folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-'));
    fs.mkdirSync(path.join(dir, 'glossary'));
    fs.writeFileSync(path.join(dir, 'glossary/es.json'), JSON.stringify({ Dashboard: 'Tablero' }));
    fs.writeFileSync(path.join(dir, 'glossary/fr.json'), JSON.stringify({ Dashboard: 'Tableau de bord' }));
    const terms = loadGlossaryTerms('glossary', ['es', 'fr'], dir);
    assert.deepEqual(terms, { Dashboard: { es: 'Tablero', fr: 'Tableau de bord' } });
  });
  it('loads a combined single file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-'));
    fs.writeFileSync(path.join(dir, 'g.json'), JSON.stringify({ Dashboard: { es: 'Tablero' } }));
    const terms = loadGlossaryTerms('g.json', ['es'], dir);
    assert.deepEqual(terms, { Dashboard: { es: 'Tablero' } });
  });
});

describe('buildGlossaryModel', () => {
  it('returns null when nothing is configured', () => {
    assert.equal(buildGlossaryModel(undefined, undefined, ['es'], '/tmp'), null);
  });
  it('uses inline terms when path is unset', () => {
    const model = buildGlossaryModel({ noTranslate: ['Loqui'] }, { Dashboard: { es: 'Tablero' } }, ['es'], '/tmp');
    assert.deepEqual(model, { terms: { Dashboard: { es: 'Tablero' } }, noTranslate: ['Loqui'] });
  });
  it('returns a model with only noTranslate when no terms exist', () => {
    const model = buildGlossaryModel({ noTranslate: ['Loqui'] }, undefined, ['es'], '/tmp');
    assert.deepEqual(model, { terms: {}, noTranslate: ['Loqui'] });
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `pnpm test -- glossary`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement loaders in `src/glossary.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { GlossaryConfig, GlossaryModel } from './types.js';
import { readJson } from './utils/json.js';

/**
 * Load glossary terms from a path relative to `baseDir`.
 * Directory  -> per-locale files `{path}/{locale}.json`, each `{ term: target }`.
 * File       -> combined `{ term: { locale: target } }`.
 * Missing    -> `{}` (caller decides fallback).
 */
export function loadGlossaryTerms(
  glossaryPath: string,
  locales: string[],
  baseDir: string,
): Record<string, Record<string, string>> {
  const abs = path.resolve(baseDir, glossaryPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return {};
  }

  if (stat.isDirectory()) {
    const terms: Record<string, Record<string, string>> = {};
    for (const locale of locales) {
      const file = path.join(abs, `${locale}.json`);
      if (!fs.existsSync(file)) continue;
      const map = readJson(file) as Record<string, string>;
      for (const [term, target] of Object.entries(map)) {
        (terms[term] ??= {})[locale] = target;
      }
    }
    return terms;
  }

  return (readJson(abs) as Record<string, Record<string, string>>) ?? {};
}

/**
 * Resolve the effective glossary for a run.
 * Precedence: config.path (folder/file) > inlineTerms > none.
 * Returns null only when there is neither term data nor a noTranslate list.
 */
export function buildGlossaryModel(
  config: GlossaryConfig | undefined,
  inlineTerms: Record<string, Record<string, string>> | undefined,
  locales: string[],
  baseDir: string,
): GlossaryModel | null {
  if (!config) return null;

  const terms = config.path ? loadGlossaryTerms(config.path, locales, baseDir) : (inlineTerms ?? {});
  const noTranslate = config.noTranslate ?? [];

  if (Object.keys(terms).length === 0 && noTranslate.length === 0) return null;
  return { terms, noTranslate };
}
```

Note: `??=` and the `readJson` import must match the existing util signature — verify `readJson` returns the parsed object (see its use in `translation-memory.ts`).

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test -- glossary`
Expected: PASS.

- [ ] **Step 5: Commit (gated)**

```bash
git add src/glossary.ts src/glossary.test.ts
git commit -m "feat: resolve glossary model from folder, file, or inline source"
```

### Task 6: Prompt-block builder + engine injection

**Files:**
- Modify: `src/glossary.ts` (+ test)
- Modify: `src/engines/base.engine.ts`
- Modify: `src/engines/base.engine.test.ts`

**Interfaces:**
- Consumes: `GlossaryModel.terms`, `findTermsInText` (Task 4).
- Produces:
  ```ts
  export function buildGlossaryPromptBlock(
    terms: Record<string, Record<string, string>>,
    chunkText: string,
    targetLocales: string[],
  ): string; // '' when no terms apply
  ```
  `BaseEngine` gains a protected `glossaryPromptBlock` field set via a new public method `setGlossaryBlock(block: string): void`, appended inside `buildSystemPrompt`.

- [ ] **Step 1: Write failing test for the prompt block in `src/glossary.test.ts`**

```ts
import { buildGlossaryPromptBlock } from './glossary.js';

describe('buildGlossaryPromptBlock', () => {
  it('lists only terms present in the chunk text', () => {
    const terms = { Dashboard: { es: 'Tablero' }, Commit: { es: 'Confirmación' } };
    const block = buildGlossaryPromptBlock(terms, 'Open the Dashboard', ['es']);
    assert.match(block, /Dashboard/);
    assert.match(block, /Tablero/);
    assert.doesNotMatch(block, /Commit/);
  });
  it('returns empty string when no terms apply', () => {
    assert.equal(buildGlossaryPromptBlock({ Dashboard: { es: 'Tablero' } }, 'nothing', ['es']), '');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test -- glossary`
Expected: FAIL — `buildGlossaryPromptBlock` not exported.

- [ ] **Step 3: Implement `buildGlossaryPromptBlock` in `src/glossary.ts`**

```ts
/**
 * Build a system-prompt fragment instructing the model to use locked term translations.
 * Only includes terms that appear in `chunkText`, keeping the prompt small.
 */
export function buildGlossaryPromptBlock(
  terms: Record<string, Record<string, string>>,
  chunkText: string,
  targetLocales: string[],
): string {
  const present = findTermsInText(chunkText, Object.keys(terms));
  if (present.length === 0) return '';

  const lines: string[] = ['Use these exact term translations (glossary):'];
  for (const term of present) {
    const perLocale = targetLocales
      .filter((l) => terms[term][l])
      .map((l) => `${l}: ${terms[term][l]}`)
      .join(', ');
    if (perLocale) lines.push(`- "${term}" -> ${perLocale}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm test -- glossary`
Expected: PASS.

- [ ] **Step 5: Write failing test for engine injection in `src/engines/base.engine.test.ts`**

Follow the existing pattern in that file for constructing a concrete engine. Add:

```ts
it('appends the glossary block to the system prompt', () => {
  const engine = makeTestEngine(); // use the file's existing helper/subclass
  engine.setGlossaryBlock('Use these exact term translations (glossary):\n- "Dashboard" -> es: Tablero');
  // buildSystemPrompt is protected; expose via the same mechanism the file already uses,
  // or assert through a public method that calls it. If the test file already reaches
  // protected members via a subclass, reuse that subclass.
  const prompt = engine.buildSystemPromptForTest(['es'], 'en', 'app');
  assert.match(prompt, /Dashboard.*Tablero/s);
});
```

If `base.engine.test.ts` has no protected-access harness, add a minimal test subclass exposing `buildSystemPromptForTest = (...a) => this.buildSystemPrompt(...a)` within the test file only.

- [ ] **Step 6: Run test, expect FAIL**

Run: `pnpm test -- base.engine`
Expected: FAIL — `setGlossaryBlock` undefined.

- [ ] **Step 7: Implement injection in `src/engines/base.engine.ts`**

Add field + setter near the other protected members:

```ts
  #glossaryBlock = '';

  /** Set by the translator per run; appended to every system prompt. */
  setGlossaryBlock(block: string): void {
    this.#glossaryBlock = block;
  }
```

In `buildSystemPrompt`, append the block to the returned string in BOTH branches (custom-template and default). For the default branch, add `this.#glossaryBlock` as a final array element before `.join('\n')`, guarded so empty strings don't add a blank line:

```ts
    const parts = [
      domainContext,
      `Translating "${namespace}" from "${sourceLocale}" to: ${localeList}.`,
      'Respond ONLY with valid JSON. Top-level keys must be the locale codes.',
      'Keep placeholders like {{token}} unchanged.',
      'Translate text only. Preserve capitalization style.',
    ];
    if (this.#glossaryBlock) parts.push(this.#glossaryBlock);
    return parts.join('\n');
```

For the custom-template branch, append: `return this.#glossaryBlock ? `${rendered}\n${this.#glossaryBlock}` : rendered;` (capture the interpolated result in `rendered` first).

Note: the block is chunk-independent at set-time here (whole-glossary). To keep it chunk-scoped, Task 7 sets it per chunk right before the engine call — acceptable because chunks run through the pool but each `processChunk` sets the block immediately before its own `translateChunk`. **Concurrency caveat:** with `concurrency > 1` a shared engine instance means one chunk could overwrite another's block. Resolve by passing the block as a `translateChunk` argument instead of engine state — see Step 8.

- [ ] **Step 8: Make the block a per-call argument (concurrency-safe)**

Change `translateChunk` and `reviewChunk` in `base.engine.ts` to accept an optional `glossaryBlock: string` param and thread it into `buildSystemPrompt` locally (not via shared field). Update the abstract `makeCall` chain to receive the already-built system prompt (it already does — `translateChunk` builds the prompt and passes it down). Concretely:

```ts
  translateChunk(
    chunk: TranslationChunk,
    targetLocales: string[],
    sourceLocale: string,
    namespace: string,
    glossaryBlock = '',
  ): Promise<Record<string, TranslationResult>> {
    const system = this.buildSystemPrompt(targetLocales, sourceLocale, namespace);
    const withGlossary = glossaryBlock ? `${system}\n${glossaryBlock}` : system;
    return this.makeCall(withGlossary, this.buildUserPrompt(chunk, targetLocales, sourceLocale), Object.keys(chunk.keys), targetLocales);
  }
```

Remove the `#glossaryBlock` field/`setGlossaryBlock` added in Step 7 and adjust the Step 5 test to pass the block through `translateChunk` (or a small `buildSystemPromptForTest` that concatenates). Do the same for `reviewChunk`.

- [ ] **Step 9: Run tests, expect PASS**

Run: `pnpm test -- base.engine glossary`
Expected: PASS.

- [ ] **Step 10: Commit (gated)**

```bash
git add src/glossary.ts src/glossary.test.ts src/engines/base.engine.ts src/engines/base.engine.test.ts
git commit -m "feat: inject glossary term block into engine system prompt"
```

### Task 7: Wire masking + verification into the translator

**Files:**
- Modify: `src/translator.ts`
- Modify: `src/translator.test.ts`

**Interfaces:**
- Consumes: `GlossaryModel` (via new `TranslateJobOptions.glossaryModel?`), `maskTerms`, `buildGlossaryPromptBlock`, `findTermsInText` (Tasks 4/6).
- Produces: `TranslateJobOptions.glossaryModel?: GlossaryModel`; `processChunk` masks `noTranslate`, injects the glossary block, verifies locked terms.

- [ ] **Step 1: Add `glossaryModel` to job options and thread into `processChunk`**

In `src/types.ts` (or wherever `TranslateJobOptions` lives), add `glossaryModel?: GlossaryModel;`. In `translateJson`, destructure it and pass into the `processChunk` opts object; add it to `ProcessChunkOptions`.

- [ ] **Step 2: Write a failing test for noTranslate masking in `src/translator.test.ts`**

Follow the existing `processChunk`/`translateJson` test setup (mock engine via `_setFetch` or the engine injection the test file already uses). Add:

```ts
it('keeps noTranslate terms verbatim in the output', async () => {
  // engine echoes source unchanged for each locale (use existing mock helper)
  const result = await runJobWithMockEngine({
    sourceFlat: { greeting: 'Welcome to Loqui' },
    to: ['es'],
    glossaryModel: { terms: {}, noTranslate: ['Loqui'] },
    echo: true,
  });
  assert.equal(result.translations.es.greeting.includes('Loqui'), true);
});
```

If the file lacks `runJobWithMockEngine`, replicate the mock-engine construction already used by nearby tests (they inject a fake `makeCall`/fetch). The key assertion: the sentinel that masked `Loqui` is restored to `Loqui`.

- [ ] **Step 3: Run test, expect FAIL**

Run: `pnpm test -- translator`
Expected: FAIL — `glossaryModel` unused / term not masked (or type error if option missing).

- [ ] **Step 4: Extend `maskChunk` to mask noTranslate terms first**

Change `maskChunk` (`translator.ts:376`) to accept the `noTranslate` list and mask those terms BEFORE placeholder masking, sharing one counter so sentinels don't collide:

```ts
function maskChunk(
  chunk: TranslationChunk,
  customPatterns?: string[],
  noTranslate: string[] = [],
): { maskedChunk: TranslationChunk; maskMaps: Record<string, Record<string, string>> } {
  const maskedKeys: FlatTranslations = {};
  const maskMaps: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(chunk.keys)) {
    // 1) mask do-not-translate terms with sentinels starting at 0
    const termMask = maskTerms(value, noTranslate, 0);
    // 2) mask placeholders on the already-term-masked string; continue the counter
    const { masked, map } = maskPlaceholders(termMask.masked, customPatterns);
    maskedKeys[key] = masked;
    maskMaps[key] = { ...termMask.map, ...map };
  }
  return { maskedChunk: { keys: maskedKeys }, maskMaps };
}
```

Important: `maskPlaceholders` starts its own counter at 0 and emits `⟦0⟧`, `⟦1⟧`… Term sentinels are already disjoint because Task 4's `maskTerms` emits the `⟦T0⟧`, `⟦T1⟧`… range. The merged `maskMaps[key]` (`{ ...termMask.map, ...map }`) contains both; `restoreChunk` restores from that merged map, so `restorePlaceholders` (splits on exact keys) restores both without collision. No further change needed here.

- [ ] **Step 5: Import helpers and pass noTranslate in `processChunk`**

At the top of `translator.ts` add: `import { buildGlossaryPromptBlock, maskTerms } from './glossary.js';` (and `findTermsInText` if needed for verify). In `processChunk`, replace the `maskChunk(chunk, config.placeholderPatterns)` call with `maskChunk(chunk, config.placeholderPatterns, opts.glossaryModel?.noTranslate ?? [])`.

- [ ] **Step 6: Build + pass the glossary prompt block per chunk**

In `processChunk`, before `engine.translateChunk`, compute the block from the chunk's combined source text:

```ts
  const chunkText = Object.values(chunk.keys).join('\n');
  const glossaryBlock = opts.glossaryModel
    ? buildGlossaryPromptBlock(opts.glossaryModel.terms, chunkText, activeLocales)
    : '';
  let results = await engine.translateChunk(maskedChunk, activeLocales, from, namespace, glossaryBlock);
  // and for review:
  results = await engine.reviewChunk(maskedChunk, results, activeLocales, from, namespace, glossaryBlock);
```

- [ ] **Step 7: Add glossary verification after restore**

In `processChunk`, inside the per-key loop AFTER the missing-placeholder check (`translator.ts:348`), add a locked-term presence check:

```ts
      // Glossary term-lock: the locked target term must appear in the translation.
      if (opts.glossaryModel) {
        const sourceTerms = findTermsInText(sourceFlat[key] ?? '', Object.keys(opts.glossaryModel.terms));
        const missingTerms = sourceTerms.filter((term) => {
          const locked = opts.glossaryModel!.terms[term]?.[locale];
          return locked && !value.toLowerCase().includes(locked.toLowerCase());
        });
        if (missingTerms.length > 0) {
          const w = `[${namespace}→${locale}] Key "${key}" missing glossary term(s): ${missingTerms.join(', ')} — skipped, will retry on next run`;
          logger.warn(w);
          stats.warnings.push(w);
          continue;
        }
      }
```

- [ ] **Step 8: Write a failing test for verify miss+skip, then confirm all pass**

```ts
it('skips a key whose translation drops a locked glossary term', async () => {
  const result = await runJobWithMockEngine({
    sourceFlat: { title: 'Dashboard overview' },
    to: ['es'],
    // engine returns a translation WITHOUT the locked term:
    mockResponse: { es: { title: 'Resumen general' } },
    glossaryModel: { terms: { Dashboard: { es: 'Tablero' } }, noTranslate: [] },
  });
  // key skipped -> not present in output (retries next run)
  assert.equal(result.translations.es.title, undefined);
});
```

- [ ] **Step 9: Run tests, expect PASS**

Run: `pnpm test -- translator glossary base.engine`
Expected: PASS.

- [ ] **Step 10: Commit (gated)**

```bash
git add src/translator.ts src/translator.test.ts src/glossary.ts src/glossary.test.ts src/engines/base.engine.ts
git commit -m "feat: enforce glossary via noTranslate masking and term verification"
```

### Task 8: Resolve glossary in lib + strip inline key

**Files:**
- Modify: `src/lib.ts`
- Modify: `src/lib.test.ts` (or the closest integration test file)

**Interfaces:**
- Consumes: `buildGlossaryModel` (Task 5); `config.glossary` (Task 3); `TranslateJobOptions.glossaryModel` (Task 7).
- Produces: `lib.ts` builds a `GlossaryModel` and passes it to `translateJson`; a top-level `glossary` key in the raw source object is extracted (inline fallback) and removed before flattening.

- [ ] **Step 1: Write a failing test: inline glossary key is stripped and applied**

In `src/lib.test.ts`, following the file's existing end-to-end harness (temp source file + mock engine), add a test where the source JSON contains a top-level `glossary` block and a normal key, `config.glossary` has no `path`, and assert (a) the output does NOT contain a `glossary` key, and (b) the `noTranslate`/term behavior applied. Mirror the existing lib test setup exactly.

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test -- lib`
Expected: FAIL — inline `glossary` key leaks into output / model not built.

- [ ] **Step 3: Extract inline glossary from raw source in `src/lib.ts`**

After reading the raw source object and BEFORE flattening it, add:

```ts
  // Inline glossary fallback: a top-level `glossary` object in the source file.
  // Extract and remove it so it is never translated or emitted.
  let inlineGlossaryTerms: Record<string, Record<string, string>> | undefined;
  if (source && typeof source === 'object' && 'glossary' in source) {
    const raw = (source as Record<string, unknown>).glossary;
    if (raw && typeof raw === 'object') {
      inlineGlossaryTerms = raw as Record<string, Record<string, string>>;
    }
    delete (source as Record<string, unknown>).glossary;
  }
```

Use the actual variable name the file uses for the parsed source object.

- [ ] **Step 4: Build the model and pass it to `translateJson`**

```ts
  const glossaryModel = buildGlossaryModel(
    config.glossary,
    inlineGlossaryTerms,
    to,               // active target locales
    path.dirname(inputPath),
  );
```

Add `glossaryModel: glossaryModel ?? undefined,` to the `translateJson(...)` options object. Add the import: `import { buildGlossaryModel } from './glossary.js';`.

- [ ] **Step 5: Run tests, expect PASS**

Run: `pnpm test -- lib translator glossary`
Expected: PASS.

- [ ] **Step 6: Commit (gated)**

```bash
git add src/lib.ts src/lib.test.ts
git commit -m "feat: resolve glossary config and strip inline source key in lib"
```

### Task 9: Schema + docs

**Files:**
- Modify: `loqui.schema.json`
- Modify: `README.md`, `CHANGELOG.md`
- Modify: `loqui.schema.json` consumers if any (none expected)

**Interfaces:**
- Consumes: final config shape from Tasks 3–8.

- [ ] **Step 1: Add `glossary` to `loqui.schema.json`**

Under `properties`, add:

```json
"glossary": {
  "type": "object",
  "additionalProperties": false,
  "description": "Terminology glossary: lock term translations and mark do-not-translate strings.",
  "properties": {
    "path": {
      "type": "string",
      "description": "File OR folder. Folder = per-locale term files {path}/{locale}.json ({ term: target }). File = combined { term: { locale: target } }. Unset = inline `glossary` key in the source file."
    },
    "noTranslate": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Strings emitted verbatim in every locale."
    }
  }
}
```

- [ ] **Step 2: Validate the schema parses**

Run: `pnpm exec node -e "JSON.parse(require('fs').readFileSync('loqui.schema.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Document in README**

Add a "Glossary (term-lock)" section: the three source forms (folder / file / inline), the `noTranslate` list, and a note that glossary is separate from `translationMemory` (the content-hash cache). Include a minimal example config + folder layout.

- [ ] **Step 4: Finalize CHANGELOG**

Add a `### Added` entry: "Terminology glossary (`glossary` config): lock per-locale term translations (prompt-injected + verified) and `noTranslate` strings kept verbatim. Sources: per-locale folder, combined file, or inline source key."

- [ ] **Step 5: Run the full suite + lint**

Run: `pnpm test && pnpm exec biome check .`
Expected: all PASS / no lint errors.

- [ ] **Step 6: Commit (gated)**

```bash
git add loqui.schema.json README.md CHANGELOG.md
git commit -m "docs: document glossary term-lock and add schema"
```

---

## Self-Review

**Spec coverage:**
- Naming collision / rename → Tasks 1–2. ✓
- `glossary` config attribute (`path`, `noTranslate`) → Task 3. ✓
- Resolution folder/file/inline/none → Tasks 5 (folder/file/none) + 8 (inline strip). ✓
- Enforcement: noTranslate hard-mask → Tasks 4 + 7; glossary prompt-inject → Task 6; verify+retry → Task 7. ✓
- Matching case-insensitive / word-boundary / longest-first → Task 4. ✓
- Schema + docs → Task 9. ✓
- Testing coverage → each task is TDD. ✓

**Placeholder scan:** No TBD/TODO. Test steps that reference the file's "existing mock helper" (translator/lib tests) are unavoidable without reproducing the whole harness here; the executor is instructed to mirror the adjacent tests. Flagged, not vague.

**Type consistency:** `GlossaryModel`/`GlossaryConfig` defined in Task 3, used identically in 5/6/7/8. `maskTerms` returns `{ masked, map, nextCounter }` (Task 4) — Task 7 uses `.masked`/`.map` only. Term sentinels use the `⟦Tn⟧` range (Task 4) — disjoint from `maskPlaceholders`' `⟦n⟧`; verified consistent across Task 4 code/tests and Task 7 Step 4.
