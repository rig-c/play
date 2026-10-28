/** CPU-only selection and exact-frame census; never draws or claims pixels. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.includes('--help')) {
  console.log('bun scripts/runtime-corpus.mjs --fixtures <public-dir> --player <checkout> --out <json> [--dry-run]');
  process.exit(0);
}
const arg = name => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw Error(`CORPUS_ARGUMENT: ${name} required`);
  return resolve(process.argv[i + 1]);
};
const fixtures = arg('--fixtures'), playerRoot = arg('--player'), out = arg('--out');
const { RigPlayer } = await import(pathToFileURL(join(playerRoot, 'src/player.ts')).href);
const { readModelText } = await import(pathToFileURL(join(playerRoot, 'src/loadModel.ts')).href);
const { mismatch } = await import(pathToFileURL(join(playerRoot, 'tests/liveFrameProbe.ts')).href);
const models = [];
for (const group of ['rigs', 'bench']) {
  for (const name of readdirSync(join(fixtures, group)).sort()) {
    const file = join(fixtures, group, name, 'skeleton.model.json');
    if (existsSync(file) && statSync(file).isFile()) models.push({ rig: `${group}/${name}`, file });
  }
}
if (!models.length) throw Error('CORPUS_EMPTY');
const rows = [], inputs = [];
for (const { rig, file } of models) {
  const text = readFileSync(file, 'utf8');
  const document = readModelText(text, file);
  for (const page of document.doc.pages) {
    const name = page.name;
    if (!existsSync(join(file, '..', name))) throw Error(`CORPUS_PAGE: ${rig}/${name}`);
  }
  inputs.push({ rig, model: relative(fixtures, file), sha256: createHash('sha256').update(text).digest('hex'), animations: document.doc.animations.map(a => a.name) });
  if (process.argv.includes('--dry-run')) continue;
  const assets = { spec: document.spec, document, animations: document.doc.animations.map(a => ({ name: a.name, duration: a.duration })), skins: document.doc.skins.map(s => s.name), sets: [], stage: null, regions: 'data', regionImages: new Map(), pageImages: new Map(), dispose() {} };
  if (!assets.animations.length) rows.push({ rig, animation: null, poser: null, status: 'no animation; not a runtime/fallback row', frames: 0 });
  for (const animation of assets.animations) {
    const candidate = new RigPlayer(Object.freeze({}), assets, { liveFrameChecks: false });
    const oracle = new RigPlayer(Object.freeze({}), assets, { poser: 'oracle' });
    const numeric = [], drawn = [];
    try {
      candidate.play(animation.name); oracle.play(animation.name);
      for (const dt of [0, .125, .375, .75]) {
        candidate.advance(dt); oracle.advance(dt);
        const frame = candidate.posedFrame();
        const difference = mismatch(frame, oracle.posedFrame());
        if (difference) numeric.push(difference);
        const identity = mismatch(candidate.slotIdentity(), oracle.slotIdentity(), 'identity');
        if (identity) numeric.push(identity);
        const view = candidate.liveFrame();
        if (view.count !== frame.order.length) numeric.push('live count differs');
        for (let i = 0; i < view.count; i++) {
          const attachment = view.attachments[view.drawOrder[i]], slot = frame.order[i];
          if (attachment.slot !== slot.slot) numeric.push('live slot differs');
          const points = slot.kind === 'region' ? slot.corners : slot.vertices;
          for (let c = 0; c < points.length; c++) if (!Object.is(view.vertices[attachment.offset + c], points[c])) numeric.push(`live vertex ${attachment.slot}[${c}] differs`);
          for (let c = 0; c < 4; c++) if (!Object.is(view.tint[attachment.slotIndex * 4 + c], slot.tint[c])) numeric.push(`live tint ${attachment.slot}[${c}] differs`);
        }
        drawn.push(frame.order.length);
      }
      rows.push({ rig, animation: animation.name, poser: candidate.poser, frames: 4, numeric, drawn, pixelStatus: 'not measured by CPU census' });
    } finally { candidate.dispose(); oracle.dispose(); }
  }
}
const result = { protocol: 'runtime-corpus-v1', rigc: JSON.parse(readFileSync(join(playerRoot, 'node_modules/rig-c/package.json'))).version, inputs, steps: [0, .125, .375, .75], trackTimes: [0, .125, .5, 1.25], tolerance: 'Object.is; zero', rows };
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log('RUNTIME_CORPUS', JSON.stringify({ models: inputs.length, rows: rows.length, runtime: rows.filter(r => r.poser === 'runtime').length, fallback: rows.filter(r => r.poser?.startsWith('oracle:')).length, numericDifferences: rows.reduce((n, r) => n + (r.numeric?.length ?? 0), 0), dryRun: process.argv.includes('--dry-run') }));
if (rows.some(r => r.numeric?.length)) process.exit(1);
