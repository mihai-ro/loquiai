import { mkdir, writeFile } from 'node:fs/promises';
import esbuild from 'esbuild';

// ESM builds with code splitting
await esbuild.build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  minify: true,
  treeShaking: true,
  splitting: true,
  format: 'esm',
  outdir: 'dist',
  entryPoints: ['src/lib.ts', 'src/index.ts'],
  entryNames: '[name]',
});

// CJS build (no code splitting support), library only: the CLI is ESM
await esbuild.build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  minify: true,
  treeShaking: true,
  format: 'cjs',
  entryPoints: ['src/lib.ts'],
  outfile: 'dist/lib.cjs',
});

// The declarations are emitted a second time into dist/cjs (see the build script) so a
// CommonJS consumer's TypeScript resolves them as CJS. The package is "type": "module",
// so without this marker every .d.ts under dist would be read as ESM.
await mkdir('dist/cjs', { recursive: true });
await writeFile('dist/cjs/package.json', '{"type":"commonjs"}\n');
