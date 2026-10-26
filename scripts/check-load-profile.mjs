import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadProfilePlugin } from '../bench/load-profile-plugin.ts';
import { loadConfigFromFile } from 'vite';

const transform = loadProfilePlugin().transform;
const source = readFileSync('src/loadModel.ts', 'utf8');
const instrumented = transform(source, '/src/loadModel.ts');
assert.match(instrumented, /__async\('model-fetch-body'/);
assert.match(instrumented, /__sync\('sequence-json-parse'/);
assert.throws(() => transform(source.replace('readModel(text, where)', 'changedBoundary(text, where)'), '/src/loadModel.ts'), /LOAD_PROFILE_BOUNDARY/);
assert.throws(() => transform(source + '\nreadModel(text, where)', '/src/loadModel.ts'), /LOAD_PROFILE_BOUNDARY/);
assert.equal(transform(source, '/src/player.ts'), undefined);
const texture = readFileSync('src/DomTexture.ts', 'utf8');
const textureProfile = transform(texture, '/src/DomTexture.ts');
for (const phase of ['page-unpremultiply', 'page-readback', 'page-unpremultiply-loop', 'page-writeback', 'region-draw-submit', 'region-png-encode-wait']) assert.ok(textureProfile.includes(`'${phase}'`));
assert.throws(() => transform(texture.replace('unpremultiply(page, width, height);', 'changedBoundary();'), '/src/DomTexture.ts'), /LOAD_PROFILE_BOUNDARY/);
assert.throws(() => transform(texture + '\nunpremultiply(page, width, height);', '/src/DomTexture.ts'), /LOAD_PROFILE_BOUNDARY/);
const core = readFileSync('node_modules/rig-c/src/core/index.ts', 'utf8');
assert.match(transform(core, '/node_modules/rig-c/src/core/index.ts'), /__sync\('core-json-parse'/);
console.log('load profile: real loader/core boundaries instrumented; missing/duplicate boundary plants refused; unrelated modules untouched');
const previous = process.env.LOAD_PROFILE;
try {
  for (const [flag, entry] of [['0', 'index.html'], ['1', 'load.html']]) {
    process.env.LOAD_PROFILE = flag;
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, 'bench/vite.config.ts');
    assert.ok(loaded);
    assert.equal(loaded.config.optimizeDeps.entries.length, 1);
    assert.ok(loaded.config.optimizeDeps.entries[0].endsWith(`/${entry}`));
    assert.equal(loaded.config.plugins.length, flag === '1' ? 1 : 0);
    assert.deepEqual(loaded.config.optimizeDeps.exclude, flag === '1' ? ['rig-c/core', '@esotericsoftware/spine-webgl'] : []);
  }
} finally {
  if (previous === undefined) delete process.env.LOAD_PROFILE;
  else process.env.LOAD_PROFILE = previous;
}
console.log('load profile: normal and optional Vite entry graphs stay separate');
