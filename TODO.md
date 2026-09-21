# Roadmap

loqui is an AI-powered i18n translation engine that uses LLMs (Gemini, OpenAI, Anthropic) to translate localization files with smart change detection. It supports incremental updates, protects placeholders, and offers both CLI and programmatic APIs.

## Done ✅

- Core translation engine (Gemini, OpenAI, Anthropic)
- Incremental translation via hash-based change detection
- Placeholder protection (mustache, template literals, ICU, HTML)
- CLI with stdin/stdout support
- Programmatic API
- Custom engine support
- Biome linter + formatter
- ESM + CJS dual output
- Node.js ≥22 support
- Test coverage with c8, including the built CLI artifact
- Lossless round trip for arrays, numbers, booleans and null
- Documented exit codes (0–11) with unknown-flag rejection
- Partial-run recovery: successful chunks are written and resumed from

## In Progress 🚧

(none)

## Next Up 📋

(none)

## Ideas 💡

- JSON5 support
- Plural form handling
- Translation quality scoring
- Batch namespace translation
- VS Code extension (future)

## Not Planned ❌

- Web dashboard / SaaS
- Non-LLM translation backends
- Mobile SDK
