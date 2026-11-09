import { openTrack, physicsClockStep, underNoSkin } from '@rig-c/core/core';
import type { RigPlayer as RigPlayerType } from '../src/index';
import { RigPlayer } from '../src/index';
import type { ReadDocument } from '../src/loadModel';
import type { PosedFrame } from '../src/posedFrame';
import { loadRig } from './rigFrames';
import { fnv, makeRoot } from './setPhysicsProbe';

/**
 * The held-clock step (#248); `tests/held-clock.spec.ts` states the bars. The
 * plants are test-only (`heldPlant` on the player), each one of today's ways
 * round the missing step.
 */
export type HeldPlant = 'advance' | 'freeze' | 'reset' | null;

export interface HeldBar1Run {
  mode: 'track' | 'tracks';
  time: number;
  plant: HeldPlant;
  poser: string;
  frames: number;
  /** Every non-physics value that differed from the first held frame on any held frame. */
  animatedDiffs: string[];
  timesMoved: boolean;
  physicsChanged: boolean;
  /** The fixture check: what the card shows and whether it is drawn last, at the held time. */
  card: { region: string; last: boolean };
}

export interface HeldBar2Run {
  plant: HeldPlant;
  d0: number;
  d60: number;
  tipMove: number;
}

export interface HeldBar3Run {
  plant: HeldPlant;
  /** |tip after the first resumed frame − tip at the last held frame|. */
  jump: number;
  /** The largest frame-to-frame tip move over 4 s of plain play. */
  maxStep: number;
  /** Max |player − core| over the tip bone's world fields after the resumed frame. */
  coreDiff: number;
  /** Max |player − reset| over the same fields: the same time reached with no hold. */
  resetDiff: number;
  time: number;
}

export interface HeldBar4Run {
  plant: HeldPlant;
  poser: string;
  frameSame: boolean;
  domSame: boolean;
  generationSame: boolean;
  timeSame: boolean;
}

export interface HeldClockProbeResult {
  bar1: HeldBar1Run[];
  bar2: HeldBar2Run[];
  bar3: HeldBar3Run[];
  bar4: HeldBar4Run[];
  api: {
    initial: boolean;
    afterHold: boolean;
    afterPlay: boolean;
    pausedHeldTimeMoved: boolean;
    pausedHeldPhysicsMoved: boolean;
    badArg: string;
    nonFinite: string;
    nonFiniteLeftTrackUsable: boolean;
    /** `moved()` given while held applies on the next held step. */
    movedWhileHeld: boolean;
  };
}

const STEP = 1 / 60;
const PHYSICS_BONES = new Set(['link_1', 'link_2', 'link_3', 'tip']);
const PHYSICS_SLOTS = new Set(['link_1', 'link_2', 'link_3']);
const TIP_FIELDS = ['x', 'y', 'a', 'b', 'c', 'd'] as const;

interface Held {
  hold(on?: boolean): void;
  readonly held: boolean;
}

function plant(p: RigPlayerType, what: HeldPlant): void {
  (p as unknown as { heldPlant: HeldPlant }).heldPlant = what;
}

function hold(p: RigPlayerType, on: boolean): void {
  (p as unknown as Held).hold(on);
}

/** Every value the animation timelines decide, keyed by where it is read; physics-driven geometry left out. */
function animated(p: RigPlayerType, bones: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of bones) if (!PHYSICS_BONES.has(name)) out.set(`bone ${name}`, JSON.stringify(p.bone(name)));
  const frame = p.posedFrame();
  out.set('order', JSON.stringify(frame.order.map((s) => s.slot)));
  for (const s of frame.order) {
    const { slot, z, blend, tint, dark, clip } = s;
    out.set(`slot ${slot}`, JSON.stringify({ slot, z, blend, tint, dark, clip, kind: s.kind, region: s.kind === 'region' ? s.region : null, page: s.page, sequence: s.kind === 'mesh' ? s.sequence : null }));
    if (!PHYSICS_SLOTS.has(slot)) out.set(`geometry ${slot}`, JSON.stringify(s.kind === 'region' ? s.corners : s.vertices));
  }
  return out;
}

function physicsReading(p: RigPlayerType): string {
  return JSON.stringify([...PHYSICS_BONES].map((n) => p.bone(n)));
}

function tip(p: RigPlayerType): [number, number] {
  const b = p.bone('tip');
  return [b.x, b.y];
}

