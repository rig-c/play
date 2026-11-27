import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { parseConfigFileTextToJson } from 'typescript';

/**
 * What npm ships, checked the way a consumer meets it — node-side, no browser.
 *
 * The package is DOM-only at *run* time, but an *import* must succeed outside
 * a browser: anything that leaves @rig-c/play external and hands it to Node (a
 * server-side render pass importing a module that imports it, a test runner in
 * a node environment, a plain script) resolves it with Node's ESM resolver,
 * which — unlike every bundler — requires an explicit file extension on a
 * relative specifier. That is issue #16: `dist/*.js` carried extensionless
 * specifiers and an `import()` of the package by name died with ERR_MODULE_NOT_FOUND, while
 * the demo, the harness and every browser build resolved it fine.
 *
 * ⚠️ This spec must NEVER build into the repository's own `dist/`. During a
 * Playwright run `vite preview` is serving the demo out of `dist/`, and
 * `build:lib` starts with `rm -rf dist` — a lib build here would pull the
 * ground out from under every other spec in the same run. So the library is
 * built to a temp directory instead, and assembled there into a throwaway
 * installed-package layout (`node_modules/@rig-c/play`, alone), which is
 * also the only way to exercise the `exports` map: resolution by *package
 * name* is the thing under test, and a relative import of `../dist/index.js`
 * would not touch `exports` at all.
 *
 * ## Self-contained, by construction and by test
 *
 * The package poses through `rig-c/core`, whose entry is TypeScript source — a
 * devDependency that no consumer has installed and no node would load from
 * `node_modules` if they had. So the build (`scripts/build-lib.mjs`) bundles
 * that closure into one `index.js`, and the sandbox below installs the built
 * package and **nothing else**: no rig-c, no peer. Every assertion that
 * imports or typechecks the package by name is therefore also the assertion
 * that it needs nothing beside it.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/** The throwaway consumer directory; `node_modules/@rig-c/play` lives under it. */
let sandbox = '';
/** The built package's `dist` inside that sandbox. */
let pkgDist = '';
/**
 * `process.execPath` is the node that runs the Playwright worker — real node
 * even when the suite was launched through `bunx`, which only resolves the
 * CLI. It matters: bun's resolver accepts extensionless specifiers, so
 * spawning bun here would make every assertion below vacuous.
 */
function node(args: string[], cwd: string) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
}

/**
 * Same, but concurrent — the two typecheck passes below are the slow part of
 * this file and they do not touch each other, so they run side by side.
 */
function nodeAsync(args: string[], cwd: string): Promise<{ status: number | null; output: string }> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, args, { cwd });
    let output = '';
    const collect = (chunk: unknown) => {
      output += String(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (status) => settle({ status, output }));
  });
}

/** Writes a probe module into the sandbox and runs it there. */
function probe(name: string, source: string) {
  const file = resolve(sandbox, name);
  writeFileSync(file, source);
  return node([file], sandbox);
}

/** The two resolution modes a consumer can meet the shipped types through. */
const MODULE_MODES = {
  bundler: 'ESNext',
  nodenext: 'NodeNext',
} as const;
type ModuleMode = keyof typeof MODULE_MODES;

/** Writes `<name>.ts` plus a tsconfig for it in the sandbox and returns the path of the tsconfig. */
function writeConsumer(name: string, source: string, mode: ModuleMode): string {
  writeFileSync(resolve(sandbox, `${name}.ts`), source);
  const config = resolve(sandbox, `tsconfig.${name}.${mode}.json`);
  writeFileSync(
    config,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: MODULE_MODES[mode],
          moduleResolution: mode,
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          strict: true,
          noEmit: true,
          // Deliberately NOT skipped. Measured: with skipLibCheck on, a
          // fully extensionless dist/ typechecks clean under nodenext too —
          // the TS2835s are raised inside the shipped .d.ts, and that is
          // precisely the file skipLibCheck stops reading. Turning it on
          // here would cost ~3× less time and catch nothing.
          skipLibCheck: false,
        },
        files: [`${name}.ts`],
      },
      null,
      2,
    ),
  );
  return config;
}

