import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTrack, type RawPose, underNoSkin, underSkin } from 'rig-c/core';
import { parsePoseBenchArgs, posePlayer, readPoseAssets } from '../scripts/bench-pose';
import type { ReadDocument } from '../src/loadModel';
import { clipCover, frameOf, frameSource, type PosedFrame } from '../src/posedFrame';

// Executed only by Bun: the pinned core dependency exports TypeScript source.
// The Node Playwright entry launches each contract in its own child process.
const root = fileURLToPath(new URL('..', import.meta.url));
const assetsOf = (rig: string) => readPoseAssets(resolve(root, 'public/rigs', rig, 'skeleton.model.json'));

function scene(rig: string, animation: string, skin?: string) {
  const assets = assetsOf(rig);
  const read = assets.document as ReadDocument;
  const view = skin === undefined ? underNoSkin(read.doc) : underSkin(read.doc, skin);
  const source = frameSource(view, read.parsed);
  const track = openTrack(view, animation, { loop: true, reset: 'animation' });
  return { read, view, source, track };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const bytes = (frame: PosedFrame) => JSON.stringify(frame);

const contracts = new Map<string, () => void>();
const contract = (name: string, run: () => void) => { contracts.set(name, run); };

contract('snapshot-equality', () => {
  const cases = [
    scene('look-packed', 'turn'), scene('glow-packed', 'burn'),
    scene('figure-packed', 'walk'), scene('figure-packed', 'mask'),
    scene('figure-packed', 'nested'), scene('figure-packed', 'inverse'),
    scene('figure-packed', 'bare'), scene('figure-packed', 'walk', 'alt'),
    scene('draw', 'reorder', 'base'), scene('draw', 'window', 'base'),
    scene('draw', 'reorder', 'alt'), scene('draw', 'hidden'),
    scene('duo', 'shift'), scene('turned', 'hold'),
  ];
  const retained: Array<{ frame: PosedFrame; json: string }> = [];
  const pictures = new Set<string>();
  for (let n = 0; n < 96; n++) {
    // Alternate sources and views on every iteration, including inactive skin bones.
    for (const c of n % 2 ? [...cases].reverse() : cases) {
      const pose = freeze(n === 0 ? c.track.first : c.track.step(1 / 60));
      const before = JSON.stringify(pose);
      const color = [0.5 + n / 192, 0.75, 1, 0.9] as const;
      const draws = (slot: string) => n % 4 === 0 ? false : n % 4 === 1 ? !slot.startsWith('clip') : n % 4 === 2 ? !slot.includes('arm') : true;
      const expected = frameOf(frameSource(c.view, c.read.parsed), pose, color, draws);
      const actual = frameOf(c.source, pose, color, draws);
      expect(bytes(actual)).toBe(bytes(expected));
      expect(JSON.stringify(pose)).toBe(before);
      pictures.add(bytes(actual));
      if (n % 24 === 3) retained.push({ frame: freeze(actual), json: bytes(actual) });
    }
  }
  expect(pictures.size).toBeGreaterThan(100);
  for (const kept of retained) expect(bytes(kept.frame)).toBe(kept.json);
});

contract('snapshot-identity', () => {
  const c = scene('figure-packed', 'mask');
  const firstPose = freeze(c.track.first);
  const first = frameOf(c.source, firstPose);
  const again = frameOf(c.source, firstPose);
  const secondPose = freeze(c.track.step(1 / 60));
  const second = frameOf(c.source, secondPose);
  expect(first.order.length).toBeGreaterThan(5);
  expect(first.order.some((s) => s.kind === 'mesh')).toBe(true);
  expect(first.order.some((s) => s.kind === 'region')).toBe(true);
  expect(first.order.some((s) => s.clip)).toBe(true);
  expect(again).not.toBe(first);
  expect(again.order).not.toBe(first.order);
  for (const a of first.order) {
    const b = again.order.find((s) => s.slot === a.slot)!;
    const later = second.order.find((s) => s.slot === a.slot)!;
    const drawn = firstPose.drawn.find((d) => d.slot === a.slot)!;
    expect(b).not.toBe(a);
    expect(b.tint).not.toBe(a.tint);
    expect(a.kind === 'region' ? a.corners : a.vertices).toBe(drawn.vertices);
    expect(later.kind === 'region' ? later.corners : later.vertices).not.toBe(drawn.vertices);
    expect(b.uvs).toBe(a.uvs);
    expect(later.uvs).toBe(a.uvs);
    if (a.kind === 'mesh' && b.kind === 'mesh' && later.kind === 'mesh') {
      expect(b.triangles).toBe(a.triangles);
      expect(later.triangles).toBe(a.triangles);
    }
    if (a.clip) {
      expect(b.clip).not.toBe(a.clip);
      expect(later.clip).not.toBe(a.clip);
      expect(later.clip!.polygon).not.toBe(a.clip.polygon);
      expect(a.clip.polygon).toBe(firstPose.clips.find((p) => p[0] === 'clip')![3]);
      const peers = first.order.filter((s) => s.clip === a.clip);
      expect(peers.length).toBeGreaterThan(1);
    }
  }
});

contract('dynamic-indexes', () => {
  const c = scene('draw', 'window', 'base');
  const windowPose = c.track.first;
  const reorder = openTrack(c.view, 'reorder', { loop: false, reset: 'animation' });
  const early = reorder.first;
  const late = reorder.step(0.75);
  // Reuse the very same pose container and arrays; replace their contents.
  const held = structuredClone(windowPose);
  const setPose = (next: RawPose) => {
    held.drawOrder.splice(0, held.drawOrder.length, ...next.drawOrder);
    held.shown.splice(0, held.shown.length, ...next.shown);
    held.slots.splice(0, held.slots.length, ...next.slots);
    held.drawn.splice(0, held.drawn.length, ...next.drawn);
    held.clips.splice(0, held.clips.length, ...next.clips);
  };
  const full = frameOf(c.source, held);
  expect(full.order.every((s) => s.clip !== undefined)).toBe(true);
  expect(full.order.find((s) => s.slot === 'ink_mul')!.blend).toBe('Multiply');
  expect(full.order.find((s) => s.slot === 'ink_screen')!.blend).toBe('Screen');
  const saved = bytes(full);
  setPose(early);
  const before = frameOf(c.source, held);
  setPose(late);
  const after = frameOf(c.source, held);
  expect(before.order.find((s) => s.slot === 'base_mul')!.z).toBe(1);
  expect(after.order.find((s) => s.slot === 'base_mul')!.z).toBe(2);
  expect(after.order.every((s) => s.clip === undefined)).toBe(true);
  expect(bytes(frameOf(c.source, held, [0.5, 0.25, 0.75, 0.5], () => false))).toBe('{"order":[]}');
  setPose(windowPose);
  const calls: string[] = [];
  const noClip = frameOf(c.source, held, [0.5, 0.25, 0.75, 0.5], (slot) => { calls.push(slot); return slot !== 'clip'; });
  expect(calls).toEqual(['clip', ...held.drawn.map((d) => d.slot)]);
  expect(noClip.order.every((s) => s.clip === undefined)).toBe(true);
  expect(noClip.order[0].tint).toEqual([0.5, 0.25, 0.75, 0.5]);
  expect(bytes(full)).toBe(saved);
});

contract('reentrant-filters', () => {
  const c = scene('draw', 'window', 'base');
  const outerPose = c.track.first;
  const other = scene('glow-packed', 'burn');
  const nestedPose = openTrack(c.view, 'reorder', { loop: false, reset: 'animation' }).step(0.75);
  const expected = frameOf(frameSource(c.view, c.read.parsed), outerPose);
  const nestedExpected = bytes(frameOf(frameSource(c.view, c.read.parsed), nestedPose));
  const calls: string[] = [];
  let nestedCount = 0;
  const actual = frameOf(c.source, outerPose, [1, 1, 1, 1], (slot) => {
    calls.push(slot);
    if (slot === 'clip' || slot === outerPose.drawn[0].slot) {
      expect(bytes(frameOf(c.source, nestedPose))).toBe(nestedExpected);
      frameOf(other.source, other.track.step(1 / 60));
      expect(() => frameOf(c.source, nestedPose, [1, 1, 1, 1], () => { throw new Error('nested stop'); })).toThrow('nested stop');
      nestedCount++;
    }
    return true;
  });
  expect(nestedCount).toBe(2);
  expect(calls).toEqual(['clip', ...outerPose.drawn.map((d) => d.slot)]);
  expect(bytes(actual)).toBe(bytes(expected));
  expect(bytes(frameOf(c.source, nestedPose))).toBe(nestedExpected);
});

contract('exception-recovery', () => {
  const c = scene('draw', 'window', 'base');
  const pose = freeze(c.track.first);
  const baseline = bytes(frameOf(c.source, pose));
  const first = clipCover(pose, c.source.active);
  const kept = JSON.stringify([...first]);
  for (const failAt of ['clip', pose.drawn[1].slot]) {
    expect(() => frameOf(c.source, pose, [1, 1, 1, 1], (slot) => {
      if (slot === failAt) throw new Error(`stop ${failAt}`);
      return true;
    })).toThrow(`stop ${failAt}`);
    expect(bytes(frameOf(c.source, pose))).toBe(baseline);
  }
  const broken = structuredClone(pose);
  broken.slots = broken.slots.filter((row) => row[0] !== broken.drawn[1].slot);
  expect(() => frameOf(c.source, broken)).toThrow('has no slot row');
  const invalidColor = structuredClone(pose);
  invalidColor.slots.find((r) => r[0] === pose.drawn[1].slot)![2] = null;
  expect(() => frameOf(c.source, invalidColor)).toThrow('colour channel that is not finite');
  expect(bytes(frameOf(c.source, pose))).toBe(baseline);
  const second = clipCover(pose, c.source.active);
  expect(second).not.toBe(first);
  expect(second.get(pose.drawn[0].slot)).not.toBe(first.get(pose.drawn[0].slot));
  second.clear();
  clipCover(pose, c.source.active, () => false);
  expect(JSON.stringify([...first])).toBe(kept);
});

contract('independent-players', () => {
  const assets = assetsOf('draw');
  const a = posePlayer(assets, 'base');
  const b = posePlayer(assets, 'alt');
  try {
    a.play('window'); b.play('reorder');
    const retained = a.posedFrame();
    const saved = bytes(retained);
    const aRegion = retained.order.find((s) => s.slot === 'ink_mul');
    const bRegion = b.posedFrame().order.find((s) => s.slot === 'ink_mul');
    expect(aRegion?.kind === 'region' && bRegion?.kind === 'region' && aRegion.region !== bRegion.region).toBe(true);
    for (let n = 0; n < 72; n++) {
      a.advance(1 / 60); b.advance(1 / 30);
      if (n === 24) a.skin = 'alt';
      if (n === 48) a.skin = 'base';
      const outer = a.posedFrame((slot) => { b.posedFrame(['ink_mul']); return slot !== 'ink_screen'; });
      expect(outer.order.some((s) => s.slot === 'ink_screen')).toBe(false);
      expect(a.posedFrame().order.some((s) => s.slot === 'ink_screen')).toBe(true);
    }
    expect(a.time).not.toBe(b.time);
    expect(bytes(retained)).toBe(saved);
  } finally { a.dispose(); b.dispose(); }
});

contract('bench-cli-inputs', () => {
  expect(parsePoseBenchArgs([])).toEqual({ counts: [1, 100], warmup: 60, samples: 300, dt: 1 / 60 });
  expect(parsePoseBenchArgs(['--rig', 'look', '--counts', '1,3', '--warmup', '0', '--samples', '2']).counts).toEqual([1, 3]);
  for (const args of [['--samples', '0'], ['--counts', '1,'], ['--dt', 'NaN'], ['--rig', '../other'], ['--wat', '1'], ['--samples']]) {
    expect(() => parsePoseBenchArgs(args)).toThrow();
  }
  expect(() => readPoseAssets(resolve(root, 'public/rigs/missing-pose-fixture/skeleton.model.json'))).toThrow(/missing-pose-fixture.*bun run fetch-assets/);
});

const name = process.argv[2];
const run = contracts.get(name);
if (run === undefined) {
  throw new Error(`Unknown pose contract ${JSON.stringify(name)}; choose ${[...contracts.keys()].join(', ')}`);
}
try {
  run();
  console.log(JSON.stringify({ contract: name, status: 'passed' }));
} catch (error) {
  console.error(`Pose contract failed: ${name}`);
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