function card(frame: PosedFrame): { region: string; last: boolean } {
  const i = frame.order.findIndex((s) => s.slot === 'card');
  const s = frame.order[i];
  return { region: s.kind === 'region' ? s.region : s.page, last: i === frame.order.length - 1 };
}

async function bar1(): Promise<HeldBar1Run[]> {
  const assets = await loadRig('held');
  const bones = (assets.document as ReadDocument).doc.bones.map((b) => b.name);
  const runs: HeldBar1Run[] = [];
  for (const what of [null, 'advance'] as const) {
    for (const mode of ['track', 'tracks'] as const) {
      for (const time of [0.7, 1.2]) {
        const root = makeRoot();
        const p = new RigPlayer(root, assets, mode === 'tracks' ? { tracks: true } : {});
        plant(p, what);
        p.play(mode === 'tracks' ? 'glide' : 'sway');
        for (let i = 0; i < Math.round(time * 60); i++) p.frame(STEP);
        hold(p, true);
        const first = animated(p, bones);
        const firstPhysics = physicsReading(p);
        const firstTime = p.time;
        const fixture = card(p.posedFrame());
        const diffs = new Set<string>();
        let timesMoved = false;
        let physicsChanged = false;
        let frames = 0;
        for (let f = 1; f <= 60; f++) {
          p.frame(STEP);
          frames++;
          for (const [k, v] of animated(p, bones)) if (first.get(k) !== v) diffs.add(k);
          if (p.time !== firstTime) timesMoved = true;
          if (physicsReading(p) !== firstPhysics) physicsChanged = true;
        }
        runs.push({ mode, time, plant: what, poser: p.poser, frames, animatedDiffs: [...diffs].sort(), timesMoved, physicsChanged, card: fixture });
        p.dispose();
        root.remove();
      }
    }
  }
  return runs;
}

async function bar2(): Promise<HeldBar2Run[]> {
  const assets = await loadRig('held');
  const runs: HeldBar2Run[] = [];
  for (const what of [null, 'freeze'] as const) {
    const root = makeRoot();
    const p = new RigPlayer(root, assets);
    plant(p, what);
    p.play('sway');
    for (let i = 0; i < 42; i++) p.frame(STEP);
    hold(p, true);
    const series: Array<[number, number]> = [tip(p)];
    for (let f = 1; f <= 1200; f++) {
      p.frame(STEP);
      if (f <= 60) series.push(tip(p));
    }
    const rest = tip(p);
    const d = (q: [number, number]): number => Math.hypot(q[0] - rest[0], q[1] - rest[1]);
    runs.push({ plant: what, d0: d(series[0]), d60: d(series[60]), tipMove: Math.hypot(series[60][0] - series[0][0], series[60][1] - series[0][1]) });
    p.dispose();
    root.remove();
  }
  return runs;
}

async function bar3(): Promise<HeldBar3Run[]> {
  const assets = await loadRig('held');
  const view = underNoSkin((assets.document as ReadDocument).doc);
  // The largest frame-to-frame tip move over 4 s of plain play.
  let maxStep = 0;
  {
    const root = makeRoot();
    const p = new RigPlayer(root, assets);
    p.play('sway');
    let last = tip(p);
    for (let f = 1; f <= 240; f++) {
      p.frame(STEP);
      const now = tip(p);
      maxStep = Math.max(maxStep, Math.hypot(now[0] - last[0], now[1] - last[1]));
      last = now;
    }
    p.dispose();
    root.remove();
  }
  // The core given the same steps: 42 of 1/60, 60 zero steps on a clock that moves the held 1/60, one of 1/60.
  let heldDt: number | null = null;
  const core = openTrack(view, 'sway', { loop: true, reset: 'animation', adjust: () => {}, clock: (dt) => physicsClockStep(heldDt ?? dt) });
  for (let i = 0; i < 42; i++) core.step(STEP);
  heldDt = STEP;
  for (let i = 0; i < 60; i++) core.step(0);
  heldDt = null;
  const coreTip = core.step(STEP).bones.find((b) => b.name === 'tip')!;
  // The reset: the same time reached with no hold.
  const resetRoot = makeRoot();
  const reset = new RigPlayer(resetRoot, assets);
  reset.play('sway');
  for (let i = 0; i < 43; i++) reset.frame(STEP);
  const resetTip = reset.bone('tip');
  reset.dispose();
  resetRoot.remove();
  const runs: HeldBar3Run[] = [];
  for (const what of [null, 'reset'] as const) {
    const root = makeRoot();
    const p = new RigPlayer(root, assets);
    plant(p, what);
    p.play('sway');
    for (let i = 0; i < 42; i++) p.frame(STEP);
    hold(p, true);
    for (let f = 0; f < 60; f++) p.frame(STEP);
    const before = tip(p);
    hold(p, false);
    p.frame(STEP);
    const after = p.bone('tip');
    let coreDiff = 0;
    let resetDiff = 0;
    const coreRead: Record<(typeof TIP_FIELDS)[number], number> = { x: coreTip.worldX, y: coreTip.worldY, a: coreTip.a, b: coreTip.b, c: coreTip.c, d: coreTip.d };
    for (const k of TIP_FIELDS) {
      coreDiff = Math.max(coreDiff, Math.abs(after[k] - coreRead[k]));
      resetDiff = Math.max(resetDiff, Math.abs(after[k] - resetTip[k]));
    }
    runs.push({ plant: what, jump: Math.hypot(after.x - before[0], after.y - before[1]), maxStep, coreDiff, resetDiff, time: p.time });
    p.dispose();
    root.remove();
  }
  return runs;
}

