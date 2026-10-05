<p align="center">
  <img src="assets/logo.png" alt="loqui" width="720" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mihairo/loqui"><img src="https://img.shields.io/npm/v/@mihairo/loqui" alt="npm version" /></a>
  <a href="https://github.com/mihai-ro/loquiai/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/mihai-ro/loquiai/ci.yml?label=ci" alt="CI status" /></a>
  <a href="https://github.com/mihai-ro/loquiai/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@mihairo/loqui" alt="License" /></a>
  <a href="https://www.npmjs.com/package/@mihairo/loqui"><img src="https://img.shields.io/npm/dm/@mihairo/loqui" alt="npm downloads" /></a>
</p>

<p align="center">
  i18n translation engine powered by LLMs. Feed it a JSON file, get back translated JSON.<br/>
  No accounts, no dashboards, no lock-in.
</p>

```sh
npx @mihairo/loqui --input en.json --from en --to es,pt,de --output ./i18n/{locale}.json
```

---

## Features

- **Three LLM engines** — Gemini, OpenAI, Anthropic (bring your own API key)
- **Any model** — not locked to a specific version; pass any model string
- **Incremental translation** — only re-translate keys that changed since the last run (recommended)
- **Placeholder protection** — `{{mustache}}`, `${template}`, `{icu}`, ICU plural/select blocks, HTML tags, and custom patterns are never mutated
- **Custom prompts** — override system/user prompt templates with your own
- **Programmatic API** — `import { translate } from '@mihairo/loqui'`
- **CLI** — pipe-friendly: results go to stdout, every diagnostic to stderr
- **Structure-preserving** — arrays, numbers, booleans and `null` survive a round trip untouched; only strings are sent to the model
- **Zero runtime dependencies** — nothing is installed alongside it; the build and test toolchain is dev-only

---

## Installation

```sh
npm install @mihairo/loqui
# or
npm install -g @mihairo/loqui   # for the CLI globally
```

Requires **Node.js ≥ 22.12**.

TypeScript users also need `@types/node` 22 or later installed; the type declarations refer to Node's types.

---

## Quick start

**1. Create a config file interactively:**

```sh
npx @mihairo/loqui init
```

This walks you through choosing an engine, model, source locale, and target locales, then writes `.loqui.json` to your project root.

**2. Set your API key:**

```sh
export GEMINI_API_KEY=your-key-here
# or OPENAI_API_KEY / ANTHROPIC_API_KEY
```

**3. Translate:**

```sh
loqui --input en.json --output ./i18n/{locale}.json --incremental
```

---

## Configuration

All fields are optional. CLI flags always override the config file.

| Field                 | Type                                | Default            | Description                          |
| --------------------- | ----------------------------------- | ------------------ | ------------------------------------ |
| `engine`              | `gemini` \| `openai` \| `anthropic` | `gemini`           | LLM provider                         |
| `model`               | string                              | `gemini-2.5-flash` | Model name (any string)              |
| `from`                | string                              | —                  | Source locale (e.g. `en`)            |
| `to`                  | string[]                            | —                  | Target locales (e.g. `["es","de"]`)  |
| `temperature`         | 0–2                                 | `0.1`              | Sampling temperature                 |
| `topP`                | 0–1                                 | `1`                | Nucleus sampling                     |
| `concurrency`         | 1–32                                | `8`                | Parallel API requests                |
| `splitToken`          | 500–32000                           | `4000`             | Max tokens per chunk                 |
| `context`             | string                              | —                  | Domain context injected into prompts |
| `prompts`             | `{ system?, user? }`                | —                  | Custom prompt templates              |
| `placeholderPatterns` | string[]                            | —                  | Extra regex patterns to protect      |
| `timeout`             | number (ms)                         | `120000`           | Per-request timeout                  |
| `review`              | boolean                             | `false`            | Second review pass (2× API calls)    |

Config file is auto-discovered as `.loqui.json` in the current directory.

---

## CLI