test.beforeAll(() => {
  sandbox = mkdtempSync(resolve(tmpdir(), 'play-pkg-'));
  const pkgRoot = resolve(sandbox, 'node_modules', '@rig-c', 'play');
  pkgDist = resolve(pkgRoot, 'dist');
  mkdirSync(pkgRoot, { recursive: true });

  // One build, shared by every assertion in this file — the same script
  // `bun run build:lib` runs, into the sandbox instead of `dist/`.
  const built = node([resolve(repoRoot, 'scripts', 'build-lib.mjs'), pkgDist], repoRoot);
  expect(built.status, `scripts/build-lib.mjs failed:\n${built.stdout}${built.stderr}`).toBe(0);

  // The repository's real manifest, so the `exports` map under test is the
  // shipped one rather than a copy that can drift from it.
  cpSync(resolve(repoRoot, 'package.json'), resolve(pkgRoot, 'package.json'));

  // Makes the sandbox an ESM package of its own, so nothing above the temp
  // directory can decide how these probes are parsed.
  writeFileSync(
    resolve(sandbox, 'package.json'),
    `${JSON.stringify({ name: 'play-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );

  // Nothing but the package is installed: the claim every import below rests on.
  expect(readdirSync(resolve(sandbox, 'node_modules'))).toEqual(['@rig-c']);
  expect(readdirSync(resolve(sandbox, 'node_modules', '@rig-c'))).toEqual(['play']);
});

test.afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test('the package entry resolves by name in node and exposes its public API', () => {
  const run = probe(
    'probe-index.mjs',
    "const m = await import('@rig-c/play');\nfor (const name of ['setPhysicsParameters', 'readPhysicsParameters', 'clearPhysicsParameters', 'physicsMoved']) { if (typeof m.RigPlayer.prototype[name] !== 'function') throw new Error(name); }\nconsole.log(JSON.stringify(Object.keys(m).sort()));\n",
  );
  expect(run.status, `import('@rig-c/play') failed:\n${run.stderr}`).toBe(0);
  // Exhaustive on purpose: what the root entry exports is the package's API.
  expect(JSON.parse(run.stdout)).toEqual([
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
  ]);
});

test('the composed take entry resolves by name in node and exposes its runtime exports', () => {
  const run = probe(
    'probe-composed-take.mjs',
    "const m = await import('@rig-c/play/composed-take');\nconsole.log(JSON.stringify(Object.keys(m).sort()));\n",
  );
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual([
    'ComposedTakeError', 'SCENE_CAMERA_REPORT_MAX_BYTES', 'bindSceneCamera', 'mountComposedTake',
    'renderSceneCameraFrame', 'sceneCameraProjection',
  ]);
});

test('the binary subpath is gone: the package reads compiled models, not Spine exports', () => {
  const run = probe(
    'probe-binary.mjs',
    "try {\n  await import('@rig-c/play/binary');\n  console.log(JSON.stringify({ code: 'RESOLVED' }));\n} catch (error) {\n  console.log(JSON.stringify({ code: error.code }));\n}\n",
  );
  expect(run.status, `probe crashed:\n${run.stderr}`).toBe(0);
  expect(JSON.parse(run.stdout).code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
});

test('the exports map refuses deep imports, including the shared runtime', () => {
  const run = probe(
    'probe-subpath.mjs',
    [
      "for (const file of ['index.js', 'composed-take.js', '_play-runtime.js']) {",
      "  const code = await import('@rig-c/play/dist/' + file).then(() => 'RESOLVED', error => error.code);",
      '  console.log(code);',
      '}',
    ].join('\n'),
  );
  expect(run.status, `probe crashed:\n${run.stderr}`).toBe(0);
  expect(run.stdout.trim().split(/\r?\n/)).toEqual(Array(3).fill('ERR_PACKAGE_PATH_NOT_EXPORTED'));
});

/**
 * What the library build is supposed to emit — the complete library allowlist,
 * even when a checkout's `dist/` also holds demo/test assets: the two entries,
 * their shared runtime, and declarations with a map for every emitted file.
 */
const BUNDLED_MODULES = ['_play-runtime.js', 'composed-take.js', 'index.js'];
const DECLARED_MODULES = ['CanvasRenderer', 'DomRenderer', 'DomTexture', 'MeshGlBlitter', 'composed-camera', 'composed-take', 'index', 'liveFrame', 'liveFrameSource', 'loadModel', 'pixelRatio', 'player', 'posedFrame', 'scene-camera', 'turnDials'];
const LIBRARY_FILES = [...BUNDLED_MODULES, ...DECLARED_MODULES.map(name => `${name}.d.ts`)]
  .flatMap(file => [file, `${file}.map`]).sort();
const PACKED_EXPORTS = {
  '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  './composed-take': { types: './dist/composed-take.d.ts', import: './dist/composed-take.js' },
};

test('the library build emits those modules and nothing else', () => {
  /**
   * Issue #24: `tsconfig.build.json` compiles `src/**` and the demo's entry
   * point lives there too, so `dist/main.js` (11 kB) + `.d.ts` + both maps
   * rode into the published 0.4.1 and 0.5.0 tarballs. Nothing could reach
   * them — `main` is not a key in the `exports` map and no shipped module
   * imports it — which is exactly why every other assertion in this file
   * stayed green over two releases while 11 kB of the 76 kB of JavaScript in
   * the tarball was dead weight, and the one file in `dist/` whose top level
   * touched the DOM. Unreachable is not a signature, so the guard has to be
   * the emitted list itself, not anything a resolver or an import walk sees.
   *
   * Recursive, so a stray that lands in a subdirectory is caught too — `dist/`
   * being flat is part of what ships.
   */
  const emitted = readdirSync(pkgDist, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .sort();

  // The defect itself, named first, so its return reds out on the assertion
  // that explains it rather than on the set comparison below.
  expect(emitted.filter((file) => /(^|\/)main\./.test(file))).toEqual([]);

  expect(emitted.filter((file) => file.endsWith('.js'))).toEqual(BUNDLED_MODULES);
  expect(emitted).toEqual(LIBRARY_FILES);
  const { files } = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { files: string[] };
  expect(files.filter(file => file.startsWith('dist/')).sort()).toEqual(LIBRARY_FILES.map(file => `dist/${file}`));
});

test('nothing the package ships names a Spine runtime', () => {
  /**
   * The package reads no Spine runtime: it poses through `rig-c/core`, and
   * #39 adds an official WebGL oracle as a dev-only test dependency. It must
   * never enter the shipped library. The assertion is the claim the package
   * makes and it costs one read per emitted file: an import of a runtime written into `src/` would
   * ride into `index.js` with no other signature — vite inlines it, and the
   * emitted file set above does not change. Every module and every `.d.ts`,
   * comments stripped so a mention in prose is not a false red.
   */
  const emitted = readdirSync(pkgDist, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'));
  const naming = emitted.filter((file) =>
    /@esotericsoftware\//.test(stripComments(readFileSync(resolve(pkgDist, file), 'utf8'))),
  );
  expect(naming).toEqual([]);
  // A class the runtime defines and nothing here does, in case a bundler ever
  // inlined the code without its package name.
  const runtimeCode = emitted.filter((file) =>
    /\bSkeletonJson\b|\bAnimationStateData\b/.test(stripComments(readFileSync(resolve(pkgDist, file), 'utf8'))),
  );
  expect(runtimeCode).toEqual([]);
});

const ORACLE = '@esotericsoftware/spine-webgl';
const ORACLE_CORE = '@esotericsoftware/spine-core';
const ORACLE_VERSION = '4.3.13';
const isEsoteric = (name: string): boolean => name.startsWith('@esotericsoftware/');
type DependencyField = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
type DependencyManifest = Partial<Record<DependencyField, Record<string, string>>>;
interface OracleLock {
  workspaces: Record<string, DependencyManifest>;
  packages: Record<string, [string, string, DependencyManifest, ...unknown[]]>;
}

/** The test-only oracle is the complete exception, never a scope-wide allowlist. */
function oracleBoundaryErrors(manifest: DependencyManifest, lock: OracleLock): string[] {
  const errors: string[] = [];
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    if (Object.keys(manifest[field] ?? {}).length !== 0) errors.push(`${field}: consumer dependency list must be empty`);
    for (const name of Object.keys(manifest[field] ?? {}).filter(isEsoteric)) errors.push(`${field}: ${name} is not dev-only`);
  }
  const dev = Object.keys(manifest.devDependencies ?? {}).filter(isEsoteric).sort();
  if (dev.length !== 1 || dev[0] !== ORACLE || manifest.devDependencies?.[ORACLE] !== ORACLE_VERSION) {
    errors.push(`devDependencies: only ${ORACLE}@${ORACLE_VERSION} is the oracle`);
  }
  const locked = Object.entries(lock.packages).filter(([name, entry]) => isEsoteric(name) || isEsoteric(entry[0]));
  if (locked.length !== 2 || !locked.some(([name]) => name === ORACLE) || !locked.some(([name]) => name === ORACLE_CORE)) {
    errors.push('lockfile: only spine-webgl and its spine-core dependency may resolve');
  }
  for (const [name, entry] of locked) {
    if ((name !== ORACLE && name !== ORACLE_CORE) || entry[0] !== `${name}@${ORACLE_VERSION}`) {
      errors.push(`lockfile: unexpected oracle resolution ${name}: ${entry[0]}`);
    }
    const runtimeDeps = Object.keys(entry[2].dependencies ?? {}).sort();
    const expectedDeps = name === ORACLE ? [ORACLE_CORE] : [];
    if (JSON.stringify(runtimeDeps) !== JSON.stringify(expectedDeps) || (name === ORACLE && entry[2].dependencies?.[ORACLE_CORE] !== ORACLE_VERSION)) {
      errors.push(`lockfile: ${name} must retain the matching oracle dependency graph`);
    }
    for (const field of ['peerDependencies', 'optionalDependencies'] as const) {
      if (Object.keys(entry[2][field] ?? {}).some(isEsoteric)) errors.push(`lockfile: ${name} has an unexpected ${field} runtime`);
    }
  }
  for (const [workspace, declared] of Object.entries(lock.workspaces)) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const names = Object.keys(declared[field] ?? {}).filter(isEsoteric);
      const allowed = workspace === '' && field === 'devDependencies' ? [ORACLE] : [];
      if (JSON.stringify(names.sort()) !== JSON.stringify(allowed) || (allowed.length && declared[field]?.[ORACLE] !== ORACLE_VERSION)) {
        errors.push(`lockfile workspace ${JSON.stringify(workspace)} ${field}: unexpected oracle declaration`);
      }
    }
  }
  return errors;
}

