import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng } from '@rig-c/core/plate';

const root = process.argv[2];
const read = (name) => readFileSync(join(root, name));
const put = (name, value) => writeFileSync(join(root, name), value);
const original = decodePng(read('inputs/background.png'));
if (original.width !== 128 || original.height !== 128) throw Error('Unexpected public backdrop size');
const overscan = new Uint8Array(158 * 158 * 4);
let nonOpaque = 0;
// Extend the public edge texels in source artwork before authoring a named Parts plate.
for (let y = 0; y < 158; y++) {
  for (let x = 0; x < 158; x++) {
    const sourceX = Math.min(127, Math.max(0, x - 15));
    const sourceY = Math.min(127, Math.max(0, y - 15));
    const index = 4 * (sourceY * 128 + sourceX);
    overscan.set(original.data.subarray(index, index + 4), 4 * (y * 158 + x));
    nonOpaque += Number(original.data[index + 3] !== 255);
  }
}
if (nonOpaque) throw Error('Public backdrop is not opaque');
put('inputs/background-overscan.png', encodePng(158, 158, overscan));
const scene = JSON.parse(read('compose.scene.json').toString());
scene.plates[0].image = 'inputs/background-overscan.png';
scene.plates[0].at = [-15, -15];
put('overscan.scene.json', JSON.stringify(scene, null, 2) + '\n');
scene.characters[0].offset = [-8, 0];
scene.characters[0].canvas_clip = true;
put('clip.scene.json', JSON.stringify(scene, null, 2) + '\n');
