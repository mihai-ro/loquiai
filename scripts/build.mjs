import esbuild from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
};

await Promise.all([
  // Programmatic library
  esbuild.build({
    ...shared,
    entryPoints: ['src/lib.ts'],
    outfile: 'dist/lib.js',
  }),

  // CLI
  esbuild.build({
    ...shared,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    external: ['readline/promises'],
  }),
]);
