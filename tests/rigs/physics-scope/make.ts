/** Reproducible synthetic face/hair/body fixture. No rendering or build runs here. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from 'rig-c/plate';
import { PHYSICS_SCOPE_PROTOCOL as protocol, physicsScopeSample } from '../../physicsScopeProtocol';
const here = fileURLToPath(new URL('.', import.meta.url));
const dir = join(here, 'parts'); mkdirSync(dir, { recursive: true });
for (const [name, w, h] of [['head', 80, 80], ['hair', 12, 45], ['body', 30, 45]] as const) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let color = name === 'head' ? [247, 195, 157, 255] : name === 'hair' ? [73, 46, 86, 255] : [40, 130, 160, 255];
    if (name === 'head') {
      if ((x - 40) ** 2 / 38 ** 2 + (y - 40) ** 2 / 39 ** 2 > 1) color = [0, 0, 0, 0];
      else if (((x - 25) ** 2 + (y - 33) ** 2 < 15) || ((x - 55) ** 2 + (y - 33) ** 2 < 15)) color = [32, 27, 40, 255];
      else if (Math.abs(x - 40) < 2 && y > 37 && y < 48) color = [180, 90, 75, 255];
      else if (y > 55 && y < 59 && x > 29 && x < 52) color = [150, 45, 65, 255];
    }
    rgba.set(color, (y * w + x) * 4);
  }
  writeFileSync(join(dir, `${name}.png`), encodePng(w, h, rgba));
}
const rig = { spec: 'rigc-rig/1', name: 'physics-scope', images: 'parts', skeleton: { x: -130, y: 0, width: 280, height: 270 },
 bones: [{ name: 'root' }, { name: 'head', parent: 'root', y: 190 },
  { name: 'hair_1', parent: 'head', x: -28, y: 25, rotation: -90, length: 45 },
  { name: 'hair_2', parent: 'hair_1', x: 45, length: 45 }, { name: 'hair_tip', parent: 'hair_2', x: 45 },
  { name: 'body_root', parent: 'root', x: 65, y: 85, rotation: -90, length: 45 }, { name: 'body_tip', parent: 'body_root', x: 45 },
  { name: 'ik_target', parent: 'root', x: 65, y: 40 }, { name: 'transform_probe', parent: 'root', x: 10 }],
 constraints: [{ type: 'ik', name: 'body_ik', bones: ['body_root'], target: 'ik_target', mix: 1 },
  { type: 'transform', name: 'hair_1_phys', source: 'root', bones: ['transform_probe'], properties: { x: { to: { x: { scale: 1 } } } } }],
 slots: [{ name: 'head', bone: 'head', attachment: 'head' }, { name: 'hair_1', bone: 'hair_1', attachment: 'hair' },
  { name: 'hair_2', bone: 'hair_2', attachment: 'hair' }, { name: 'body', bone: 'body_root', attachment: 'body' }],
 skins: { default: { head: { head: { type: 'mesh', image: 'head.png', hull: 4, uvs: [0,0,1,0,1,1,0,1], vertices: [-40,40,40,40,40,-40,-40,-40], triangles: [0,1,2,0,2,3] } },
 hair_1: { hair: { image: 'hair.png', x: 22.5, rotation: -90 } }, hair_2: { hair: { image: 'hair.png', x: 22.5, rotation: -90 } }, body: { body: { image: 'body.png', x: 22.5, rotation: -90 } } } } };
const keys = Array.from({ length: protocol.frames + 1 }, (_, i) => ({ t: i * protocol.dt, ...physicsScopeSample(i) }));
const faceKeys = (translated: boolean) => keys.map((k) => ({ t: k.t, vertices: [-40,40,40,-40].flatMap((x) => [x * k.narrow + (translated ? k.x : 0), 0]) }));
const physics = Object.fromEntries([['hair_1_phys','hair_1'],['hair_2_phys','hair_2'],['body_phys','body_root']].map(([name,bone]) => [name,{ bone, rotate:1, inertia:0.5, strength:60, damping:0.8, mass:1, wind:0, gravity:0 }]));
const animation = (native: boolean) => ({ duration: protocol.frames * protocol.dt, loop: false,
 tracks: [{ bone:'head', property:'translate', keys: keys.map((k) => ({t:k.t,v:[native?k.x:0,0]})) }],
 deform: [{slot:'head', attachment:'head', keys:faceKeys(!native)}] });
const motion = {
 spec:'rigc-motion/1', archetype:'physics-scope', cut:'test-physics-scope', easings:{}, physics,
 animations: {
  native: animation(true), deform: animation(false),
  calm: { duration:2, loop:false, tracks:[{bone:'head',property:'translate',keys:[{t:0,v:[0,0]},{t:2,v:[0,0]}]}] },
 },
};
writeFileSync(join(here,'rig.json'),JSON.stringify(rig,null,2)+'\n');
writeFileSync(join(here,'motion.json'),JSON.stringify(motion,null,2)+'\n');
