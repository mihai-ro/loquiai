import esbuild from 'esbuild';

// ESM build with code splitting. CommonJS callers load it through require(), which Node 22.12+
// supports for a module graph without top-level await.
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
