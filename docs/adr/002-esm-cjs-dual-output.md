# ADR-002: ESM + CJS Dual Output

## Status
Accepted

## Context
The JavaScript ecosystem is transitioning from CommonJS to ESM. Many projects still use `require()`, while modern projects prefer `import`. As a library published to npm, we need to support both.

## Decision
Ship both ESM (`.js`) and CommonJS (`.cjs`) bundles via the `exports` field in package.json. Set `"type": "module"` for the package.

```json
{
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/lib.js",
      "require": "./dist/lib.cjs"
    }
  }
}
```

## Rationale
- **Compatibility**: Works with both `import` and `require()` without forcing users to migrate
- **Future-proof**: ESM is the standard going forward
- **No breakage**: Existing CJS users don't need to change anything
- **esbuild**: Our build tool makes dual output trivial (two build passes)
- **Code splitting**: ESM supports code splitting, reducing bundle size from 18K to 140B for library users

## Consequences
- ESM build uses code splitting: shared code in chunks, engines lazy-loaded
- CJS build remains single-file (no code splitting support)
- TypeScript uses `"module": "nodenext"` which requires `.js` extensions in imports
- ESM library entry is 140B; actual code loaded on demand from chunks

## Risks Mitigated
- Dual-package hazard: Both formats load the same bundled code, no state duplication
- Import resolution: `exports` map ensures correct file is loaded for each format
- Bundle size: ESM users get minimal initial load, CJS users get traditional bundle