```
loqui init                    Interactive setup — creates .loqui.json in the current directory

loqui [input] [options]

[input] — one of:
  --input <file>         read from a JSON file
  --input '<json>'       pass a JSON string inline
  first positional arg   loqui en.json --from en --to es
  stdin                  cat en.json | loqui --from en --to es

Options:
  --config <path>        Config file or directory (default: .loqui.json in cwd)
  --from <locale>        Source locale — overrides config.from
  --to <locale,...>      Target locale(s), comma-separated — overrides config.to
  --engine <name>        Engine: gemini | openai | anthropic — overrides config.engine
  --model <name>         Model name — overrides config.model
  --context <text>       Domain context injected into prompts — overrides config.context
  --output <path>        Output path. Use {locale} token: ./i18n/{locale}.json
                         Or a plain directory: writes {dir}/{locale}.json
  --namespace <name>     Namespace label injected into translation prompts
  --incremental          Only translate new/changed keys (uses a hash sidecar)
  --hash-file <path>     Hash sidecar path (implies --incremental)
  --translation-memory             Enable translation memory (uses a TM sidecar)
  --translation-memory-file <path> TM sidecar path (implies --translation-memory)
  --dry-run              Preview without calling the API or writing files
  --diff                 Compare source against existing locales, report changes
  --validate             Validate that target locales have the same keys as source
  --force                Re-translate all keys regardless of existing translations
  --help, -h             Show help
```

Options take either form: `--to es,de` or `--to=es,de`. An unknown option is an error,
not a silent no-op — a typo like `--incremetal` exits non-zero rather than quietly
re-translating the whole file at full price. A value flag with no value
(`--output --incremental`) and an extra positional argument are errors too: in
`loqui en.json --to es de`, `de` would be dropped, so loqui exits `11` naming it
instead. Pass several locales as `--to es,de`.

### Exit codes