function packageInputs(): { manifest: DependencyManifest; lock: OracleLock } {
  const parsed = parseConfigFileTextToJson('bun.lock', readFileSync(resolve(repoRoot, 'bun.lock'), 'utf8'));
  expect(parsed.error, 'bun.lock must parse as JSON with comments/trailing commas').toBeUndefined();
  return { manifest: JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as DependencyManifest, lock: parsed.config as OracleLock };
}

test('the manifest keeps Spine dev-only, declares no peer, and pins @rig-c/core, @rig-c/parts and the oracle exactly', () => {
  const { manifest, lock } = packageInputs();
  // No peer at all: the package needs nothing installed beside it (the
  // sandbox above installs it alone), so a consumer is told to install nothing.
  expect(manifest.peerDependencies).toBeUndefined();
  expect(oracleBoundaryErrors(manifest, lock)).toEqual([]);
  // The poser is @rig-c/core, bundled into `index.js` at the version this names — a
  // bare version, never a range, so a build is a function of one @rig-c/core and a
  // pose doubt is a rigc issue against that version.
  const rigcPin = manifest.devDependencies?.['@rig-c/core'];
  expect(typeof rigcPin).toBe('string');
  expect(rigcPin).toMatch(/^\d+\.\d+\.\d+$/);
  expect(lock.workspaces[''].devDependencies?.['@rig-c/core']).toBe(rigcPin);
  expect(lock.packages['@rig-c/core'][0]).toBe(`@rig-c/core@${rigcPin}`);
  const partsPin = manifest.devDependencies?.['@rig-c/parts'];
  expect(typeof partsPin).toBe('string');
  expect(partsPin).toMatch(/^\d+\.\d+\.\d+$/);
  expect(lock.workspaces[''].devDependencies?.['@rig-c/parts']).toBe(partsPin);
  expect(lock.packages['@rig-c/parts'][0]).toBe(`@rig-c/parts@${partsPin}`);
  expect(lock.packages['@rig-c/parts'][2].dependencies?.['@rig-c/core']).toBe(rigcPin);
  expect(lock.packages['@rig-c/parts'][2].dependencies?.['rig-c']).toBeUndefined();
  expect(lock.packages['rig-c']).toBeUndefined();
  const rigcBins = Object.entries(lock.packages)
    .filter(([, entry]) => {
      const bin = (entry[2] as { bin?: Record<string, string> | string } | undefined)?.bin;
      return typeof bin === 'object' && bin !== null && 'rigc' in bin;
    })
    .map(([name]) => name);
  expect(rigcBins).toEqual(['@rig-c/core']);
  expect(existsSync(resolve(repoRoot, 'node_modules', 'rig-c'))).toBe(false);
  expect(realpathSync(resolve(repoRoot, 'node_modules/.bin/rigc'))).toBe(
    realpathSync(resolve(repoRoot, 'node_modules/@rig-c/core/bin/rigc.cjs')),
  );
  const fetchAssets = readFileSync(resolve(repoRoot, 'scripts/fetch-assets.sh'), 'utf8');
  const rigcTag = fetchAssets.match(/^RIGC_TAG="([^"]+)"$/m)?.[1];
  expect(rigcTag, 'scripts/fetch-assets.sh RIGC_TAG must match the manifest @rig-c/core pin').toBe(`v${rigcPin}`);
  const partsTag = fetchAssets.match(/^PARTS_TAG="([^"]+)"$/m)?.[1];
  expect(partsTag, 'scripts/fetch-assets.sh PARTS_TAG must match the manifest @rig-c/parts pin').toBe(`v${partsPin}`);
  expect(fetchAssets).toContain("require('$ROOT/node_modules/@rig-c/core/package.json').version");
  expect(fetchAssets).toContain("require('$ROOT/package.json').devDependencies['@rig-c/core']");
  expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@rig-c/core');
  expect(Object.keys(manifest.dependencies ?? {})).not.toContain('rig-c');
  expect(Object.keys(manifest.devDependencies ?? {})).not.toContain('rig-c');
  const rawManifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, Record<string, string>>;
  };
  expect(rawManifest.exports).toEqual({
    '.': { '@rig-c/source': './src/index.ts', ...PACKED_EXPORTS['.'] },
    './composed-take': { '@rig-c/source': './src/composed-take.ts', ...PACKED_EXPORTS['./composed-take'] },
  });
});

