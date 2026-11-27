import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfigFileTextToJson } from 'typescript';
import { build as viteBuild, defaultClientConditions } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const ROOT_EXPORTS = [
  'CanvasRenderer',
  'DomRenderer',
  'RigPlayer',
  'createAtlasRegions',
  'discoverTurnDials',
  'loadModel',
  'normalizedDial',
  'readSetupMesh',
  'revokeRegions',
  'unpackRegions',
];
const COMPOSED_EXPORTS = [
  'ComposedTakeError',
  'SCENE_CAMERA_REPORT_MAX_BYTES',
  'bindSceneCamera',
  'mountComposedTake',
  'renderSceneCameraFrame',
  'sceneCameraProjection',
];
const INSTALLED_EXPORTS = {
  '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  './composed-take': { types: './dist/composed-take.d.ts', import: './dist/composed-take.js' },
};
const RESOLVE_ENTRIES = [
  "const names = ['@rig-c/play', '@rig-c/play/composed-take'];",
  'const entries = await Promise.all(names.map(async name => ({',
  '  resolved: import.meta.resolve(name), keys: Object.keys(await import(name)).sort(),',
  '})));',
  'console.log(JSON.stringify(entries));',
].join('\n');

interface ResolvedEntry {
  resolved: string;
  keys: string[];
}

let sandbox = '';

