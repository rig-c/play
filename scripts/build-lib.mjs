// Builds the npm package into one directory: `node scripts/build-lib.mjs <outDir>`.
//
// Two steps, because the package has to be self-contained and typed:
//
// 1. **The modules** — Vite builds both entry points together. The private
//    runtime chunk keeps the same renderer constructors and module state for
//    both imports. It includes the rig-c core and runtime, whose TypeScript
//    entries are only available in the development install.
// 2. **The types** — `tsc -p tsconfig.build.json --emitDeclarationOnly`, one
//    `.d.ts` (+ map) per source module. `stripInternal` drops every
//    declaration marked `@internal` — the adapter's and the loader's helpers,
//    the only ones that name a rig-c type — so the shipped types name nothing a
//    consumer does not have.
//
// `tests/package.spec.ts` runs this into a temp directory and pins what it
// emits; `bun run build:lib` runs it into `dist/`.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv[2];
if (!outArg) {
  console.error('usage: node scripts/build-lib.mjs <outDir>');
  process.exit(2);
}
const outDir = resolve(process.cwd(), outArg);
const index = resolve(root, 'src/index.ts');

await build({
  root,
  configFile: false,
  // The demo's public/ holds the fetched fixtures; none of it is the package.
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: {
        index,
        'composed-take': resolve(root, 'src/composed-take.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      output: {
        exports: 'named',
        chunkFileNames: '[name].js',
        manualChunks: { '_play-runtime': [index] },
      },
    },
  },
});

const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');
const types = spawnSync(
  process.execPath,
  [tsc, '-p', resolve(root, 'tsconfig.build.json'), '--outDir', outDir],
  { cwd: root, encoding: 'utf8' },
);
process.stdout.write(types.stdout);
process.stderr.write(types.stderr);
process.exit(types.status ?? 1);
