// Create the publishable npm tarball without editing the checkout manifest.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function npmPack(cwd, ...args) {
  return execFileSync('npm', ['pack', '--ignore-scripts', '--loglevel=error', ...args], {
    cwd, encoding: 'utf8',
  });
}

function packRelease(source, destination) {
  // Let npm select the files, including its implicit README and LICENSE.
  const list = JSON.parse(npmPack(source, '--dry-run', '--json'));
  // npm 10 emits an array. npm 12 keys the result by package name.
  const [pack] = Object.values(list);
  const paths = new Set(pack.files.map(({ path }) => path));
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const subpath of ['.', './composed-take']) {
    for (const condition of ['import', 'types']) {
      const target = manifest.exports?.[subpath]?.[condition];
      if (typeof target !== 'string' || !target.startsWith('./dist/') || !paths.has(target.slice(2))) {
        throw new Error(`Missing release entry ${target ?? `${subpath} (${condition})`}. Run npm run build:lib first.`);
      }
    }
  }
  const libraryFiles = new Set(['dist/_play-runtime.js', ...manifest.files.filter(path => path.startsWith('dist/'))]);
  for (const path of libraryFiles) {
    if (!paths.has(path)) throw new Error(`Missing release file ${path}. Run npm run build:lib first.`);
  }
  for (const entry of Object.values(manifest.exports)) delete entry['@rig-c/source'];

  const stage = mkdtempSync(join(tmpdir(), 'play-release-pack-'));
  try {
    for (const path of paths) {
      if (path === 'package.json') continue;
      const target = join(stage, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(source, path), target);
    }
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    mkdirSync(destination, { recursive: true });
    const filename = npmPack(stage, '--pack-destination', destination).trim();
    return join(destination, filename);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const [out, source = '.'] = process.argv.slice(2);
if (!out) {
  console.error('Usage: node scripts/pack-release.mjs <outDir> [packageDir]');
  process.exit(1);
}
console.log(packRelease(resolve(source), resolve(out)));
