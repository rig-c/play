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

let sandbox = '';
let pkgDist = '';

function ensureSandbox(): void {
  if (sandbox) return;
  sandbox = mkdtempSync(resolve(tmpdir(), 'play-source-res-'));
  const pkgRoot = resolve(sandbox, 'node_modules', '@rig-c', 'play');
  pkgDist = resolve(pkgRoot, 'dist');
  mkdirSync(pkgRoot, { recursive: true });

  const built = spawnSync('node', [resolve(repoRoot, 'scripts', 'build-lib.mjs'), pkgDist], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, `scripts/build-lib.mjs failed:\n${built.stdout}${built.stderr}`);

  cpSync(resolve(repoRoot, 'package.json'), resolve(pkgRoot, 'package.json'));
  writeFileSync(
    resolve(sandbox, 'package.json'),
    `${JSON.stringify({ name: 'play-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
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
    '.': {
      '@rig-c/source': './src/index.ts',
      types: './dist/index.d.ts',
      import: './dist/index.js',
    },
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
  'default installed mode resolves dist in Node, Bun, TypeScript and Vite, and refuses missing src under @rig-c/source',
  { timeout: 60_000 },
  async () => {
    ensureSandbox();
  const nodeDefault = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      "const m = await import('@rig-c/play'); console.log(JSON.stringify({ resolved: import.meta.resolve('@rig-c/play'), keys: Object.keys(m).sort() }));",
    ],
    { cwd: sandbox, encoding: 'utf8' },
  );
  assert.equal(nodeDefault.status, 0, nodeDefault.stderr);
  const nodeData = JSON.parse(nodeDefault.stdout) as { resolved: string; keys: string[] };
  assert.match(nodeData.resolved.replaceAll('\\', '/'), /\/node_modules\/@rig-c\/play\/dist\/index\.js$/);
  assert.deepEqual(nodeData.keys, [
    'CanvasRenderer',
    'DomRenderer',
    'RigPlayer',
    'createAtlasRegions',
    'loadModel',
    'readSetupMesh',
    'revokeRegions',
    'unpackRegions',
  ]);

  const bunDefault = spawnSync(
    'bun',
    ['-e', "console.log(JSON.stringify({ resolved: import.meta.resolve('@rig-c/play') }))"],
    { cwd: sandbox, encoding: 'utf8' },
  );
  assert.equal(bunDefault.status, 0, bunDefault.stderr);
  assert.match(
    (JSON.parse(bunDefault.stdout) as { resolved: string }).resolved.replaceAll('\\', '/'),
    /\/node_modules\/@rig-c\/play\/dist\/index\.js$/,
  );

  writeFileSync(
    resolve(sandbox, 'consumer-default.ts'),
    "import { RigPlayer, type ModelAssets } from '@rig-c/play';\nexport function check(root: HTMLElement, assets: ModelAssets): RigPlayer { return new RigPlayer(root, assets); }\n",
  );
  for (const [mode, moduleName] of [
    ['bundler', 'ESNext'],
    ['nodenext', 'NodeNext'],
  ] as const) {
    const cfg = resolve(sandbox, `tsconfig.default.${mode}.json`);
    writeFileSync(
      cfg,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: moduleName,
          moduleResolution: mode,
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['consumer-default.ts'],
      }),
    );
    const tscRes = spawnSync('node', [tscBin, '--noEmit', '--listFiles', '-p', cfg], {
      cwd: sandbox,
      encoding: 'utf8',
    });
    assert.equal(tscRes.status, 0, tscRes.stdout + tscRes.stderr);
    assert.match(tscRes.stdout.replaceAll('\\', '/'), /\/node_modules\/@rig-c\/play\/dist\/index\.d\.ts/);
  }

  // Negative missing-source refusal: when src/index.ts is absent (as in an installed package), @rig-c/source must fail rather than falling back to dist/.
  const nodeMissing = spawnSync(
    'node',
    ['--conditions=@rig-c/source', '--input-type=module', '-e', "await import('@rig-c/play')"],
    { cwd: sandbox, encoding: 'utf8' },
  );
  assert.notEqual(nodeMissing.status, 0);
  assert.match(nodeMissing.stderr, /src\/index\.ts/);

  const bunMissing = spawnSync(
    'bun',
    ['--conditions=@rig-c/source', '-e', "await import('@rig-c/play')"],
    { cwd: sandbox, encoding: 'utf8' },
  );
  assert.notEqual(bunMissing.status, 0);

  const missingTsconfig = resolve(sandbox, 'tsconfig.missing-src.json');
  writeFileSync(
    missingTsconfig,
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
      },
      files: ['consumer-default.ts'],
    }),
  );
  const tscMissing = spawnSync('node', [tscBin, '--noEmit', '--traceResolution', '-p', missingTsconfig], {
    cwd: sandbox,
    encoding: 'utf8',
  });
  assert.match(tscMissing.stdout + tscMissing.stderr, /Failed to resolve under condition '@rig-c\/source'/);

  await assert.rejects(() =>
    viteBuild({
      root: sandbox,
      configFile: false,
      logLevel: 'silent',
      resolve: { conditions: ['@rig-c/source', ...defaultClientConditions] },
      build: {
        write: false,
        lib: {
          entry: resolve(sandbox, 'consumer-default.ts'),
          formats: ['es'],
          fileName: () => 'out.js',
        },
      },
    }),
  );
});

test(
  'explicit @rig-c/source mode resolves src/index.ts without dist and observes live synthetic edits',
  { timeout: 60_000 },
  async () => {
    ensureSandbox();
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

    // With @rig-c/source, Bun resolves src/index.ts directly without dist/.
    const bunLinked = spawnSync(
      'bun',
      [
        '--conditions=@rig-c/source',
        '-e',
        "const m = await import('@rig-c/play'); console.log(JSON.stringify({ resolved: import.meta.resolve('@rig-c/play'), keys: Object.keys(m).sort() }));",
      ],
      { cwd: consumerDir, encoding: 'utf8' },
    );
    assert.equal(bunLinked.status, 0, bunLinked.stderr);
    const bunInfo = JSON.parse(bunLinked.stdout) as { resolved: string; keys: string[] };
    assert.match(bunInfo.resolved.replaceAll('\\', '/'), /\/play-checkout\/src\/index\.ts$/);
    assert.deepEqual(bunInfo.keys, [
      'CanvasRenderer',
      'DomRenderer',
      'RigPlayer',
      'createAtlasRegions',
      'loadModel',
      'readSetupMesh',
      'revokeRegions',
      'unpackRegions',
    ]);

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
      "import { __SYNTHETIC_SOURCE_EDIT__, RigPlayer } from '@rig-c/play';\nexport const observed: 'observed-without-dist-build' = __SYNTHETIC_SOURCE_EDIT__;\nexport const player = RigPlayer;\n",
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

    // Negative missing-source refusal in linked workspace (no dist/, src/index.ts removed): tsc, Bun and Vite all refuse.
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
