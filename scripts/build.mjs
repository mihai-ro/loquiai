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

// CJS builds (no code splitting support)
await Promise.all([
  esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node22',
    minify: true,
    treeShaking: true,
    format: 'cjs',
    entryPoints: ['src/lib.ts'],
    outfile: 'dist/lib.cjs',
  }),
  esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node22',
    minify: true,
    treeShaking: true,
    format: 'cjs',
    entryPoints: ['src/index.ts'],
    // No `banner` here: src/index.ts already carries the shebang and esbuild
    // preserves it. Emitting both makes line 2 a SyntaxError.
    outfile: 'dist/index.cjs',
  }),
]);