test('source, test, script and bench files use @rig-c/core and never legacy rig-c paths', () => {
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
    expect(legacy, `legacy rig-c references in ${dir}`).toEqual([]);
  }
  const srcFiles = readdirSync(resolve(repoRoot, 'src'), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.ts'));
  const coreSpecs = new Set(
    srcFiles.flatMap((file) =>
      specifiers(stripComments(readFileSync(resolve(repoRoot, 'src', file), 'utf8'))).filter((spec) =>
        !spec.startsWith('.'),
      ),
    ),
  );
  expect([...coreSpecs].sort()).toEqual(['@rig-c/core/core', '@rig-c/core/runtime']);
});

test('the oracle exception refuses runtime promotion, extra runtimes and mismatched pins', () => {
  const original = packageInputs();
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const { manifest, lock } = structuredClone(original);
    manifest[field] = { ...manifest[field], [ORACLE]: ORACLE_VERSION };
    expect(oracleBoundaryErrors(manifest, lock)).toContain(`${field}: ${ORACLE} is not dev-only`);
    // A differently named consumer dependency could reach the already allowed
    // runtime nodes transitively. Self-contained means no consumer deps at all.
    const wrapper = structuredClone(original);
    wrapper.manifest[field] = { ...wrapper.manifest[field], 'oracle-wrapper': '1.0.0' };
    expect(oracleBoundaryErrors(wrapper.manifest, wrapper.lock)).toContain(`${field}: consumer dependency list must be empty`);
  }
  const extra = structuredClone(original);
  extra.manifest.devDependencies = { ...extra.manifest.devDependencies, '@esotericsoftware/spine-canvas': ORACLE_VERSION };
  extra.lock.packages['@esotericsoftware/spine-canvas'] = [`@esotericsoftware/spine-canvas@${ORACLE_VERSION}`, '', {}];
  expect(oracleBoundaryErrors(extra.manifest, extra.lock)).toContain(`devDependencies: only ${ORACLE}@${ORACLE_VERSION} is the oracle`);
  expect(oracleBoundaryErrors(extra.manifest, extra.lock)).toContain('lockfile: only spine-webgl and its spine-core dependency may resolve');
  const mismatch = structuredClone(original);
  mismatch.manifest.devDependencies = { ...mismatch.manifest.devDependencies, [ORACLE]: `^${ORACLE_VERSION}` };
  mismatch.lock.packages[ORACLE_CORE][0] = `${ORACLE_CORE}@4.3.12`;
  expect(oracleBoundaryErrors(mismatch.manifest, mismatch.lock)).toContain(`devDependencies: only ${ORACLE}@${ORACLE_VERSION} is the oracle`);
  expect(oracleBoundaryErrors(mismatch.manifest, mismatch.lock)).toContain(`lockfile: unexpected oracle resolution ${ORACLE_CORE}: ${ORACLE_CORE}@4.3.12`);
});

test('library source keeps the official oracle outside the shipped import graph', () => {
  const files = readdirSync(resolve(repoRoot, 'src'), { recursive: true }).map(String).filter((file) => file.endsWith('.ts'));
  const imports = files.filter((file) => /@esotericsoftware\//.test(stripComments(readFileSync(resolve(repoRoot, 'src', file), 'utf8'))));
  expect(imports).toEqual([]);
});

/**
 * The registry names the package shipped under before, kept as aliases (#65,
 * #98): every version of `@rig-c/play` is published again as `rig-play` and as
 * `spine-html`, and each must carry the same files, byte for byte, but for the
 * `name` line of `package.json`. `scripts/alias-tarball.mjs` makes those
 * tarballs and holds each to the package's before `release.yml` publishes it;
 * this runs the script over the temp build for each alias, then reads the
 * tarballs itself rather than taking the script's word, and plants a
 * difference the script has to name.
 */
const ALIASES = ['rig-play', 'spine-html'];
const aliasScript = resolve(repoRoot, 'scripts', 'alias-tarball.mjs');
const SHIPPED_DOCS = ['docs/MIGRATION.md', 'docs/REFERENCE.md', 'docs/STABILITY.md'];
const NPM_ALWAYS_SHIPS = ['LICENSE', 'README.md', 'package.json'];

interface DocLink {
  doc: string;
  line: number;
  target: string;
  resolved: string | null;
}

function trackedFiles(root: string): string[] {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  expect(r.status, `git ls-files: ${r.stderr}`).toBe(0);
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'))
    .sort();
}

function relativeLinksInText(root: string, doc: string, text: string): DocLink[] {
  const found: DocLink[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = { char: marker[0] as string, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const targets = [
      ...[...line.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^()\s]*)/gu)].map((m) => m[1] as string),
      ...[...line.matchAll(/^ {0,3}\[(?:[^\]\\]|\\.)+\]:\s*(<[^>]*>|\S+)/gu)].map((m) => m[1] as string),
      ...[...line.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)].map((m) => (m[1] ?? m[2]) as string),
    ];
    for (const raw of targets) {
      const target = raw.startsWith('<') ? raw.slice(1, -1) : raw;
      if (target === '' || target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(target)) {
        continue;
      }
      let path: string;
      try {
        path = decodeURIComponent(target.split('#')[0]!.split('?')[0]!);
      } catch {
        path = target.split('#')[0]!.split('?')[0]!;
      }
      if (path === '') continue;
      const rel = relative(root, resolve(root, dirname(doc), path)).replaceAll('\\', '/').replace(/\/$/u, '');
      found.push({ doc, line: index + 1, target, resolved: rel === '' || rel.startsWith('..') ? null : rel });
    }
  }
  return found;
}

