# Contributing to loqui

Thank you for taking the time to contribute. All contributions are welcome — bug fixes, new features, documentation improvements, and test coverage.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

---

## Getting started

```sh
git clone https://github.com/your-org/loqui.git
cd loqui
npm install
npm run build
npm test
```

---

## Development workflow

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run build:watch` | Recompile on save |
| `npm test` | Full test suite (compiles first) |
| `npm run clean` | Remove `dist/` |

All source files live in `src/`. Tests use Node's built-in `node:test` runner — no external test frameworks.

---

## Submitting changes

1. **Fork** the repository and create a branch from `main`.
2. **Make your changes.** Keep commits focused — one logical change per commit.
3. **Add or update tests** for any changed behaviour. The test suite must pass with zero failures.
4. **Ensure `tsc` produces zero errors** — `npm run build` must succeed cleanly.
5. **Open a pull request** against `main` with a clear description of what changed and why.

---

## Adding a new engine

1. Create `src/engines/myengine.engine.ts` extending `BaseEngine`.
2. Add the engine name to `SupportedEngine` in `src/types.ts`.
3. Register it in `src/engines/factory.ts`.
4. Document the required environment variable in the README.

---

## Reporting bugs

Open a GitHub issue with:
- loqui version (`npm list loqui`)
- Node.js version (`node --version`)
- A minimal reproduction (input JSON + config + command)
- The actual vs expected output
