# ADR-001: Zero Runtime Dependencies

## Status
Accepted

## Context
loqui is a CLI tool and library for translating JSON i18n files using LLM APIs. At inception, we needed to decide whether to use external libraries for HTTP requests, JSON parsing, CLI argument handling, and other common tasks.

## Decision
Maintain zero runtime dependencies. Use only Node.js built-in modules (`fs`, `path`, `https`, `readline/promises`).

## Rationale
- **Security**: Fewer dependencies = smaller attack surface. Users pass API keys through this tool.
- **Reliability**: No risk of transitive dependency breakage or supply chain attacks.
- **Size**: `node_modules` bloat is a real problem for CLI tools installed globally.
- **Simplicity**: The tool's scope is narrow enough that built-in Node.js APIs suffice.
- **Trust**: Users are more likely to adopt a tool with no deps they need to audit.

## Consequences
- More verbose HTTP code (raw `https` module instead of `axios`/`got`)
- Must maintain our own JSON parsing edge case handling
- CLI argument parsing is manual (no `commander`/`yargs`)
- Dev dependencies (TypeScript, esbuild, Biome) are acceptable since they don't ship to users

## Trade-offs Considered
- Using `node-fetch` or `undici` for cleaner HTTP — rejected to avoid even optional deps
- Using `commander` for CLI — rejected because our CLI is simple enough for manual parsing