function deadShippedDocLinks(
  links: readonly DocLink[],
  ships: (path: string) => boolean,
  inRepository: (path: string) => boolean,
): DocLink[] {
  return links.filter(
    (link) => link.resolved === null || !(link.doc === 'README.md' ? inRepository(link.resolved) : ships(link.resolved)),
  );
}

/** What `tar -xzf` puts in `into`, as sorted relative file paths. */
function unpack(tgz: string, into: string): string[] {
  mkdirSync(into, { recursive: true });
  const r = spawnSync('tar', ['-xzf', tgz, '-C', into], { encoding: 'utf8' });
  expect(r.status, `tar -xzf ${tgz}: ${r.stderr}`).toBe(0);
  return readdirSync(into, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .filter((path) => !statSync(resolve(into, path)).isDirectory())
    .sort();
}

test('the real tarball includes every library output and shipped reference doc, excludes planted dev assets, and has no dead relative links', () => {
  const source = resolve(sandbox, 'contaminated-package');
  mkdirSync(source, { recursive: true });
  cpSync(pkgDist, resolve(source, 'dist'), { recursive: true });
  cpSync(resolve(repoRoot, 'skills'), resolve(source, 'skills'), { recursive: true });
  for (const file of [...NPM_ALWAYS_SHIPS, 'NOTICE.md', ...SHIPPED_DOCS]) {
    const dest = resolve(source, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(resolve(repoRoot, file), dest);
  }
  // A clean build alone cannot hold the npm allowlist: the checkout can have
  // a Vite demo build, whose official oracle bundle must never be published.
  // Plant both bundled JS and declarations outside the library's exact set,
  // plus repository-only docs that must stay out of the tarball.
  for (const [file, content] of [
    ['dist/assets/official-runtime.js', "export class SkeletonJson {} // dev oracle sentinel\n"],
    ['dist/officialOracle.d.ts', "export { SkeletonJson } from '@esotericsoftware/spine-webgl';\n"],
    ['dist/main.d.ts', 'export declare const demo: true;\n'],
    ['dist/oracle.html', '<script src="assets/official-runtime.js"></script>\n'],
    ['dist/rigs/fixture/skeleton.json', '{"skeleton":{"spine":"4.3.13"}}\n'],
    ['docs/TESTING.md', '# Testing\n'],
    ['docs/BENCHMARK.md', '# Benchmark\n'],
    ['RELEASING.md', '# Releasing\n'],
  ]) {
    const path = resolve(source, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const destination = resolve(sandbox, 'contaminated-tarball');
  const packed = node([resolve(repoRoot, 'scripts/pack-release.mjs'), destination, source], sandbox);
  expect(packed.status, `${packed.stdout}${packed.stderr}`).toBe(0);
  const libraryFiles = readdirSync(pkgDist).map(String).sort();
  const expected = [
    ...NPM_ALWAYS_SHIPS,
    'NOTICE.md',
    ...SHIPPED_DOCS,
    'skills/rig-play/SKILL.md',
    ...libraryFiles.map((file) => `dist/${file}`),
  ].sort();
  const extracted = resolve(sandbox, 'contaminated-read');
  const actual = unpack(packed.stdout.trim(), extracted);
  expect(actual).toEqual(expected.map((file) => `package/${file}`));

  // Relative link control across every packed markdown document (PKG02 / PKG03).
  // README.md is rendered against the repository on the package page, so its
  // relative links are checked against tracked repository files; every other
  // shipped doc is read from an installed copy and must target a packed file
  // or use an absolute URL.
  const packedSet = new Set(actual.map((file) => file.replace(/^package\//u, '')));
  const trackedSet = new Set(trackedFiles(repoRoot));
  const shipsInTarball = (path: string) =>
    packedSet.has(path) || [...packedSet].some((file) => file.startsWith(`${path}/`));
  const inRepository = (path: string) =>
    trackedSet.has(path) || [...trackedSet].some((file) => file.startsWith(`${path}/`));

  const packedDocs = [...packedSet].filter((file) => file.endsWith('.md')).sort();
  expect(packedDocs).toEqual(['NOTICE.md', 'README.md', ...SHIPPED_DOCS, 'skills/rig-play/SKILL.md'].sort());
  const links = packedDocs.flatMap((doc) =>
    relativeLinksInText(repoRoot, doc, readFileSync(resolve(extracted, 'package', doc), 'utf8')),
  );
  expect(links.length).toBeGreaterThan(0);
  expect(links.some((link) => link.doc === 'README.md' && !shipsInTarball(link.resolved ?? ''))).toBe(true);
  expect(links.some((link) => link.doc !== 'README.md' && shipsInTarball(link.resolved ?? ''))).toBe(true);
  const dead = deadShippedDocLinks(links, shipsInTarball, inRepository);
  expect(
    dead.map((link) => `${link.doc}:${link.line} ${link.target} -> ${String(link.resolved)}`),
  ).toEqual([]);

  // Planted red controls for each rule:
  // 1. README.md relative link to an unshipped but tracked file passes; an untracked path or escape turns red.
  // 2. Any other shipped doc relative link to a tracked-but-unshipped file or escape turns red.
  const plantedLinks = [
    ...relativeLinksInText(
      repoRoot,
      'README.md',
      '[shipped](docs/REFERENCE.md) [tracked-only](docs/BENCHMARK.md#measured) [untracked](docs/NO_SUCH_DOC.md) [escape](../outside.md)',
    ),
    ...relativeLinksInText(
      repoRoot,
      'docs/REFERENCE.md',
      '[shipped](STABILITY.md#turn-dials) [unshipped](TESTING.md) [sample](../samples/composed-take.ts) [escape](../../outside.md)',
    ),
  ];
  expect(
    deadShippedDocLinks(plantedLinks, shipsInTarball, inRepository).map(
      (link) => `${link.doc} -> ${link.target} (${String(link.resolved)})`,
    ),
  ).toEqual([
    'README.md -> docs/NO_SUCH_DOC.md (docs/NO_SUCH_DOC.md)',
    'README.md -> ../outside.md (null)',
    'docs/REFERENCE.md -> TESTING.md (docs/TESTING.md)',
    'docs/REFERENCE.md -> ../samples/composed-take.ts (samples/composed-take.ts)',
    'docs/REFERENCE.md -> ../../outside.md (null)',
  ]);

  const checkoutManifest = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'));
  const releaseManifest = JSON.parse(readFileSync(resolve(extracted, 'package/package.json'), 'utf8'));
  expect(checkoutManifest.exports['.']['@rig-c/source']).toBe('./src/index.ts');
  expect(checkoutManifest.exports['./composed-take']['@rig-c/source']).toBe('./src/composed-take.ts');
  expect(releaseManifest.exports).toEqual(PACKED_EXPORTS);
  for (const file of libraryFiles) {
    expect(readFileSync(resolve(extracted, 'package/dist', file)).equals(readFileSync(resolve(pkgDist, file))), file).toBe(true);
  }
});

test('release packing refuses a missing shared runtime or composed entry before creating a tarball', () => {
  const source = resolve(sandbox, 'incomplete-release');
  const destination = resolve(sandbox, 'incomplete-release-output');
  mkdirSync(source);
  cpSync(pkgDist, resolve(source, 'dist'), { recursive: true });
  cpSync(resolve(repoRoot, 'package.json'), resolve(source, 'package.json'));
  for (const [file, error] of [
    ['_play-runtime.js', 'Missing release file dist/_play-runtime.js'],
    ['composed-take.js', 'Missing release entry ./dist/composed-take.js'],
    ['composed-take.d.ts', 'Missing release entry ./dist/composed-take.d.ts'],
  ]) {
    const missing = resolve(source, 'dist', file);
    const bytes = readFileSync(missing);
    rmSync(missing);
    try {
      const run = node([resolve(repoRoot, 'scripts/pack-release.mjs'), destination, source], sandbox);
      expect(run.status, file).toBe(1);
      expect(run.stderr, file).toContain(error);
      expect(existsSync(destination), file).toBe(false);
    } finally {
      writeFileSync(missing, bytes);
    }
  }
});

for (const ALIAS of ALIASES) test(`the ${ALIAS} tarball is the package tarball under that earlier name, and nothing else`, () => {
  // The package directory npm would pack, from the temp build: the real
  // manifest and the files its `files` list and npm's own rules take.
  const src = resolve(sandbox, `alias-src-${ALIAS}`);
  mkdirSync(src, { recursive: true });
  cpSync(pkgDist, resolve(src, 'dist'), { recursive: true });
  cpSync(resolve(repoRoot, 'skills'), resolve(src, 'skills'), { recursive: true });
  for (const file of [...NPM_ALWAYS_SHIPS, 'NOTICE.md', ...SHIPPED_DOCS]) {
    const dest = resolve(src, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(resolve(repoRoot, file), dest);
  }
  const primaryDir = resolve(sandbox, `alias-primary-${ALIAS}`);
  const packed = node([resolve(repoRoot, 'scripts/pack-release.mjs'), primaryDir, src], sandbox);
  expect(packed.status, `release pack failed:\n${packed.stdout}${packed.stderr}`).toBe(0);
  const primary = packed.stdout.trim();

  const made = node([aliasScript, 'pack', '--alias', ALIAS, '--tarball', primary, '--out', resolve(sandbox, `alias-out-${ALIAS}`)], sandbox);
  expect(made.status, `alias-tarball pack failed:\n${made.stdout}${made.stderr}`).toBe(0);
  expect(made.stderr).toContain(`PASS  ALIAS_SAME_CONTENT: ${ALIAS} carries the`);
  const aliasTgz = made.stdout.trim().split('\n').pop() as string;
  expect(existsSync(aliasTgz), aliasTgz).toBe(true);

  // Read independently of the script: the same paths, every file the same
  // bytes, and in the manifest exactly one line apart — the name.
  const a = resolve(sandbox, `alias-read-${ALIAS}`, 'package');
  const b = resolve(sandbox, `alias-read-${ALIAS}`, 'alias');
  const left = unpack(primary, a);
  const right = unpack(aliasTgz, b);
  expect(right).toEqual(left);
  expect(left).toContain('package/NOTICE.md');
  expect(left).toContain('package/dist/index.js');
  for (const path of left) {
    if (path === 'package/package.json') continue;
    expect(readFileSync(resolve(b, path)).equals(readFileSync(resolve(a, path))), path).toBe(true);
  }
  const mine = readFileSync(resolve(a, 'package/package.json'), 'utf8').split('\n');
  const theirs = readFileSync(resolve(b, 'package/package.json'), 'utf8').split('\n');
  expect(theirs.length).toBe(mine.length);
  const differing = mine.flatMap((line, i) => (line === theirs[i] ? [] : [[line, theirs[i]]]));
  expect(differing).toEqual([['  "name": "@rig-c/play",', `  "name": "${ALIAS}",`]]);

  // The comparison can fail: one byte changed in the bundle is named by path.
  const planted = resolve(sandbox, `alias-planted-${ALIAS}`);
  unpack(aliasTgz, planted);
  const bundle = resolve(planted, 'package/dist/index.js');
  const bytes = readFileSync(bundle);
  bytes[bytes.length - 2] ^= 1;
  writeFileSync(bundle, bytes);
  const plantedTgz = resolve(sandbox, `alias-planted-${ALIAS}.tgz`);
  expect(spawnSync('tar', ['-czf', plantedTgz, '-C', planted, 'package']).status).toBe(0);
  const caught = node([aliasScript, 'compare', primary, plantedTgz], sandbox);
  expect(caught.status, caught.stdout + caught.stderr).toBe(1);
  expect(caught.stdout).toContain('package/dist/index.js differs');

  // And a tarball under the package's own name is not an alias of it.
  const self = node([aliasScript, 'compare', primary, primary], sandbox);
  expect(self.status, self.stdout + self.stderr).toBe(1);
});

/** Strips `//` and `/* *\/` comments without eating string or template contents. */
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

/** Module specifiers of every static import / re-export in `code`. */
function specifiers(code: string): string[] {
  const pattern =
    /(?:\bimport\b|\bexport\b)[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  return [...code.matchAll(pattern)].map((match) => (match[1] ?? match[2]) as string);
}

/**
 * Transitive relative-import graph of `entry`, resolved the way node's ESM
 * resolver does it: a relative specifier is a path, taken literally.
 */
function walkGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    seen.set(file, code);
    for (const spec of specifiers(code)) {
      if (!spec.startsWith('.')) continue;
      const path = resolve(dirname(file), spec);
      expect(existsSync(path), `${file} imports missing ${spec}`).toBe(true);
      queue.push(path);
    }
  }
  return seen;
}

test('both public entries share one self-contained runtime', () => {
  const runtimeFile = resolve(pkgDist, '_play-runtime.js');
  const name = (file: string) => relative(pkgDist, file);
  for (const entry of ['index.js', 'composed-take.js']) {
    const entryFile = resolve(pkgDist, entry);
    const graph = walkGraph(entryFile);
    expect([...graph.keys()].map(name)).toEqual([entry, '_play-runtime.js']);
    expect([...new Set(specifiers(graph.get(entryFile)!))]).toEqual(['./_play-runtime.js']);
    const runtime = graph.get(runtimeFile)!;
    expect(specifiers(runtime)).toEqual([]);
    expect(runtime).toContain('function openTrack');
    for (const [file, code] of graph) {
      expect(code, name(file)).not.toMatch(/\bimport\s*\(|['"]node:/);
    }
  }
  const filesByModule = (source: string) => BUNDLED_MODULES.filter(file => {
    const map = JSON.parse(readFileSync(resolve(pkgDist, `${file}.map`), 'utf8')) as { sources: string[] };
    return map.sources.some(path => path.endsWith(`/src/${source}.ts`));
  });
  for (const source of ['CanvasRenderer', 'MeshGlBlitter', 'player']) {
    expect(filesByModule(source)).toEqual(['_play-runtime.js']);
  }
  for (const source of ['composed-camera', 'composed-take', 'scene-camera']) {
    expect(filesByModule(source)).toEqual(['composed-take.js']);
  }
  // The shipped types name nothing a consumer does not have — the adapter's
  // rig-c types are `@internal` and stripped (tsconfig.build.json).
  const declarations = readdirSync(pkgDist).filter((file) => file.endsWith('.d.ts'));
  const namingRigc = declarations.filter((file) => /rig-c/.test(stripComments(readFileSync(resolve(pkgDist, file), 'utf8'))));
  expect(namingRigc).toEqual([]);
});

/**
 * The consumer both typecheck modes compile: every name the `exports` map
 * offers, reached by package name through the shipped `.d.ts`.
 */
const CONSUMER_SOURCE = [
  "import { CanvasRenderer, discoverTurnDials, DomRenderer, loadModel, normalizedDial, readSetupMesh, revokeRegions, RigPlayer, unpackRegions } from '@rig-c/play';",
  "import type { ModelAssets, PosedFrame, PosedSlot, RigPlayerOptions, SlotIdentity, SlotIdentityReason, SlotIdentitySnapshot } from '@rig-c/play';",
  "import type { BoneAdjust, BoneAdjustContext, PhysicsParameters, PhysicsParameterPatch, PhysicsParameterRead } from '@rig-c/play';",
  "import type { TurnAxis, TurnDial } from '@rig-c/play';",
  "import { ComposedTakeError, mountComposedTake, type CameraMode, type ComposedPlane, type ComposedTakeOptions, type MountedTake } from '@rig-c/play/composed-take';",
  "import { bindSceneCamera, renderSceneCameraFrame, SCENE_CAMERA_REPORT_MAX_BYTES, sceneCameraProjection, type BoundSceneCamera, type SceneCameraClock, type SceneCameraFrame } from '@rig-c/play/composed-take';",
  'export const reportBudget: number = SCENE_CAMERA_REPORT_MAX_BYTES;',
  "const backdrop: ComposedPlane = { role: 'backdrop', slots: ['backdrop'] };",
  "const options: ComposedTakeOptions = { modelUrl: '/take/skeleton.model.json', animation: 'idle', loop: true, planes: { backdrop, figure: { role: 'figure', slots: ['body'] } } };",
  "export async function mountNamed(root: HTMLElement, mode: CameraMode): Promise<MountedTake> { const take = await mountComposedTake(root, { ...options, camera: mode }); const player: RigPlayer = take.player; const refusal: ComposedTakeError | null = take.refusal; void player; void refusal; return take; }",
  "export const mountOneShot = (root: HTMLElement) => mountComposedTake(root, { ...options, sceneReportUrl: '/take/scene.json', loop: false });",
  'export function drawAuthored(renderer: CanvasRenderer, pose: PosedFrame, report: unknown, assets: ModelAssets, sha256: string): SceneCameraFrame | null {',
  '  const bound: BoundSceneCamera | null = bindSceneCamera(report, { sha256, stage: assets.stage, animations: assets.animations });',
  "  const clock: SceneCameraClock = { endpoint: 'terminal' };",
  '  const sample = bound?.sample(options.animation, clock) ?? null;',
  '  if (sample) {',
  '    renderSceneCameraFrame(renderer, pose, sample, { width: 128, height: 128 });',
  '    const projection = sceneCameraProjection(sample);',
  '    projection.outputToWorld(projection.worldToOutput({ x: 0, y: 0 }));',
  '  }',
  '  return sample;',
  '}',
  "const slots = { background: ['backdrop'], figure: ['body'] };",
  "const legacy = { modelUrl: '/take/skeleton.model.json', animation: 'idle', loop: true as const, slots };",
  '// @ts-expect-error the published mount requires named planes',
  'export const mountLegacy = (root: HTMLElement) => mountComposedTake(root, legacy);',
  '// @ts-expect-error legacy slots are absent from the public options',
  'export const legacyOptions: ComposedTakeOptions = legacy;',
  '// @ts-expect-error named plane options do not accept a legacy slot partition',
  'export const mountMixed = (root: HTMLElement) => mountComposedTake(root, { ...options, slots });',
  'export function turn(model: unknown, assets: ModelAssets, input: Partial<Record<TurnAxis, number>>): BoneAdjust { const dials: TurnDial[] = discoverTurnDials(model, assets.animations); return bones => { for (const dial of dials) bones.bone(dial.bone)[dial.channel] = normalizedDial(input[dial.axis] ?? 0, dial); }; }',
  "export const unaryAdjust: BoneAdjust = bones => { bones.bone('root').rotation = 3; };",
  "export const contextualAdjust: BoneAdjust = (bones, ctx: BoneAdjustContext) => { const time: number | null = ctx.trackTime; const animation: string | null = ctx.animation; const global: number = ctx.globalTime; bones.bone('root').rotation = time ?? global; void animation; };",
  "export function physics(p: RigPlayer): PhysicsParameterRead { const patch: PhysicsParameterPatch = { strength: 2, damping: 0.4, inertia: 1, wind: 0, gravity: 3, mix: 0.5 }; p.setPhysicsParameters('cloth', patch); const read: PhysicsParameterRead = p.readPhysicsParameters('cloth'); const effective: PhysicsParameters | null = read.effective; p.clearPhysicsParameters('cloth'); void effective; return read; }",
  '// @ts-expect-error public parameter fields are readonly',
  'export function readonlyParameters(p: PhysicsParameters): void { p.damping = 1; }',
  '// @ts-expect-error public context fields are readonly',
  'export function readonlyContext(c: BoneAdjustContext): void { c.trackTime = 1; }',
  'export const surface = [CanvasRenderer, DomRenderer, RigPlayer, loadModel, unpackRegions, revokeRegions];',
  "import type { SetupMesh, SetupMeshTarget } from '@rig-c/play';",
  'export function setup(assets: ModelAssets, target: SetupMeshTarget): SetupMesh { const m = readSetupMesh(assets, target); const xy: number[] = m.vertices; const triangles: number[] = m.triangles; const hull: number | null = m.hull; return { ...m, vertices: xy, triangles, hull }; }',
  "export const targets: SetupMeshTarget[] = [{ slot: 's', attachment: 'm' }, { slot: 's', attachment: 'm', skin: null }, { slot: 's', attachment: 'm', skin: 'all' }];",
  'export function drawCanvas(renderer: CanvasRenderer, frame: PosedFrame): number { renderer.render(frame); return renderer.drawCalls; }',
  'export function draw(renderer: DomRenderer, frame: PosedFrame): PosedSlot[] { renderer.render(frame); return frame.order; }',
  'export function play(root: HTMLElement, assets: ModelAssets, options: RigPlayerOptions): RigPlayer { const p = new RigPlayer(root, assets, options); p.play(assets.animations[0].name, { loop: true }); return p; }',
  'export function inspectSlots(player: RigPlayer): { snap: SlotIdentitySnapshot; first: SlotIdentity | undefined; reason: SlotIdentityReason | null | undefined } { const snap = player.slotIdentity(); return { snap, first: snap.slots[0], reason: snap.slots[0]?.reason }; }',
  '',
].join('\n');

test('the emitted types resolve under bundler', async () => {
  const result = await nodeAsync(
    [tscBin, '--noEmit', '-p', writeConsumer('consumer', CONSUMER_SOURCE, 'bundler')],
    sandbox,
  );
  expect(result.status, `tsc under moduleResolution=bundler failed:\n${result.output}`).toBe(0);
});

test('the emitted types resolve under nodenext', async () => {
  // The .js in the source specifiers has to survive into the .d.ts too: a
  // node16/nodenext consumer resolves `./DomTexture.js` to `./DomTexture.d.ts`
  // and rejects the extensionless form with TS2835.
  const result = await nodeAsync(
    [tscBin, '--noEmit', '-p', writeConsumer('consumer', CONSUMER_SOURCE, 'nodenext')],
    sandbox,
  );
  expect(result.status, `tsc under moduleResolution=nodenext failed:\n${result.output}`).toBe(0);
});