function ensureSandbox(): void {
  if (sandbox) return;
  sandbox = mkdtempSync(resolve(tmpdir(), 'play-source-res-'));
  const pkgRoot = resolve(sandbox, 'release-input');
  const pkgDist = resolve(pkgRoot, 'dist');
  mkdirSync(pkgRoot, { recursive: true });

  const built = spawnSync('node', [resolve(repoRoot, 'scripts', 'build-lib.mjs'), pkgDist], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, `scripts/build-lib.mjs failed:\n${built.stdout}${built.stderr}`);

  for (const file of ['package.json', 'LICENSE', 'NOTICE.md', 'README.md', 'docs/MIGRATION.md', 'docs/REFERENCE.md', 'docs/STABILITY.md', 'skills']) {
    const dest = resolve(pkgRoot, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(resolve(repoRoot, file), dest, { recursive: true });
  }
  const packed = spawnSync('node', [resolve(repoRoot, 'scripts', 'pack-release.mjs'), resolve(sandbox, 'tarballs'), pkgRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  assert.deepEqual(readFileSync(resolve(pkgRoot, 'package.json')), readFileSync(resolve(repoRoot, 'package.json')));

  writeFileSync(
    resolve(sandbox, 'package.json'),
    `${JSON.stringify({ name: 'play-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  const installed = spawnSync('npm', [
    'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--package-lock=false', packed.stdout.trim(),
  ], { cwd: sandbox, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
}

function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (quote) {
      if (c === '\\') {
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function specifiers(code: string): string[] {
  const pattern =
    /(?:\bimport\b|\bexport\b)[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  return [...code.matchAll(pattern)].map((match) => (match[1] ?? match[2]) as string);
}

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test(
  'manifest, lockfile, fetch-assets.sh and src/tests/scripts/bench consumers use canonical @rig-c/core and deterministic .bin/rigc',
  { timeout: 60_000 },
  () => {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    exports?: Record<string, Record<string, string>>;
  };
  const parsedLock = parseConfigFileTextToJson('bun.lock', readFileSync(resolve(repoRoot, 'bun.lock'), 'utf8'));
  assert.equal(parsedLock.error, undefined);
  const lock = parsedLock.config as {
    workspaces: Record<string, { devDependencies?: Record<string, string> }>;
    packages: Record<string, [string, string, { dependencies?: Record<string, string>; bin?: Record<string, string> | string }, ...unknown[]]>;
  };

  const rigcPin = manifest.devDependencies?.['@rig-c/core'];
  assert(typeof rigcPin === 'string');
  assert.match(rigcPin, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.workspaces[''].devDependencies?.['@rig-c/core'], rigcPin);
  assert.equal(lock.packages['@rig-c/core']?.[0], `@rig-c/core@${rigcPin}`);
  const partsPin = manifest.devDependencies?.['@rig-c/parts'];
  assert(typeof partsPin === 'string');
  assert.match(partsPin, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.workspaces[''].devDependencies?.['@rig-c/parts'], partsPin);
  assert.equal(lock.packages['@rig-c/parts']?.[0], `@rig-c/parts@${partsPin}`);
  assert.equal(lock.packages['@rig-c/parts']?.[2]?.dependencies?.['@rig-c/core'], rigcPin);
  assert.equal(lock.packages['@rig-c/parts']?.[2]?.dependencies?.['rig-c'], undefined);
  assert.equal(lock.packages['rig-c'], undefined);
  const rigcBins = Object.entries(lock.packages)
    .filter(([, entry]) => {
      const bin = entry[2]?.bin;
      return typeof bin === 'object' && bin !== null && 'rigc' in bin;
    })
    .map(([name]) => name);
  assert.deepEqual(rigcBins, ['@rig-c/core']);
  assert.equal(existsSync(resolve(repoRoot, 'node_modules', 'rig-c')), false);
  assert.equal(
    realpathSync(resolve(repoRoot, 'node_modules/.bin/rigc')),
    realpathSync(resolve(repoRoot, 'node_modules/@rig-c/core/bin/rigc.cjs')),
  );
  assert.equal(manifest.dependencies?.['@rig-c/core'], undefined);
  assert.equal(manifest.dependencies?.['rig-c'], undefined);
  assert.equal(manifest.devDependencies?.['rig-c'], undefined);
  assert.equal(manifest.peerDependencies, undefined);

  const fetchAssets = readFileSync(resolve(repoRoot, 'scripts/fetch-assets.sh'), 'utf8');
  assert.equal(fetchAssets.match(/^RIGC_TAG="([^"]+)"$/m)?.[1], `v${rigcPin}`);
  assert.equal(fetchAssets.match(/^PARTS_TAG="([^"]+)"$/m)?.[1], `v${partsPin}`);
  assert.match(
    fetchAssets,
    /^WAVE_STAMP="\$RIGC_TAG parts \$PARTS_TAG assemble\+rig examples \$PARTS_EXAMPLES_COMMIT"$/m,
  );
  assert.match(fetchAssets, /"\$RIG_PARTS"\s+assemble\s+--config\s+examples\/wind\/config\.wave\.json/);
  assert.match(fetchAssets, /"\$RIG_PARTS"\s+rig\s+--config\s+examples\/wind\/config\.wave\.json/);
  assert.doesNotMatch(fetchAssets, /"\$RIG_PARTS"\s+build\b/);
  assert.match(fetchAssets, /for f in rig\.json motion\.json sets\.json; do/);
  assert.match(fetchAssets, /cmp -s "\$WAVE_WORK\/out\/rig\/\$f" "\$WAVE_EX\/expected-wave\/\$f"/);
  assert.match(fetchAssets, /require\('\$ROOT\/node_modules\/@rig-c\/core\/package\.json'\)\.version/);
  assert.match(fetchAssets, /require\('\$ROOT\/package\.json'\)\.devDependencies\['@rig-c\/core'\]/);

  assert.deepEqual(manifest.exports, {
    '.': { '@rig-c/source': './src/index.ts', ...INSTALLED_EXPORTS['.'] },
    './composed-take': { '@rig-c/source': './src/composed-take.ts', ...INSTALLED_EXPORTS['./composed-take'] },
  });

  const legacyPathLiteral = /['"`](?:rig-c\/(?:core|runtime|plate|cli)|[^'"`\n]*node_modules\/rig-c(?:\/|['"`])|[^'"`\n]*\/rig-c\/src\/)/;
  for (const dir of ['src', 'tests', 'scripts', 'bench'] as const) {
    const files = readdirSync(resolve(repoRoot, dir), { recursive: true })
      .map((entry) => String(entry).split(sep).join('/'))
      .filter(
        (file) =>
          (file.endsWith('.ts') || file.endsWith('.mjs') || file.endsWith('.py')) &&
          !file.startsWith('base.generated/') &&
          file !== 'load-base.generated.ts',
      );
    const legacy = files.filter((file) => {
      const raw = readFileSync(resolve(repoRoot, dir, file), 'utf8');
      if (file.endsWith('.py')) {
        const pyCode = raw
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('#'))
          .join('\n');
        return legacyPathLiteral.test(pyCode);
      }
      const code = stripComments(raw);
      const allSpecs = [
        ...specifiers(code),
        ...[...code.matchAll(/\bimport\.meta\.resolve\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string),
      ];
      return allSpecs.some((spec) => /^rig-c(\/|$)/.test(spec)) || legacyPathLiteral.test(code);
    });
    assert.deepEqual(legacy, []);
  }
});

test(
  'installed release resolves the same dist API with and without the linked source condition',
  { timeout: 60_000 },
  async () => {
    ensureSandbox();
    const pkg = resolve(sandbox, 'node_modules/@rig-c/play');
    const manifest = JSON.parse(readFileSync(resolve(pkg, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.exports, INSTALLED_EXPORTS);
    assert.equal(existsSync(resolve(pkg, 'src')), false);
    const entry = resolve(sandbox, 'consumer.ts');
    writeFileSync(entry,
      [
        "import { RigPlayer, type ModelAssets } from '@rig-c/play';",
        "import { mountComposedTake } from '@rig-c/play/composed-take';",
        'export function check(root: HTMLElement, assets: ModelAssets): RigPlayer { return new RigPlayer(root, assets); }',
        'export const mountTake = mountComposedTake;',
        '',
      ].join('\n'),
    );

    for (const source of [false, true]) {
      const flags = source ? ['--conditions=@rig-c/source'] : [];
      for (const [runtime, args] of [['node', ['--input-type=module']], ['bun', []]] as const) {
        const result = spawnSync(runtime, [...flags, ...args, '-e', RESOLVE_ENTRIES], { cwd: sandbox, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const [root, composed] = JSON.parse(result.stdout) as ResolvedEntry[];
        assert.match(root.resolved.replaceAll('\\', '/'), /\/node_modules\/@rig-c\/play\/dist\/index\.js$/);
        assert.deepEqual(root.keys, ROOT_EXPORTS);
        assert.match(composed.resolved.replaceAll('\\', '/'), /\/node_modules\/@rig-c\/play\/dist\/composed-take\.js$/);
        assert.deepEqual(composed.keys, COMPOSED_EXPORTS);
      }

      for (const [moduleResolution, module] of [['bundler', 'ESNext'], ['nodenext', 'NodeNext']] as const) {
        const cfg = resolve(sandbox, 'tsconfig.json');
        writeFileSync(cfg, JSON.stringify({
          compilerOptions: {
            target: 'ES2022', module, moduleResolution, lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            strict: true, noEmit: true, customConditions: source ? ['@rig-c/source'] : [],
          },
          files: ['consumer.ts'],
        }));
        const result = spawnSync('node', [tscBin, '--listFiles', '--traceResolution', '-p', cfg], {
          cwd: sandbox, encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Module name '@rig-c\/play' was successfully resolved to '.*\/dist\/index\.d\.ts'/);
        assert.match(result.stdout, /Module name '@rig-c\/play\/composed-take' was successfully resolved to '.*\/dist\/composed-take\.d\.ts'/);
        assert.doesNotMatch(result.stdout, /Failed to resolve under condition '@rig-c\/source'/);
      }

      const vite = await viteBuild({
        root: sandbox, configFile: false, logLevel: 'silent',
        resolve: { conditions: source ? ['@rig-c/source', ...defaultClientConditions] : [...defaultClientConditions] },
        build: { write: false, lib: { entry, formats: ['es'], fileName: 'out' } },
      });
      const outputs = Array.isArray(vite) ? vite : [vite];
      const modules = outputs.flatMap(result => 'output' in result
        ? result.output.flatMap(chunk => chunk.type === 'chunk' ? Object.keys(chunk.modules) : []) : []);
      for (const file of ['_play-runtime.js', 'composed-take.js']) {
        assert(modules.some(id => id.endsWith(`/node_modules/@rig-c/play/dist/${file}`)), file);
      }
    }

    // Plant a dangling source condition on each installed entry in turn.
    const manifestPath = resolve(pkg, 'package.json');
    const original = readFileSync(manifestPath, 'utf8');
    try {
      for (const [subpath, source] of [['.', './src/index.ts'], ['./composed-take', './src/composed-take.ts']]) {
        writeFileSync(manifestPath, JSON.stringify({
          ...manifest,
          exports: { ...manifest.exports, [subpath]: { '@rig-c/source': source, ...manifest.exports[subpath] } },
        }));
        const missing = spawnSync('node', ['--conditions=@rig-c/source', '--input-type=module', '-e', RESOLVE_ENTRIES], {
          cwd: sandbox, encoding: 'utf8',
        });
        assert.notEqual(missing.status, 0);
        assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/);
        assert(missing.stderr.includes(source.slice(2)));
      }
    } finally {
      writeFileSync(manifestPath, original);
    }
  },
);

test(
  'explicit @rig-c/source mode resolves both entries without dist and observes live synthetic edits',
  { timeout: 60_000 },
  async () => {
  const linkedRoot = mkdtempSync(resolve(tmpdir(), 'play-linked-'));
  try {
    const linkedPlay = resolve(linkedRoot, 'play-checkout');
    const consumerDir = resolve(linkedRoot, 'consumer');
    mkdirSync(resolve(consumerDir, 'node_modules', '@rig-c'), { recursive: true });
    mkdirSync(linkedPlay, { recursive: true });

    cpSync(resolve(repoRoot, 'package.json'), resolve(linkedPlay, 'package.json'));
    cpSync(resolve(repoRoot, 'src'), resolve(linkedPlay, 'src'), { recursive: true });
    symlinkSync(resolve(repoRoot, 'node_modules'), resolve(linkedPlay, 'node_modules'), 'dir');
    symlinkSync(resolve(repoRoot, 'node_modules', '@types'), resolve(consumerDir, 'node_modules', '@types'), 'dir');
    symlinkSync(linkedPlay, resolve(consumerDir, 'node_modules', '@rig-c', 'play'), 'dir');
    writeFileSync(
      resolve(consumerDir, 'package.json'),
      `${JSON.stringify({ name: 'linked-consumer', private: true, type: 'module' }, null, 2)}\n`,
    );
    assert.equal(existsSync(resolve(linkedPlay, 'dist')), false);

    // Without @rig-c/source, default mode fails when dist/ is absent (never silently falls back to src/).
    const bunWithoutCondition = spawnSync('bun', ['-e', "await import('@rig-c/play')"], {
      cwd: consumerDir,
      encoding: 'utf8',
    });
    assert.notEqual(bunWithoutCondition.status, 0);

    // With @rig-c/source, Bun resolves both source entries without dist/.
    const bunLinked = spawnSync(
      'bun',
      [
        '--conditions=@rig-c/source',
        '-e',
        RESOLVE_ENTRIES,
      ],
      { cwd: consumerDir, encoding: 'utf8' },
    );
    assert.equal(bunLinked.status, 0, bunLinked.stderr);
    const [root, composed] = JSON.parse(bunLinked.stdout) as ResolvedEntry[];
    assert.match(root.resolved.replaceAll('\\', '/'), /\/play-checkout\/src\/index\.ts$/);
    assert.deepEqual(root.keys, ROOT_EXPORTS);
    assert.match(composed.resolved.replaceAll('\\', '/'), /\/play-checkout\/src\/composed-take\.ts$/);
    assert.deepEqual(composed.keys, COMPOSED_EXPORTS);

    // Synthetic source-edit observation in the temp copy (no dist/, no build, no pack, real src/ untouched).
    const tempIndex = resolve(linkedPlay, 'src', 'index.ts');
    const baseIndex = readFileSync(tempIndex, 'utf8');
    writeFileSync(
      tempIndex,
      `${baseIndex}\nexport const __SYNTHETIC_SOURCE_EDIT__ = 'observed-without-dist-build' as const;\n`,
    );
    assert.equal(existsSync(resolve(linkedPlay, 'dist')), false);

    const bunEdited = spawnSync(
      'bun',
      [
        '--conditions=@rig-c/source',
        '-e',
        "const { __SYNTHETIC_SOURCE_EDIT__ } = await import('@rig-c/play'); console.log(__SYNTHETIC_SOURCE_EDIT__);",
      ],
      { cwd: consumerDir, encoding: 'utf8' },
    );
    assert.equal(bunEdited.status, 0, bunEdited.stderr);
    assert.equal(bunEdited.stdout.trim(), 'observed-without-dist-build');

    writeFileSync(
      resolve(consumerDir, 'linked-entry.ts'),
      [
        "import { __SYNTHETIC_SOURCE_EDIT__, RigPlayer } from '@rig-c/play';",
        "import { mountComposedTake } from '@rig-c/play/composed-take';",
        "export const observed: 'observed-without-dist-build' = __SYNTHETIC_SOURCE_EDIT__;",
        'export const player = RigPlayer;',
        'export const mountTake = mountComposedTake;',
        '',
      ].join('\n'),
    );
    const linkedTsconfig = resolve(consumerDir, 'tsconfig.linked.json');
    writeFileSync(
      linkedTsconfig,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          customConditions: ['@rig-c/source'],
          allowImportingTsExtensions: true,
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        files: ['linked-entry.ts'],
      }),
    );
    const tscEdited = spawnSync('node', [tscBin, '--noEmit', '--listFiles', '-p', linkedTsconfig], {
      cwd: consumerDir,
      encoding: 'utf8',
    });
    assert.equal(tscEdited.status, 0, tscEdited.stdout + tscEdited.stderr);
    assert.match(tscEdited.stdout.replaceAll('\\', '/'), /\/play-checkout\/src\/index\.ts/);
    assert.match(tscEdited.stdout.replaceAll('\\', '/'), /\/play-checkout\/src\/composed-take\.ts/);
    assert.doesNotMatch(tscEdited.stdout.replaceAll('\\', '/'), /\/play-checkout\/dist\//);

    const viteOut = await viteBuild({
      root: consumerDir,
      configFile: false,
      logLevel: 'silent',
      resolve: { conditions: ['@rig-c/source', ...defaultClientConditions] },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: resolve(consumerDir, 'linked-entry.ts'),
          formats: ['es'],
          fileName: () => 'bundle.js',
        },
      },
    });
    const chunks = Array.isArray(viteOut) ? viteOut : [viteOut];
    const bundleCode = chunks
      .flatMap((r) => ('output' in r ? r.output : []))
      .map((o) => ('code' in o ? o.code : ''))
      .join('\n');
    assert.match(bundleCode, /observed-without-dist-build/);
    assert.match(bundleCode, /class RigPlayer/);

    // TypeScript refuses a linked checkout with neither source nor dist.
    rmSync(tempIndex);
    const tscLinkedMissing = spawnSync('node', [tscBin, '--noEmit', '-p', linkedTsconfig], {
      cwd: consumerDir,
      encoding: 'utf8',
    });
    assert.notEqual(tscLinkedMissing.status, 0);
    assert.match(tscLinkedMissing.stdout + tscLinkedMissing.stderr, /Cannot find module '@rig-c\/play'/);
  } finally {
    rmSync(linkedRoot, { recursive: true, force: true });
  }
});
