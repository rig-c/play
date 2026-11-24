import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '@rig-c/core/plate';

const [root, fixture] = process.argv.slice(2);
const bytes = (path) => readFileSync(join(root, path));
const json = (path) => JSON.parse(bytes(path).toString());
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sha = (path) => hash(bytes(path));
const original = decodePng(bytes('inputs/background.png'));
const enlarged = decodePng(bytes('inputs/background-overscan.png'));
const plate = decodePng(bytes('overscan/rig/images/scene-plate.0.png'));
const figures = readdirSync(join(root, 'original/rig/images')).filter(name => name.startsWith('actor.') && name.endsWith('.png'));
assert.equal(figures.length, 6);
const modelPaths = ['original', 'overscan', 'clip'].map(name => {
  const scene = name === 'original' ? 'compose.scene.json' : name + '.scene.json';
  const run = json(name + '/compose-run.json');
  assert.equal(run.scene.sha256, sha(scene));
  for (const plate of run.plates) assert.equal(plate.sha256, sha(plate.path));
  assert.equal(json(name + '/check/check.json').PASS, true);
  const path = name + '/check/build/skeleton.model.json';
  assert.deepEqual(json(path).stage, { x: -64, y: 0, width: 128, height: 128 });
  return { name, scene, sceneSha256: run.scene.sha256, runSha256: sha(name + '/compose-run.json'), path, modelSha256: sha(path), atlasSha256: sha(name + '/check/build/skeleton.png') };
});

function centerDiff() {
  let changed = 0;
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const a = 4 * (y * 128 + x);
      const b = 4 * ((y + 15) * 158 + x + 15);
      changed += Number(original.data.subarray(a, a + 4).some((value, index) => value !== plate.data[b + index]));
    }
  }
  return changed;
}

assert.deepEqual([original.width, original.height], [128, 128]);
assert.deepEqual([enlarged.width, enlarged.height], [158, 158]);
assert.deepEqual([plate.width, plate.height], [158, 158]);
assert.equal(centerDiff(), 0);
assert.equal(plate.data.filter((alpha, i) => i % 4 === 3 && alpha !== 255).length, 0);
const originalFiles = [['scene.json', 'compose.scene.json'], ['plates/background.png', 'inputs/background.png'], ['plates/foreground.png', 'inputs/foreground.png']];
for (const [source, local] of originalFiles) assert.equal(hash(readFileSync(join(fixture, source))), sha(local));
const overscanScene = json('overscan.scene.json');
assert.deepEqual(overscanScene.plates[0].at, [-15, -15]);
const clip = json('clip/compose-run.json').characters[0].placement;
assert.deepEqual(clip, { canvas_clip: true, bounds: [-8, 0, 120, 128], clipped_bounds: [0, 0, 120, 128] });
const actorPngs = figures.map(name => {
  const files = ['original', 'overscan', 'clip'].map(variant => sha(`${variant}/rig/images/${name}`));
  assert.equal(new Set(files).size, 1);
  return { name, sha256: files[0] };
});
console.log(JSON.stringify({
  createCommit: 'ed949ef5a44e443a89f640ab0d6b8f8fac0ca1ae',
  parts: '2.54.0', producerCore: '3.8.1', originalFiles: Object.fromEntries(originalFiles.map(([a, b]) => [a, sha(b)])),
  overscan: { at: [-15, -15], width: 158, height: 158, nonOpaque: 0, centerChangedRgbaPixels: centerDiff(), partPngSha256: sha('overscan/rig/images/scene-plate.0.png') },
  clip, actorPngs, models: modelPaths,
}, null, 2));
