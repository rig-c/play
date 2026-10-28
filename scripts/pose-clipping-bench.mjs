/** Clipping input adapter for core#1589's unchanged timing/step helpers. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadavg } from 'node:os';
import { openTrack, readModel, underSkin } from 'rig-c/core';
import { mismatch } from '../tests/liveFrameProbe.ts';

if (process.argv.includes('--help')) {
  console.log('bun scripts/pose-clipping-bench.mjs <fixture-dir> <external-scratch-dir> <out.json> [--dry-run]');
  process.exit(0);
}
const [fixtureArg, scratchArg, output] = process.argv.slice(2);
if (!fixtureArg || !scratchArg || !output) throw Error('CLIP_BENCH_ARGUMENTS');
const fixture = resolve(fixtureArg), scratch = resolve(scratchArg);
const revision = 'e8dfbd64dbf8e48c11052314668214c719973d17';
const sourceHash = 'ee8bb6358d83f668f9069acdfa4d26d8b341cc8723fb12dfa33ed642c67b5078';
const response = await fetch(`https://raw.githubusercontent.com/rig-c/core/${revision}/tools/pose_bench.ts`);
if (!response.ok) throw Error(`CLIP_BENCH_FETCH: ${response.status}`);
const original = await response.text();
if (createHash('sha256').update(original).digest('hex') !== sourceHash) throw Error('CLIP_BENCH_SOURCE_HASH');
const replacements = {
  '@esotericsoftware/spine-core': Bun.resolveSync('@esotericsoftware/spine-core', process.cwd()),
  '../src/core/entry.ts': resolve('node_modules/rig-c/src/core/entry.ts'),
  '../src/core/index.ts': resolve('node_modules/rig-c/src/core/index.ts'),
  '../src/core/world.ts': resolve('node_modules/rig-c/src/core/world.ts'),
  '../src/model.ts': resolve('node_modules/rig-c/src/model.ts'),
};
let source = original;
for (const [from, to] of Object.entries(replacements)) source = source.replace(`'${from}'`, JSON.stringify(pathToFileURL(to).href));
mkdirSync(scratch, { recursive: true });
const moduleFile = join(scratch, 'pose_bench.ts');
writeFileSync(moduleFile, source);
const tool = await import(pathToFileURL(moduleFile).href);
const modelText = readFileSync(join(fixture, 'skeleton.model.json'), 'utf8');
const spineText = readFileSync(join(fixture, 'skeleton.json'), 'utf8');
const atlasText = readFileSync(join(fixture, 'skeleton.atlas'), 'utf8');
const parsed = JSON.parse(modelText), animation = 'mask';
const view = underSkin(readModel(modelText), 'default');
const healthy = openTrack(view, animation, { loop: true, reset: 'setup' });
const instrumented = tool.createRigArm(modelText, parsed, 1, { label: 'rig-c' }, animation);
const spine = tool.createSpineInstances(spineText, atlasText, 1, animation);
for (let f = 0; f < 60; f++) {
  const a = f ? healthy.step(1 / 60) : healthy.first;
  const b = f ? instrumented.tracks[0].step(1 / 60) : instrumented.tracks[0].first;
  const diff = mismatch(a, b);
  if (diff) throw Error(`CLIP_BENCH_INSTRUMENTATION: ${diff}`);
}
// openTrack.first is the setup pose. Attachment timelines apply on step().
if (!healthy.step(1 / 60).clips.length) throw Error('CLIP_BENCH_NO_ACTIVE_CLIP');
const result = { protocol: 'pose-clipping-core1589-v1', revision, sourceHash, importReplacementsOnly: replacements,
  modelSha256: createHash('sha256').update(modelText).digest('hex'), animation, instrumentationEqualFrames: 60,
  boundary: 'core oracle/openTrack plus frameOfPost199; not the runtime live-buffer loop; CPU only, reported not barred',
  beforeLoad: loadavg(), dryRun: process.argv.includes('--dry-run'), launches: [] };
if (!result.dryRun) {
  const keys = [...tool.RIG_STAGES, 'total'];
  const groups = tool.MAPPED_GROUPS;
  const run = self => {
    const b = tool.createRigArm(modelText, parsed, 1, { label: 'rig-c' }, animation);
    const a = self ? tool.createRigArm(modelText, parsed, 1, { label: 'rig-c AA' }, animation) : tool.createSpineInstances(spineText, atlasText, 1, animation);
    const as = {}, bs = {};
    const stepA = () => self ? tool.stepRigArm(a, 1 / 60, as, 16) : tool.stepSpineArm(a, 1 / 60, as, 16);
    const stepB = () => tool.stepRigArm(b, 1 / 60, bs, 16);
    for (let f = 0; f < 60; f++) { stepA(); stepB(); }
    Bun.gc(true);
    const seriesA = Object.fromEntries(groups.map(k => [k, []])), seriesB = Object.fromEntries(groups.map(k => [k, []]));
    const rigSeries = Object.fromEntries(keys.map(k => [k, []]));
    for (let f = 0; f < 240; f++) {
      if (f % 2) { stepB(); stepA(); } else { stepA(); stepB(); }
      const map = (x, rig) => ({ timeline: x.timeline, 'world+constraints': x.world + (rig ? x.constraints : 0), 'geometry+readout+frame': x.geometry + (rig ? x.readout + x.frame : 0), total: Object.values(x).reduce((n, v) => n + v, 0) });
      const ma = map(as, self), mb = map(bs, true);
      for (const key of groups) { seriesA[key].push(ma[key]); seriesB[key].push(mb[key]); }
      for (const key of keys) rigSeries[key].push(key === 'total' ? mb.total : bs[key]);
    }
    return { control: self ? 'AA' : 'AB', frames: 240, warmup: 60, instances: 1, subSteps: 16, interleave: 'AB,BA each frame',
      mappedRows: tool.buildPairedRows(groups, seriesA, seriesB), rigStages: Object.fromEntries(keys.map(k => [k, tool.computeStats(rigSeries[k])])) };
  };
  let target = 2;
  for (let i = 0; i < target; i++) {
    result.launches.push({ aa: run(true), ab: run(false) });
    if (i + 1 === target && target < 8) {
      const totals = result.launches.map(x => x.ab.mappedRows.find(r => r.stage === 'total').delta.p50);
      const spread = Math.abs(Math.max(...totals) - Math.min(...totals)) / Math.max(Math.abs(tool.computeStats(totals).p50), 1e-9);
      if (spread > .1) target *= 2;
    }
  }
}
result.afterLoad = loadavg();
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log('CLIPPING_STAGE_BENCH', JSON.stringify({ sourceHash, dryRun: result.dryRun, launches: result.launches.length, instrumentationEqualFrames: 60 }));