| Code | Name               | Meaning                                                        |
| ---- | ------------------ | -------------------------------------------------------------- |
| 0    | —                  | Success                                                          |
| 1    | —                  | Unexpected error                                                 |
| 2    | `AUTH`             | Invalid or missing API key                                       |
| 3    | `RATE_LIMIT`       | Rate limit exhausted after retries                               |
| 4    | `TIMEOUT`          | Request timed out                                                |
| 5    | `NETWORK_ERROR`    | Network failure after retries                                    |
| 6    | `INVALID_RESPONSE` | API returned an unexpected response                              |
| 7    | `PARSE_ERROR`      | A response, the input, or a file on disk is not valid JSON       |
| 8    | `CHUNK_FAILED`     | Some chunks failed — see [Partial runs](#partial-runs)           |
| 9    | `INVALID_CONFIG`   | `.loqui.json` is missing required fields or has invalid values   |
| 10   | `TRUNCATED`        | The engine hit its output token limit mid-response               |
| 11   | `INVALID_USAGE`    | Invalid command-line usage                                       |

When every chunk fails the same non-retryable way, that code is reported rather than
`CHUNK_FAILED` — a bad API key exits `2`, so a caller can tell "fix your key" from
"retry later". A refused API key stops the run at once, keeping what already landed.

### Partial runs

If some chunks fail and others succeed:

- With `--output`, loqui **writes the successful output first** and then exits `8`.
- Without it, nothing is printed — stdout is either complete, valid JSON or empty — and
  the run exits `8`. Set an output path to keep a partial result.
- From the API, the rejected error's `result` holds what did translate and
  `result.written` the files saved (see [Errors](#errors)).

The hash sidecar records only the keys that actually landed, so re-running picks up
exactly the gap instead of paying for the whole file again.

### Examples

```sh
# Translate a file, write per-locale files
loqui --input src/i18n/en.json --from en --to es,de --output src/i18n/{locale}.json

# Pipe JSON through stdin, get JSON on stdout
cat en.json | loqui --from en --to ja

# Inline JSON as a positional arg
loqui '{"hello":"Hello"}' --from en --to es

# Incremental — only re-translate changed keys
loqui --input en.json --from en --to es,de --output ./i18n/{locale}.json --incremental

# Dry run — preview without any API calls or file writes
loqui --input en.json --from en --to es --dry-run

# Use a different engine and model
loqui --input en.json --from en --to es --engine anthropic --model claude-opus-4-6
```

---

## Programmatic API

```typescript
import { translate } from "@mihairo/loqui";

const result = await translate({
  input: "./en.json", // file path or raw JSON string
  from: "en",
  to: ["de", "es", "pt"],
  output: "./i18n/{locale}.json",
});

// result.locales: { de: { hello: "Hallo" }, es: { hello: "Hola" }, pt: { ... } }
// result.written: { de: "./i18n/de.json", ... }
```

### `TranslateOptions`

```typescript
interface TranslateOptions {
  input: string; // file path or raw JSON string
  from?: string; // source locale
  to?: string | string[]; // target locale(s)
  output?: string | Record<string, string>; // {locale} template, dir, or locale→path map
  namespace?: string; // label injected into prompts
  incremental?: boolean; // hash-based change detection
  hashFile?: string; // custom hash sidecar path
  translationMemory?: boolean; // cache whole-string translations by content hash
  translationMemoryFile?: string; // custom translation-memory path (implies translationMemory)
  force?: boolean; // re-translate all keys
  dryRun?: boolean; // no API calls or writes
  engine?: EngineAdapter; // custom engine instance
  logger?: LogFn; // receives progress, retries and warnings; without one nothing is printed
  config?: Partial<LoquiConfig>; // inline config overrides
  configPath?: string; // path to config file or directory
}
```

### Logging

`translate()` writes nothing to stdout or stderr unless you give it a `logger`. The
logger receives each message with a level — `info` for progress, `warn` for warnings,
`debug` for retries and per-key detail. Every `warn` message is also in the run's
`stats.warnings`.

```typescript
import { translate, stderrLogger } from "@mihairo/loqui";

// print what the CLI prints: colour on a terminal, plain otherwise
await translate({ input: "./en.json", from: "en", to: ["es"], logger: stderrLogger });

// or route it anywhere
await translate({
  input: "./en.json",
  from: "en",
  to: ["es"],
  logger: (level, message) => myLogger[level](message),
});
```

A custom engine reports through the same logger by calling the `log` that each
`translateChunk` request carries; `BaseEngine` already does.

### Inspecting target files

`diff()` and `validate()` are separate functions: they only read files, so they are
synchronous, and they never log, write, or touch `process.exitCode`. Neither needs `from`.

```typescript
import { diff, validate } from "@mihairo/loqui";

const options = { input: "./en.json", to: ["es", "pt"], output: "./i18n/{locale}.json" };

const { results, hasBaseline } = diff(options);
// results: [{ locale: "es", added: [...], removed: [...], changed: [...], unchanged: [...] }, ...]
// hasBaseline is false when there is no hash sidecar: nothing can be reported as changed

const checks = validate(options);
const broken = checks.filter((r) => r.missing.length > 0 || r.extra.length > 0);
if (broken.length > 0) process.exitCode = 1; // yours to decide
```

`InspectOptions` are `input`, `to`, `output` (the target files to inspect), `hashFile`,
`config` and `configPath`. A locale without a target file comes back with `fileMissing: true` and
every key under `missing`; an `output` record without a path for a target locale is rejected.
`translate()` rejects a call that still passes `diff` or `validate` with `INVALID_CONFIG`,
before it reads a file or calls an engine.

### Return value

`translate()` resolves with a `TranslateResult`:

```typescript
interface TranslateResult {
  locales: Record<string, JsonObject>; // one full document per target locale, keys sorted
  stats: RunStats; // keysTranslated, apiRequests, elapsedMs, failedChunks, warnings
  removed: Record<string, string[]>; // keys pruned from each locale's existing file
  written: Record<string, string>; // locale → path; empty on a dry run or without `output`
}
```

Documents are objects. Serialise them yourself with `JSON.stringify(doc, null, 2)` when
you need text. If `output` is specified, files are written to disk and the same
result is still returned.

### In-memory use

`translateObject()` is the core `translate()` is built on: no files read or written, no
config-file lookup. Everything comes in as data and goes back out as data, so you decide
what to persist.

```typescript
import { translateObject } from "@mihairo/loqui";

const run = await translateObject(
  { hello: "Hello" },
  { from: "en", to: ["es", "pt"], hashes: {}, existing: { es: { bye: "Adiós" } } },
);

run.locales.es; // { hello: "Hola" }
run.removed.es; // ["bye"]: pruned, the source no longer has it
// persist run.hashes and run.memory to make the next run incremental
```

Options: `from`, `to`, `config` (merged over the defaults and validated), `existing`
(documents by locale), `hashes` (hash maps by locale; passing it turns incremental on), `memory`, `glossary`
(resolved terms and a do-not-translate list), `namespace`, `force`, `dryRun`, `engine`
and `logger`. It resolves with an `ObjectRun`: a `TranslationRun` (`locales`, `stats`,
`removed`) plus the updated `hashes` and `memory`.

### Errors

`translate()` rejects with a `LoquiError`. Its `code` is one of the names in the
[exit-code table](#exit-codes). When chunks failed, `result` holds the run as far as it
got: `locales` with what did translate, `stats` with the warnings, and for
`translateObject()` the `hashes` and `memory` to persist. From `translate()`,
`result.written` names the files saved before it gave up. A run that stops before sending
anything (bad config, unreadable input) has no `result`.

```typescript
import { translate, LoquiError } from "@mihairo/loqui";

try {
  await translate({ input: "./en.json", from: "en", to: ["es", "de"] });
} catch (err) {
  if (err instanceof LoquiError && err.code === "CHUNK_FAILED") {
    console.warn(Object.keys(err.result?.locales ?? {})); // locales with output to salvage
    console.warn(err.result?.written); // files already saved
  }
  throw err;
}
```

### Migrating from v2

| v2                                                          | v3                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| `JSON.parse((await translate(o)).es)`                       | `(await translate(o)).locales.es`                    |
| `translate({ ...o, diff: true })`                           | `diff(o)`                                            |
| `translate({ ...o, validate: true })`, then `process.exitCode` | `validate(o)`, then check the result              |
| `err.partial`                                               | `err.result.locales`                                 |
| progress printed to stderr                                  | pass `logger: stderrLogger`                          |
| custom engine `translateChunk(chunk, locales, from, ns, glossary)` | `translateChunk(req)`; `req` is `{ chunk, targetLocales, sourceLocale, namespace, glossaryBlock?, log, onRateLimited }` |
| `reviewChunk(chunk, initial, locales, from, ns, glossary)`  | `reviewChunk(req)`; `req` adds `initial`             |
| the engine's optional logger and rate-limit setters         | removed: use `req.log`, and call `req.onRateLimited()` on a 429 |
| `BaseEngine` subclass overriding `makeCall` or calling `parseResponse` | both take the request as a last argument, for its `log` and `onRateLimited` |
| hash sidecar `{ key: hash }`                                | `{ locale: { key: hash } }`; a v2 file is converted on the first run |
| `translateObject({ hashes: { key: hash } })`                | `hashes: { es: { key: hash } }`                      |
| CLI: several locales as JSON strings inside JSON            | one JSON document                                    |
| CLI: `--diff` / `--validate` report on stderr               | on stdout                                            |
| CLI: `--validate` without `--output` warns and exits `0`   | exits `11` (`INVALID_USAGE`)                         |
| `validate()` leaves out a locale with no target file        | reports it with `fileMissing: true`, every key missing |

---

## Batch workflow

Translate multiple namespaces with a simple script:

```typescript
import { translate } from "@mihairo/loqui";
import { readdirSync } from "fs";
import { join } from "path";

const I18N_DIR = "src/assets/i18n";
const FROM = "en";
const TO = ["es", "pt", "de"];

const namespaces = readdirSync(I18N_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

for (const ns of namespaces) {
  await translate({
    input: join(I18N_DIR, ns, `${FROM}.json`),
    from: FROM,
    to: TO,
    output: join(I18N_DIR, ns, "{locale}.json"),
    namespace: ns,
    incremental: true,
  });
}
```

---

## What gets translated

Only string values are sent to the model. Everything else in the document — numbers,
booleans, `null`, empty objects and empty arrays — is carried through untouched and
restored exactly as it was parsed.

```jsonc
// en.json                              // es.json
{                                       {
  "title": "Welcome",                     "title": "Bienvenido",
  "items": ["one", "two"],                "items": ["uno", "dos"],
  "maxRetries": 3,                        "maxRetries": 3,
  "beta": false,                          "beta": false,
  "note": null                            "note": null
}                                       }
```

Arrays are translated element by element and stay arrays. A numeric-looking string
like `"42"` stays a string. A key that contains a dot (`{"a.b": "…"}`) stays one key
rather than becoming two levels of nesting. An empty or whitespace-only string is
copied to every target as it is and never sent to the model.

**Known limitation.** Non-string values always come from the source, so a per-locale
number or boolean hand-edited into a target file is overwritten on the next run. The
alternative — letting the target win — would freeze that value permanently, since a
non-string is never re-translated and so would never pick up a change in the source.
If you need a genuinely locale-specific non-string, keep it in a file loqui does not
write.

A target file holds exactly the source's keys. Keys that are no longer in the source are
removed from it on the next run; loqui warns with the count per locale and logs each
removed key (a dry run says what it would remove).

An empty string in a target file counts as untranslated, and loqui fills it. Inside an
array, an element that could not be translated is written as an empty string so the array
keeps its shape, and it is retried on the next run. A translation left empty on purpose
will be re-translated. If your i18next setup generates empty values, `returnEmptyString:
false` makes an empty value fall back instead of showing as blank.

---

## Placeholder protection

Tokens that must not be translated are automatically masked before the LLM call and restored afterward.

| Pattern             | Example                                         |
| ------------------- | ----------------------------------------------- |
| Double mustache     | `{{userName}}`, `{{count}}`                     |
| Template literal    | `${firstName}`                                  |
| ICU plural/select   | `{count, plural, one {# item} other {# items}}` |
| Simple ICU variable | `{name}`                                        |
| HTML tags           | `<strong>`, `</p>`, `<br/>`                     |

A value whose ICU block is never closed is skipped with a warning that names the key;
the other keys are still translated.

### Custom patterns

Add extra patterns in your config:

```json
{
  "placeholderPatterns": ["%{variable}", "__VAR__"]
}
```

Patterns are regex strings. Custom patterns are applied before the built-ins.

---

## Glossary (term-lock)

Lock specific terms so they always translate consistently, and mark brand/product names that must never be translated.

### Config

```jsonc
// .loqui.json
{
  "glossary": {
    "path": "glossary",          // folder OR file (optional)
    "noTranslate": ["Loqui", "GitHub", "OAuth"]
  }
}
```

### Term sources (resolved in priority order)

**1. Per-locale folder** — `glossary.path` points to a directory:

```
glossary/
  es.json  →  { "Dashboard": "Tablero", "Settings": "Configuración" }
  pt.json  →  { "Dashboard": "Painel" }
```

**2. Combined file** — `glossary.path` points to a single JSON file:

```json
{
  "Dashboard": { "es": "Tablero", "pt": "Painel" }
}
```

**3. Inline source key** — add a `glossary` top-level key directly in your source file. It is stripped before translation and never appears in any output:

```json
{
  "glossary": { "Dashboard": { "es": "Tablero" } },
  "title": "Dashboard overview",
  "nav.home": "Home"
}
```

### How it works

- **`noTranslate`** — terms are hard-masked before the LLM call and restored verbatim afterward (same mechanism as placeholder protection). Guaranteed.
- **glossary terms** — injected into the system prompt ("use 'Tablero' for 'Dashboard' in es") and verified after translation. If a translation drops the locked term, the key is skipped and retried on the next run.
- Matching is case-insensitive, word-boundary-aware, and longest-term-first.

### Translation memory (separate feature)

The `--translation-memory` flag (formerly `--glossary`) caches whole-string translations by content hash. It is orthogonal to the terminology glossary — both can be active at the same time.

A memory file written by an earlier version is ignored with a warning, and rebuilt as keys are translated.

`--force` ignores the memory and overwrites it: every key goes to the engine, and the new translations replace what the memory held.

---

## Inspecting without translating

Both of these print their report on stdout, write nothing, and make no API calls.
Diagnostics, such as the warning that there is no hash sidecar, go to stderr. From code,
use [`diff()` and `validate()`](#inspecting-target-files).

```sh
# What has been added, removed or changed since the last run
loqui --input en.json --to es,de --output ./i18n/{locale}.json --diff

# Do the target locales have the same key set as the source?
loqui --input en.json --to es,de --output ./i18n/{locale}.json --validate
```

`--diff` reports **changed** by comparing the current source against the hashes
recorded by a previous run, so it needs the hash sidecar. Without one it says so and
reports nothing as changed — there is no record of what the source used to be.
`--validate` exits `1` when a target locale has missing or extra keys, or no file at all.

---

## Incremental translation

When `--incremental` is set (or `incremental: true` in the API), loqui stores a hash of each source value next to the input file as `.{name}.loqui-hash.json`. On subsequent runs, only keys whose source text changed (or that are missing from the target) are sent to the LLM.

The sidecar holds one map per target locale, `{ "es": { "<key>": "<hash>" } }`. A locale's
hash for a key is recorded only once that locale has the new translation — a changed key
that still holds its old one does not count — so a key that failed stays outstanding for
that locale, and a locale you did not run keeps its entry. With no output, a dry run, or
a run where nothing landed, the sidecar does not change. Keys deleted from the source are
pruned, so the sidecar tracks the source rather than growing forever.

A v2 sidecar (one flat map of hashes) is read as the hashes of every locale in `--to`
and rewritten per locale, so the first v3 run should cover every locale you translate.

```sh
loqui --input en.json --from en --to es,de --output ./i18n/{locale}.json --incremental
```

The hash file path can be customised:

```sh
loqui --input en.json --incremental --hash-file .cache/en.hash.json ...
```

---

## Custom prompts

Override the system or user prompt with your own template. Available variables:

| Variable            | Description                         |
| ------------------- | ----------------------------------- |
| `{{sourceLocale}}`  | Source locale code (e.g. `en`)      |
| `{{targetLocales}}` | Comma-separated target locales      |
| `{{namespace}}`     | Namespace label (if provided)       |
| `{{context}}`       | Domain context string (if provided) |
| `{{json}}`          | The JSON chunk to translate         |

```json
{
  "prompts": {
    "system": "You are a professional translator for a SaaS product. Translate from {{sourceLocale}} to {{targetLocales}}. Keep all placeholders intact.",
    "user": "Translate this JSON:\n\n{{json}}"
  }
}
```

---

## Custom engines

Pass any object implementing `EngineAdapter` via the `engine` option to bypass the built-in providers entirely:

```typescript
import {
  translate,
  EngineAdapter,
  TranslateChunkRequest,
  TranslationResult,
} from "@mihairo/loqui";

const myEngine: EngineAdapter = {
  async translateChunk({ chunk, targetLocales }: TranslateChunkRequest) {
    const result: Record<string, TranslationResult> = {};
    for (const locale of targetLocales) {
      // call your own LLM or translation service here
      result[locale] = {
        keys: {
          /* translated flat key/value pairs */
        },
      };
    }
    return result;
  },
};

await translate({ input: "en.json", from: "en", to: ["es"], engine: myEngine });
```

Or extend `BaseEngine` to reuse the built-in prompt builder and JSON response parser:

```typescript
import { BaseEngine, LoquiConfig, TranslateChunkRequest } from "@mihairo/loqui";

class MyEngine extends BaseEngine {
  constructor(config: LoquiConfig) {
    super(config);
  }

  async translateChunk(req: TranslateChunkRequest) {
    const { chunk, targetLocales, sourceLocale, namespace } = req;
    const systemPrompt = this.buildSystemPrompt(
      targetLocales,
      sourceLocale,
      namespace,
    );
    const userPrompt = this.buildUserPrompt(chunk, targetLocales, sourceLocale);

    const raw = await callMyLLM(systemPrompt, userPrompt); // your implementation

    // req carries this call's log, so parse warnings reach this run only
    return this.parseResponse(raw, Object.keys(chunk.keys), targetLocales, req);
  }
}

await translate({
  input: "en.json",
  from: "en",
  to: ["es"],
  engine: new MyEngine(config),
});
```

---

## Environment variables

| Variable               | Required for          |
| ---------------------- | --------------------- |
| `GEMINI_API_KEY`       | `engine: "gemini"`    |
| `OPENAI_API_KEY`       | `engine: "openai"`    |
| `ANTHROPIC_API_KEY`    | `engine: "anthropic"` |
| `ANTHROPIC_API_VERSION` | Override Anthropic API version (default: `2023-06-01`) |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `GEMINI_API_KEY environment variable is not set` | Missing env var | Export the correct key for your engine |
| `'from' (source locale) is required` | No `from` in options or config | Add `from` to `.loqui.json` or pass `--from` |
| Empty translation strings in output | LLM response missing keys | Try reducing `splitToken`, check model availability |
| `Engine returned invalid JSON` | LLM returned non-JSON | Try a more capable model, or add `context` to help the LLM |
| `429` rate limit errors | Too many concurrent requests | Reduce `concurrency` in config (default: 8) |
| Keys not re-translated after source changes | Hash file has stale values | Run with `--force` once to reset, or delete the `.loqui-hash.json` sidecar |
| `Failed to parse '.loqui.json'` | Syntax error in config | Validate the JSON at jsonlint.com or similar |
| `unknown option: --…` (exit 11) | Mistyped flag | The message suggests the closest real flag; `loqui --help` lists them all |
| `stopped at the output token limit` (exit 10) | A single value is too long for the model's output limit. loqui already splits a cut-off chunk and retries the halves | Shorten or split that value, or use a model with a larger output limit |
| `chunk(s) failed` (exit 8) | Some chunks failed after retries | With an output path, the rest was already written — re-run to retry only the gap. Without one, nothing was saved |
| `Could not parse <file> as JSON` (exit 7) | A target file, hash sidecar, translation-memory file or glossary file is not valid JSON, for example a merge-conflict marker | loqui stops and leaves the file alone — fix or delete it, then re-run |
| `unexpected argument: …` or `… needs a value` (exit 11) | An extra positional argument, as in `--to es de`, or a value flag followed by another flag | Pass locales as `--to es,de`; give the flag its value, or write it as `--flag=value` |
| `was not sent for translation` | A source string has an ICU plural/select block that is never closed | Fix the braces in the source string; the other keys are still translated |
| `returned a body that is not JSON` (exit 6) | A proxy or gateway answered in place of the API | Check any proxy or gateway between you and the API, then re-run |
| `--diff` reports nothing as changed | No hash sidecar yet | Run once with `--incremental` to start recording source hashes |

## Performance Tuning

### `splitToken` (default: 4000)

Controls how many source keys are bundled into a single LLM request. Higher = fewer requests (faster, cheaper) but risks hitting model context limits. Lower = safer for models with small context windows.

- **4000** — Recommended for Flash/GPT-4o-mini tier models
- **12000+** — Recommended for Pro/GPT-4o tier models

### `concurrency` (default: 8)

Number of simultaneous API requests. Higher = faster for large files but risks rate limits.

- Reduce to 3–4 if you see frequent 429s
- Free-tier API keys: use 1–2

### `--incremental`

Always use this flag for repeated runs. Skips unchanged keys entirely. On a 1000-key file where only 10 keys changed, you pay for 10 keys, not 1000.

---

## GitHub Actions

Integrate loqui into your CI pipeline to automatically translate i18n files on push.

### Example workflow

```yaml
name: Translate i18n

on:
  push:
    paths: ['src/i18n/en.json']

jobs:
  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'
      - run: npm ci
      - run: npx @mihairo/loqui --input src/i18n/en.json --from en --to es,pt,de --output src/i18n/{locale}.json --incremental
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
      - uses: peter-evans/create-pull-request@v6
        with:
          title: 'chore: update i18n translations'
          commit-message: 'chore: update i18n translations'
          branch: i18n/update
```

To run loqui in another repository, copy this workflow into its `.github/workflows/`.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on setting up the project, running tests, and submitting pull requests. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

---

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
