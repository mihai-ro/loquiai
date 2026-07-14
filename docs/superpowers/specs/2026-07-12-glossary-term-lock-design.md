# Glossary / Term-Lock — Design

**Date:** 2026-07-12
**Status:** Approved, pre-implementation
**Topic:** Terminology glossary (term-lock) + rename of existing content-hash translation memory

## Problem

Loqui translates i18n JSON in independent chunks (`chunkTranslations`, `translator.ts:151`).
Each chunk is a separate LLM request that cannot see sibling chunks. When related keys land
in different chunks, terminology drifts: the same source term ("Dashboard") may be translated
inconsistently across the file. There is also no way to force brand/product names to survive
verbatim.

A **terminology glossary** solves both:
- **term-lock** — a source term always maps to a chosen target translation per locale.
- **do-not-translate** — listed strings are emitted verbatim in every locale.

## Naming collision (must resolve first)

Loqui already ships a symbol named `glossary`, but it is **translation memory**, not a
terminology glossary:

- `src/glossary.ts` — keyed by **hash of the full source string** → per-locale translations.
  A cache to skip re-translating unchanged strings (`lookupGlossary` / `updateGlossary`).
- CLI `--glossary` / `--glossary-file` (`index.ts:28`), help text: *"Enable translation memory."*
- `translator.ts:141` — "served from glossary" = cache hit.

The two concepts are orthogonal (whole-string cache vs. per-term enforcement) but share a name.

**Decision:** rename the existing content-hash cache to **`translationMemory`**, freeing the
name **`glossary`** for the new term-lock feature. Low real-world usage (2 stars, feature
effectively unused) makes the breaking rename acceptable; document it in CHANGELOG + README.

## Part A — Rename: `glossary` (cache) → `translationMemory`

Pure rename, no behavior change.

- `src/glossary.ts` → `src/translation-memory.ts`
  - `Glossary` type → `TranslationMemory`
  - `loadGlossary` → `loadTranslationMemory`
  - `saveGlossary` → `saveTranslationMemory`
  - `lookupGlossary` → `lookupTranslationMemory`
  - `updateGlossary` → `updateTranslationMemory`
- `src/translator.ts` — rename `glossary*` locals/fields, `updatedGlossary` → `updatedTranslationMemory`,
  log string "served from glossary" → "served from translation memory".
- `src/lib.ts` — `glossary`/`glossaryFile` options → `translationMemory`/`translationMemoryFile`;
  sidecar suffix `.loqui-glossary.json` → `.loqui-tm.json`.
- `src/index.ts` — CLI `--glossary` → `--translation-memory`, `--glossary-file` →
  `--translation-memory-file`; help text updated.
- `loqui.schema.json` — rename the corresponding property.
- `CHANGELOG.md` + `README.md` — breaking-change note with migration (rename flags + sidecar file).
- Rename `src/glossary.test.ts` → `src/translation-memory.test.ts`; update imports/names.

## Part B — New `glossary` (term-lock)

### Config

```jsonc
{
  "glossary": {
    "path": "glossary.json",            // optional — file OR folder; stat decides shape
    "noTranslate": ["Loqui", "GitHub"]  // optional — verbatim in every locale
  }
}
```

`glossary`, `path`, and `noTranslate` are all optional. `noTranslate` works independently of
`path` (do-not-translate needs no term files).

### Source resolution (per run)

Stat `glossary.path`:

1. **Directory** → per-locale files `{path}/{locale}.json`, shape `{ "<term>": "<target>" }`.
   Mirrors the i18n locale-file layout.
   ```json
   // glossary/es.json
   { "Dashboard": "Tablero" }
   ```
2. **File** (e.g. `./glossary.json`) → single combined file, all locales in one, shape
   `{ "<term>": { "<locale>": "<target>" } }`.
   ```json
   { "Dashboard": { "es": "Tablero", "fr": "Tableau de bord" } }
   ```
3. **`path` unset / points nowhere** → fallback: a top-level `glossary` key **inside the source
   file** (e.g. `en.json`), **same combined shape as (2)**. It is stripped from the source before
   translation and never emitted to any output.
4. **None of the above** → no glossary; skip term-lock (but still honor `noTranslate`).

Property: single-file (2) and inline-fallback (3) share one shape → one parser. Folder (1) is the
per-locale parser. Two loaders total. Both normalize to one in-memory model:

```ts
interface GlossaryModel {
  terms: Record<string, Record<string, string>>; // term -> { locale -> target }
  noTranslate: string[];
}
```

### Enforcement (hybrid)

Per chunk, per locale:

- **`noTranslate` terms → hard mask/restore.** Same sentinel mechanism as `placeholder.ts`
  (`⟦n⟧`). Masked before the request, restored verbatim after. Guarantees the exact string.
  Implemented by extending `maskChunk` (`translator.ts:376`) with a term-mask pass that runs
  **before** placeholder masking. Matching: case-insensitive, word-boundary, longest-term-first
  (so "GitHub" wins over "Git").
- **Glossary terms → prompt-inject + post-verify.**
  - **Inject:** append the applicable `source → target` pairs to the system prompt
    (`buildSystemPrompt`, `base.engine.ts:88`) so the model can inflect the term naturally in
    context. Only terms present in the chunk's source values are injected (keeps prompt small).
  - **Verify:** after `restoreChunk`, for each key check the target contains the locked term
    (case-insensitive). On miss → `logger.warn` + push to `stats.warnings` + skip the key so it
    retries next run. Mirrors the existing missing-placeholder check (`translator.ts:343`).

### Matching rules

- Case-insensitive (both mask and verify).
- Word-boundary match to avoid substring clobbering.
- Longest term first when multiple terms overlap.

## Files touched

| File | Change |
|------|--------|
| `src/translation-memory.ts` | renamed from `glossary.ts` (Part A) |
| `src/glossary.ts` | **new** — resolve (folder/file/inline), normalize to `GlossaryModel`, term-mask helpers, prompt-block builder, verify helper |
| `src/types.ts` | `TranslationMemory` (renamed), new `GlossaryConfig` + `GlossaryModel`, `glossary?` on `LoquiConfig` |
| `src/translator.ts` | Part A renames; wire `noTranslate` masking into `maskChunk`, glossary verify into `processChunk`, load/resolve glossary in `translateJson` |
| `src/engines/base.engine.ts` | inject glossary term block into `buildSystemPrompt` |
| `src/lib.ts` | Part A option renames; load glossary config, strip inline fallback key from source |
| `src/index.ts` | Part A flag renames; help text |
| `loqui.schema.json` | rename TM property; add `glossary` object schema |
| `CHANGELOG.md`, `README.md` | breaking rename note; new glossary docs |
| tests | rename TM test; new `glossary.test.ts`; extend `translator.test.ts` |

## Testing

- **Resolution:** folder → per-locale load; file → combined load; inline fallback load + source
  strip (key never emitted); unset/missing → skip; both loaders normalize to same model.
- **noTranslate:** mask→restore verbatim; case-insensitive; word-boundary; longest-first;
  interaction with placeholder masking (order correct, no sentinel collision).
- **Glossary enforce:** prompt injection includes only in-chunk terms; verify pass (term present)
  saves; verify miss warns + skips + retries; case-insensitive verify.
- **Orthogonality:** glossary + translationMemory both active in one run behave independently.

## Out of scope (YAGNI)

Per-term options/notes, CAT/TBX array format, glossary auto-extraction, fuzzy matching,
multi-word morphology validation beyond presence check.