async function bar4(): Promise<HeldBar4Run[]> {
  const assets = await loadRig('walk');
  const runs: HeldBar4Run[] = [];
  for (const what of [null, 'advance'] as const) {
    for (const poser of ['auto', 'oracle'] as const) {
      const root = makeRoot();
      const p = new RigPlayer(root, assets, { poser });
      plant(p, what);
      p.play('walk');
      for (let i = 0; i < 20; i++) p.frame(STEP);
      hold(p, true);
      const frame = fnv(JSON.stringify(p.posedFrame()));
      const dom = fnv(root.innerHTML);
      const generation = p.generation;
      const time = p.time;
      for (let f = 0; f < 30; f++) p.frame(STEP);
      runs.push({
        plant: what,
        poser: p.poser,
        frameSame: fnv(JSON.stringify(p.posedFrame())) === frame,
        domSame: fnv(root.innerHTML) === dom,
        generationSame: p.generation === generation,
        timeSame: p.time === time,
      });
      p.dispose();
      root.remove();
    }
  }
  return runs;
}

async function api(): Promise<HeldClockProbeResult['api']> {
  const assets = await loadRig('held');
  const root = makeRoot();
  const p = new RigPlayer(root, assets);
  const h = p as unknown as Held;
  const initial = h.held;
  h.hold(true);
  const afterHold = h.held;
  p.play('sway');
  const afterPlay = h.held;
  for (let i = 0; i < 42; i++) p.frame(STEP);
  h.hold(true);
  p.pause();
  const time = p.time;
  const physics = physicsReading(p);
  for (let i = 0; i < 10; i++) p.frame(STEP);
  const pausedHeldTimeMoved = p.time !== time;
  const pausedHeldPhysicsMoved = physicsReading(p) !== physics;
  p.resume();
  let badArg = '';
  try {
    (h.hold as (v: unknown) => void).call(p, 'yes');
  } catch (err) {
    badArg = (err as Error).message;
  }
  let nonFinite = '';
  try {
    p.advance(Number.POSITIVE_INFINITY);
  } catch (err) {
    nonFinite = (err as Error).message;
  }
  let nonFiniteLeftTrackUsable = true;
  try {
    p.frame(STEP);
  } catch {
    nonFiniteLeftTrackUsable = false;
  }
  p.dispose();
  root.remove();
  // moved() given while held: a pair held the same way, one told the rig moved, differ after one held step.
  const pair = [makeRoot(), makeRoot()].map((r) => ({ r, q: new RigPlayer(r, assets) }));
  for (const { q } of pair) {
    q.play('sway');
    for (let i = 0; i < 42; i++) q.frame(STEP);
    q.hold(true);
  }
  pair[1].q.moved({ x: 40, y: 0 });
  const unmoved = [physicsReading(pair[0].q), physicsReading(pair[1].q)];
  for (const { q } of pair) q.frame(STEP);
  const movedWhileHeld = unmoved[0] === unmoved[1] && physicsReading(pair[0].q) !== physicsReading(pair[1].q);
  for (const { r, q } of pair) {
    q.dispose();
    r.remove();
  }
  return { initial, afterHold, afterPlay, pausedHeldTimeMoved, pausedHeldPhysicsMoved, badArg, nonFinite, nonFiniteLeftTrackUsable, movedWhileHeld };
}

export async function heldClockProbe(): Promise<HeldClockProbeResult> {
  return { bar1: await bar1(), bar2: await bar2(), bar3: await bar3(), bar4: await bar4(), api: await api() };
}
