import type { ModelAssets, RigPlayer as RigPlayerType, SlotIdentitySnapshot } from '../src/index';
import { RigPlayer } from '../src/index';
import type { ReadDocument } from '../src/loadModel';
import { loadRig } from './rigFrames';
import { dist, fnv, makeRoot, tips, type Tips } from './setPhysicsProbe';

/**
 * An eased set switch (#174): `setSets(names, { ease: seconds })` turns the
 * bones a set draws from what they show to the drawn angles over the
 * duration, and swaps the attachments on the frame nearest the middle.
 *
 * The bar's rig is `wind-wave`, `@rig-c/parts`' public wind example built
 * with its gesture set (scripts/fetch-assets.sh): `wave_r` draws `sleeve_r0`
 * and `sleeve_r1`, which its `idle` clip itself keys, so what an ease starts
 * from moves with the clip. Every figure is read at `frame(1/60)` steps, in
 * both stepper modes, on players in the canvas mode that are never drawn.
 *
 * - B1 progress p = shortestΔ(start, shown) / shortestΔ(start, end) per eased
 *   bone and frame, start and end each the clip's local at that time or a
 *   fixed drawn local: activation runs from the clip to the drawn local,
 *   deactivation from the drawn local back to the clip. The shown local and
 *   the clip's are read through `adjust` (called after the player writes its
 *   drawn rotations), the clip's on a twin player that never switches.
 * - B2 the covered bones' world angles on a held clip: `idle` with every
 *   timeline of the covered bones and their ancestors taken out of the loaded
 *   document (the same build, edited on the way in).
 * - B3 the swap frame, read off `slotIdentity()` against two instant twins
 *   (the composition before and after), against the frame whose u = k·dt/ease
 *   is nearest ½, a tie (within 1e-9) going to the later frame.
 * - B4 every bone's world rotation and the slot identity against an instant
 *   twin switched at the same frame, from the first frame after the ease ends.
 * - B5 frame hashes without the option and with `ease: 0` (gesture, drape,
 *   wave; both modes; 480 frames).
 * - B6 a reversal mid-ease: the largest frame-to-frame step of the shown
 *   locals against an uninterrupted ease's.
 * - B7 drape with #173's D/R metric: none, carry, ease, ease + carry.
 * - B8 planted controls, test-only private switches on the player
 *   (`easePlant`), not API: the swap at u = 0, and w = 1.2u (clamped at u = 1).
 */

const STEP = 1 / 60;

type Plant = 'swap-at-0' | 'overshoot';

/** A set call made as a caller would, the options argument absent when `options` is the string 'absent'. */
function setSets(p: RigPlayerType, names: string[], options: unknown): void {
  if (options === 'absent') p.setSets(names);
  else (p.setSets as (n: string[], o: unknown) => void).call(p, names, options);
}

function removeSet(p: RigPlayerType, name: string, options: unknown): void {
  if (options === 'absent') p.removeSet(name);
  else (p.removeSet as (n: string, o: unknown) => void).call(p, name, options);
}

function plant(p: RigPlayerType, what: Plant): void {
  (p as unknown as { easePlant: Plant | null }).easePlant = what;
}

function normDeg(deg: number): number {
  let v = ((deg % 360) + 360) % 360;
  if (v > 180) v -= 360;
  return v;
}

/** `adjust` that records the named bones' locals as the pose leaves them (after the player's drawn rotations). */
function recordLocals(p: RigPlayerType, bones: readonly string[]): Map<string, number> {
  const last = new Map<string, number>();
  p.adjust = (locals) => {
    for (const b of bones) last.set(b, locals.bone(b).rotation);
  };
  return last;
}

function worldAngle(p: RigPlayerType, bone: string): number {
  const w = p.bone(bone);
  return (Math.atan2(w.c, w.a) * 180) / Math.PI;
}

function identityKey(s: SlotIdentitySnapshot): string {
  return JSON.stringify(s.slots.map((x) => [x.slot, x.attachment, x.reason]));
}

/** The bones whose world rotation differs from `b`'s by more than nothing; the largest |Δ| in degrees. */
function maxWorldDiff(a: RigPlayerType, b: RigPlayerType, names: readonly string[]): number {
  let m = 0;
  for (const n of names) m = Math.max(m, Math.abs(normDeg(worldAngle(a, n) - worldAngle(b, n))));
  return m;
}

function identityDiffs(a: RigPlayerType, b: RigPlayerType): number {
  const x = a.slotIdentity().slots;
  const y = b.slotIdentity().slots;
  let n = Math.abs(x.length - y.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i].slot !== y[i].slot || x[i].attachment !== y[i].attachment || x[i].reason !== y[i].reason) n++;
  }
  return n;
}

/** The frame k (0 = the call) whose u = k·dt/ease is nearest ½; a tie within 1e-9 goes to the later frame. */
export function expectedSwapFrame(ease: number, dt: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k * dt <= ease + dt; k++) {
    const d = Math.abs((k * dt) / ease - 0.5);
    if (d <= bestD + 1e-9) {
      best = k;
      bestD = Math.min(d, bestD);
    }
    if ((k * dt) / ease > 1) break;
  }
  return best;
}

/** One eased switch's figures (B1, B3, B4) for one direction. */
export interface EasePhase {
  /** Frames from the call (k = 0) to the frame the ease ends, inclusive. */
  frames: number;
  /** Per eased bone, the progress p at k = 0 … frames. */
  progress: Record<string, number[]>;
  /** B1: p non-decreasing (1e-9) and inside [0, 1] (1e-9) for every bone. */
  monotonic: boolean;
  /** min p and max p over all bones and frames. */
  pMin: number;
  pMax: number;
  /** Largest decrease of p between consecutive frames (0 when monotonic). */
  pDrop: number;
  /** Frames skipped because shortestΔ(start, end) was under 1e-9 (no progress to measure). */
  skipped: number;
  /** B3: the first frame k whose slot identity is the new composition's, and the one expected. */
  swapFrame: number;
  expectedSwap: number;
  /** Before the swap the identity was the old composition's on every frame, and after it the new one's. */
  swapClean: boolean;
  /** B4: from the first frame after the ease ends, over 60 frames: max |Δ world rotation| (degrees) over every bone, and slot identity diffs. */
  endWorldDiff: number;
  endIdentityDiffs: number;
  /** The same on the frame the ease ends (reported). */
  endFrameWorldDiff: number;
}

export interface EaseRun {
  mode: 'track' | 'tracks';
  ease: number;
  plant: Plant | 'none';
  activation: EasePhase;
  deactivation: EasePhase;
  /** What `slotIdentity()` reports on the frame before the activation's swap. */
  midIdentity: { sets: readonly string[]; set: string | null; coveredSlots: Array<[string, string | null, string | null]> };
}

export interface HeldRun {
  mode: 'track' | 'tracks';
  /** Per covered bone: the base and drawn world angles and the eased path (activation then deactivation). */
  bones: Record<string, { base: number; drawn: number; activation: number[]; deactivation: number[] }>;
  /** B2: each path monotonic from its start to its end (1e-9) and inside [min, max] (1e-9). */
  monotonic: boolean;
  /** Whether the held run's covered bones really held: their world angle at base varies by at most this over 60 frames. */
  baseDrift: number;
}

export interface ReversalRun {
  mode: 'track' | 'tracks';
  /** Largest frame-to-frame step (degrees, any eased bone's shown local) over an uninterrupted eased activation. */
  ownMax: number;
  /** The same over an activation reversed (`setSets([], { ease })`) at frame 9 (u = 0.3), through the reversal's end. */
  reversedMax: number;
  /** The step at the reversal's call and the frame after it. */
  atCall: number;
  firstAfter: number;
  /** For contrast: the same reversal made instantly (no ease). */
  instantMax: number;
}

export interface DrapeEaseRun {
  mode: 'track' | 'tracks';
  clip: 'idle' | 'shift';
  option: 'none' | 'carry' | 'ease' | 'ease+carry' | 'ease+reset';
  /** A diagnostic, reported and not barred: `g0` sets every constraint's gravity to 0 after `play`, as #173's. */
  diagnostic?: 'g0';
  R: number;
  /** The frame (0 = the call) of `maxAct`. */
  maxActFrame: number;
  /** Max D over the activation: the call and every frame to the ease's end (for the instant options, the call and the 30 frames after it). */
  maxAct: number;
  dAct: number;
  dFirst: number;
  /** The switched pose's own idle range (2–3 s after the switch). */
  Rafter: number;
  /** Deactivation, same option: max D over its ease (or 30 frames). */
  maxDeact: number;
}

export interface B5Hashes {
  /** `${rig}/${mode}/${variant}` → FNV-1a over every frame's posedFrame() JSON (480 frames). */
  hashes: Record<string, string>;
}

export interface SetEaseProbeResult {
  runs: EaseRun[];
  held: HeldRun[];
  reversal: ReversalRun[];
  drape: DrapeEaseRun[];
  b5: B5Hashes;
  /** Bad `ease` values: each one's error, and whether anything changed. */
  badEase: Array<{ value: string; error: string; unchanged: boolean }>;
  /** Before `play`: an eased call poses exactly as the instant one. */
  beforePlaySame: boolean;
  /** Paused mid-ease: the shown locals held over 30 advances, then the ease went on to the same end. */
  pausedHolds: boolean;
  pausedEndsSame: boolean;
}

const WAVE_BONES = ['sleeve_r0', 'sleeve_r1'];
const WAVE_SET = 'wave_r';

function boneNames(assets: ModelAssets): string[] {
  return (assets.document as ReadDocument).doc.bones.map((b) => b.name);
}

/**
 * One eased activation and deactivation on wave, with three twins stepped in
 * lock-step: `ctl` never switches (the clip's locals, the base composition),
 * `on` switches instantly at the activation and stays on (the drawn locals,
 * the set's composition), `inst` switches instantly at both calls (B4's
 * reference).
 */
function runWave(assets: ModelAssets, tracks: boolean, ease: number, plantWhat: Plant | 'none'): EaseRun {
  const root = makeRoot();
  const make = (): RigPlayerType => new RigPlayer(root, assets, { mode: 'canvas', tracks });
  const p = make();
  const ctl = make();
  const on = make();
  const inst = make();
  const all = [p, ctl, on, inst];
  const names = boneNames(assets);
  try {
    if (plantWhat !== 'none') plant(p, plantWhat);
    const rp = recordLocals(p, WAVE_BONES);
    const rc = recordLocals(ctl, WAVE_BONES);
    const ro = recordLocals(on, WAVE_BONES);
    for (const x of all) x.play('idle');
    for (let i = 0; i < 30; i++) for (const x of all) x.advance(STEP);
    let midIdentity: EaseRun['midIdentity'] | null = null;

    const phase = (activation: boolean): EasePhase => {
      const expectedSwap = expectedSwapFrame(ease, STEP);
      const endFrame = Math.ceil(ease / STEP - 1e-9);
      if (activation) {
        setSets(p, [WAVE_SET], { ease });
        setSets(on, [WAVE_SET], 'absent');
        setSets(inst, [WAVE_SET], 'absent');
      } else {
        setSets(p, [], { ease });
        setSets(inst, [], 'absent');
      }
      // Old and new compositions: activation goes ctl → on, deactivation on → ctl.
      const oldP = activation ? ctl : on;
      const newP = activation ? on : ctl;
      const progress: Record<string, number[]> = Object.fromEntries(WAVE_BONES.map((b) => [b, []]));
      let skipped = 0;
      let swapFrame = -1;
      let swapClean = true;
      let endFrameWorldDiff = NaN;
      for (let k = 0; k <= endFrame; k++) {
        if (k > 0) for (const x of all) x.advance(STEP);
        for (const b of WAVE_BONES) {
          const clip = rc.get(b) as number;
          const drawn = ro.get(b) as number;
          const shown = rp.get(b) as number;
          const start = activation ? clip : drawn;
          const end = activation ? drawn : clip;
          const den = normDeg(end - start);
          if (Math.abs(den) < 1e-9) {
            skipped++;
            progress[b].push(NaN);
            continue;
          }
          progress[b].push(normDeg(shown - start) / den);
        }
        const id = identityKey(p.slotIdentity());
        const isNew = id === identityKey(newP.slotIdentity());
        const isOld = id === identityKey(oldP.slotIdentity());
        if (swapFrame < 0) {
          if (isNew) swapFrame = k;
          else if (!isOld) swapClean = false;
          else if (activation && midIdentity === null && k === expectedSwap - 1) {
            const s = p.slotIdentity();
            midIdentity = {
              sets: s.sets,
              set: s.set,
              coveredSlots: s.slots
                .filter((x) => ['forearm_r_front', 'upperarm_r', 'forearm_r'].includes(x.slot))
                .map((x) => [x.slot, x.attachment, x.reason]),
            };
          }
        } else if (!isNew) swapClean = false;
        if (k === endFrame) endFrameWorldDiff = maxWorldDiff(p, inst, names);
      }
      let endWorldDiff = 0;
      let endIdentityDiffs = 0;
      for (let i = 0; i < 60; i++) {
        for (const x of all) x.advance(STEP);
        endWorldDiff = Math.max(endWorldDiff, maxWorldDiff(p, inst, names));
        endIdentityDiffs += identityDiffs(p, inst);
      }
      let pMin = Infinity;
      let pMax = -Infinity;
      let pDrop = 0;
      for (const b of WAVE_BONES) {
        let prev = -Infinity;
        for (const v of progress[b]) {
          if (Number.isNaN(v)) continue;
          pMin = Math.min(pMin, v);
          pMax = Math.max(pMax, v);
          if (prev !== -Infinity) pDrop = Math.max(pDrop, prev - v);
          prev = v;
        }
      }
      return {
        frames: endFrame,
        progress,
        monotonic: pDrop <= 1e-9 && pMin >= -1e-9 && pMax <= 1 + 1e-9,
        pMin,
        pMax,
        pDrop,
        skipped,
        swapFrame,
        expectedSwap,
        swapClean,
        endWorldDiff,
        endIdentityDiffs,
        endFrameWorldDiff,
      };
    };

    const activation = phase(true);
    for (let i = 0; i < 30; i++) for (const x of all) x.advance(STEP);
    const deactivation = phase(false);
    return {
      mode: tracks ? 'tracks' : 'track',
      ease,
      plant: plantWhat,
      activation,
      deactivation,
      midIdentity: midIdentity ?? { sets: [], set: null, coveredSlots: [] },
    };
  } finally {
    for (const x of all) x.dispose();
    root.remove();
  }
}

/** `wind-wave` with every timeline of the covered bones and their ancestors taken out of the loaded document. */
async function loadHeldWave(): Promise<ModelAssets> {
  return loadRig('wind-wave', {
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const response = await fetch(input, init);
      if (!url.endsWith('/skeleton.model.json') || !response.ok) return response;
      const doc = (await response.json()) as {
        bones: Array<{ name: string; parent?: string }>;
        animations: Array<{ bones: Array<{ name: string }> }>;
      };
      const parent = new Map(doc.bones.map((b) => [b.name, b.parent]));
      const held = new Set<string>();
      for (const bone of WAVE_BONES) for (let b: string | undefined = bone; b !== undefined; b = parent.get(b)) held.add(b);
      for (const a of doc.animations) a.bones = a.bones.filter((t) => !held.has(t.name));
      return new Response(JSON.stringify(doc), { status: 200 });
    },
  });
}

function runHeld(assets: ModelAssets, tracks: boolean, ease: number): HeldRun {
  const root = makeRoot();
  const p = new RigPlayer(root, assets, { mode: 'canvas', tracks });
  const on = new RigPlayer(root, assets, { mode: 'canvas', tracks });
  try {
    for (const x of [p, on]) x.play('idle');
    const base0 = WAVE_BONES.map((b) => worldAngle(p, b));
    let baseDrift = 0;
    for (let i = 0; i < 60; i++) {
      for (const x of [p, on]) x.advance(STEP);
      WAVE_BONES.forEach((b, j) => { baseDrift = Math.max(baseDrift, Math.abs(normDeg(worldAngle(p, b) - base0[j]))); });
    }
    setSets(on, [WAVE_SET], 'absent');
    const bones: HeldRun['bones'] = Object.fromEntries(
      WAVE_BONES.map((b) => [b, { base: worldAngle(p, b), drawn: worldAngle(on, b), activation: [] as number[], deactivation: [] as number[] }]),
    );
    const endFrame = Math.ceil(ease / STEP - 1e-9);
    const path = (key: 'activation' | 'deactivation'): void => {
      for (let k = 0; k <= endFrame + 1; k++) {
        if (k > 0) for (const x of [p, on]) x.advance(STEP);
        for (const b of WAVE_BONES) bones[b][key].push(worldAngle(p, b));
      }
    };
    setSets(p, [WAVE_SET], { ease });
    path('activation');
    for (let i = 0; i < 30; i++) for (const x of [p, on]) x.advance(STEP);
    setSets(p, [], { ease });
    path('deactivation');
    let monotonic = true;
    for (const b of WAVE_BONES) {
      const { base, drawn } = bones[b];
      for (const [values, from, to] of [[bones[b].activation, base, drawn], [bones[b].deactivation, drawn, base]] as const) {
        const sign = Math.sign(normDeg(to - from));
        const lo = Math.min(from, to) - 1e-9;
        const hi = Math.max(from, to) + 1e-9;
        for (let i = 0; i < values.length; i++) {
          if (values[i] < lo || values[i] > hi) monotonic = false;
          if (i > 0 && sign * normDeg(values[i] - values[i - 1]) < -1e-9) monotonic = false;
        }
        if (Math.abs(normDeg(values[values.length - 1] - to)) > 1e-9) monotonic = false;
      }
    }
    return { mode: tracks ? 'tracks' : 'track', bones, monotonic, baseDrift };
  } finally {
    p.dispose();
    on.dispose();
    root.remove();
  }
}

function runReversal(assets: ModelAssets, tracks: boolean, ease: number): ReversalRun {
  const one = (reverse: 'none' | 'ease' | 'instant'): { max: number; atCall: number; firstAfter: number } => {
    const root = makeRoot();
    const p = new RigPlayer(root, assets, { mode: 'canvas', tracks });
    try {
      const rec = recordLocals(p, WAVE_BONES);
      p.play('idle');
      for (let i = 0; i < 30; i++) p.advance(STEP);
      let prev = WAVE_BONES.map((b) => rec.get(b) as number);
      let max = 0;
      let atCall = 0;
      let firstAfter = 0;
      const take = (): number => {
        const cur = WAVE_BONES.map((b) => rec.get(b) as number);
        const s = Math.max(...cur.map((v, i) => Math.abs(normDeg(v - prev[i]))));
        prev = cur;
        max = Math.max(max, s);
        return s;
      };
      setSets(p, [WAVE_SET], { ease });
      take();
      const endFrame = Math.ceil(ease / STEP - 1e-9);
      const frames = reverse === 'none' ? endFrame : 9;
      for (let k = 1; k <= frames; k++) { p.advance(STEP); take(); }
      if (reverse !== 'none') {
        setSets(p, [], reverse === 'ease' ? { ease } : 'absent');
        atCall = take();
        for (let k = 1; k <= endFrame; k++) {
          p.advance(STEP);
          const s = take();
          if (k === 1) firstAfter = s;
        }
      }
      return { max, atCall, firstAfter };
    } finally {
      p.dispose();
      root.remove();
    }
  };
  const own = one('none');
  const rev = one('ease');
  const inst = one('instant');
  return { mode: tracks ? 'tracks' : 'track', ownMax: own.max, reversedMax: rev.max, atCall: rev.atCall, firstAfter: rev.firstAfter, instantMax: inst.max };
}

const SLEEVE = ['sleeve_1', 'sleeve_2', 'sleeve_3'];

function runDrape(assets: ModelAssets, tracks: boolean, clip: 'idle' | 'shift', option: DrapeEaseRun['option'], ease: number, diagnostic?: 'g0'): DrapeEaseRun {
  const doc = (assets.document as ReadDocument).doc;
  const lengths = new Map(doc.bones.map((b) => [b.name, (b as { length?: number }).length ?? 0]));
  const root = makeRoot();
  const p = new RigPlayer(root, assets, { mode: 'canvas', tracks });
  const opts: unknown =
    option === 'none' ? 'absent' : option === 'carry' ? { physics: 'carry' } : option === 'ease' ? { ease } : option === 'ease+carry' ? { ease, physics: 'carry' } : { ease, physics: 'reset' };
  const span = option === 'none' || option === 'carry' ? 30 : Math.ceil(ease / STEP - 1e-9);
  const sleeve = (): Tips => tips(p, lengths, SLEEVE, 'shoulder');
  try {
    p.play(clip);
    if (diagnostic === 'g0') {
      for (const c of doc.constraints) if (c.kind === 'physics') p.setPhysicsParameters(c.name, { gravity: 0 });
    }
    for (let i = 0; i < 120; i++) p.advance(STEP);
    let prev = sleeve();
    let R = 0;
    for (let i = 0; i < 120; i++) {
      p.advance(STEP);
      const cur = sleeve();
      R = Math.max(R, dist(cur, prev));
      prev = cur;
    }
    setSets(p, ['raise'], opts);
    let cur = sleeve();
    const dAct = dist(cur, prev);
    let maxAct = dAct;
    let maxActFrame = 0;
    let dFirst = 0;
    prev = cur;
    for (let k = 1; k <= span; k++) {
      p.advance(STEP);
      cur = sleeve();
      const d = dist(cur, prev);
      if (k === 1) dFirst = d;
      if (d > maxAct) {
        maxAct = d;
        maxActFrame = k;
      }
      prev = cur;
    }
    let Rafter = 0;
    for (let i = 0; i < 180 - span; i++) {
      p.advance(STEP);
      cur = sleeve();
      if (i >= 180 - span - 60) Rafter = Math.max(Rafter, dist(cur, prev));
      prev = cur;
    }
    removeSet(p, 'raise', opts);
    cur = sleeve();
    let maxDeact = dist(cur, prev);
    prev = cur;
    for (let k = 1; k <= span; k++) {
      p.advance(STEP);
      cur = sleeve();
      maxDeact = Math.max(maxDeact, dist(cur, prev));
      prev = cur;
    }
    return { mode: tracks ? 'tracks' : 'track', clip, option, ...(diagnostic === undefined ? {} : { diagnostic }), R, maxAct, maxActFrame, dAct, dFirst, Rafter, maxDeact };
  } finally {
    p.dispose();
    root.remove();
  }
}

/** B5: 480 frames — the set on at frame 60, off at frame 300 — hashed, without the option and with `ease: 0`. */
function b5Hash(assets: ModelAssets, tracks: boolean, clip: string, set: string, variant: 'absent' | 'ease0'): string {
  const root = makeRoot();
  const p = new RigPlayer(root, assets, { mode: 'canvas', tracks });
  const opts: unknown = variant === 'absent' ? 'absent' : { ease: 0 };
  let hash = 0x811c9dc5;
  try {
    p.play(clip);
    for (let i = 0; i < 480; i++) {
      if (i === 60) setSets(p, [set], opts);
      if (i === 300) removeSet(p, set, opts);
      p.advance(STEP);
      hash = fnv(JSON.stringify(p.posedFrame()), hash);
    }
    return hash.toString(16);
  } finally {
    p.dispose();
    root.remove();
  }
}

export async function setEaseB5Probe(): Promise<B5Hashes> {
  const rigs = [
    { rig: 'gesture', clip: 'swing', set: 'wave' },
    { rig: 'drape', clip: 'idle', set: 'raise' },
    { rig: 'wind-wave', clip: 'idle', set: WAVE_SET },
  ];
  const hashes: Record<string, string> = {};
  for (const { rig, clip, set } of rigs) {
    const assets = await loadRig(rig);
    try {
      for (const tracks of [false, true]) {
        for (const variant of ['absent', 'ease0'] as const) {
          hashes[`${rig}/${tracks ? 'tracks' : 'track'}/${variant}`] = b5Hash(assets, tracks, clip, set, variant);
        }
      }
    } finally {
      assets.dispose();
    }
  }
  return { hashes };
}

export async function setEaseProbe(): Promise<SetEaseProbeResult> {
  const wave = await loadRig('wind-wave');
  const held = await loadHeldWave();
  const drape = await loadRig('drape');
  try {
    const runs: EaseRun[] = [];
    const heldRuns: HeldRun[] = [];
    const reversal: ReversalRun[] = [];
    const drapeRuns: DrapeEaseRun[] = [];
    for (const tracks of [false, true]) {
      for (const ease of [0.5, 0.25]) runs.push(runWave(wave, tracks, ease, 'none'));
      runs.push(runWave(wave, tracks, 0.5, 'swap-at-0'));
      runs.push(runWave(wave, tracks, 0.5, 'overshoot'));
      heldRuns.push(runHeld(held, tracks, 0.5));
      reversal.push(runReversal(wave, tracks, 0.5));
      for (const clip of ['idle', 'shift'] as const) {
        for (const option of ['none', 'carry', 'ease', 'ease+carry', 'ease+reset'] as const) drapeRuns.push(runDrape(drape, tracks, clip, option, 0.5));
        for (const option of ['none', 'ease+carry'] as const) drapeRuns.push(runDrape(drape, tracks, clip, option, 0.5, 'g0'));
      }
    }
    const b5 = await setEaseB5Probe();

    // Bad values throw by name before anything changes.
    const root = makeRoot();
    const badEase: SetEaseProbeResult['badEase'] = [];
    let beforePlaySame = false;
    let pausedHolds = false;
    let pausedEndsSame = false;
    const p = new RigPlayer(root, wave, { mode: 'canvas' });
    try {
      p.play('idle');
      for (let i = 0; i < 10; i++) p.advance(STEP);
      for (const [label, value] of [['-1', -1], ['NaN', NaN], ['Infinity', Infinity], ['"0.5"', '0.5'], ['null', null]] as const) {
        const before = { sets: JSON.stringify(p.activeSets), frame: JSON.stringify(p.posedFrame()), gen: p.generation };
        let error = '';
        try { setSets(p, [WAVE_SET], { ease: value }); } catch (e) { error = (e as Error).message; }
        badEase.push({
          value: label,
          error,
          unchanged: JSON.stringify(p.activeSets) === before.sets && JSON.stringify(p.posedFrame()) === before.frame && p.generation === before.gen,
        });
      }
      // Before play: nothing steps, so the switch is instant.
      const a = new RigPlayer(root, wave, { mode: 'canvas' });
      const b = new RigPlayer(root, wave, { mode: 'canvas' });
      setSets(a, [WAVE_SET], 'absent');
      setSets(b, [WAVE_SET], { ease: 0.5 });
      beforePlaySame = JSON.stringify(a.posedFrame()) === JSON.stringify(b.posedFrame()) && identityKey(a.slotIdentity()) === identityKey(b.slotIdentity());
      a.dispose();
      b.dispose();
      // Paused mid-ease: holds, then ends where an unpaused ease ends.
      const c = new RigPlayer(root, wave, { mode: 'canvas' });
      const d = new RigPlayer(root, wave, { mode: 'canvas' });
      const rc = recordLocals(c, WAVE_BONES);
      for (const x of [c, d]) { x.play('idle'); for (let i = 0; i < 10; i++) x.advance(STEP); setSets(x, [WAVE_SET], { ease: 0.5 }); }
      for (let i = 0; i < 10; i++) { c.advance(STEP); d.advance(STEP); }
      const held0 = WAVE_BONES.map((bn) => rc.get(bn));
      const frame0 = JSON.stringify(c.posedFrame());
      c.pause();
      for (let i = 0; i < 30; i++) c.advance(STEP);
      pausedHolds = JSON.stringify(WAVE_BONES.map((bn) => rc.get(bn))) === JSON.stringify(held0) && JSON.stringify(c.posedFrame()) === frame0;
      c.resume();
      for (let i = 0; i < 40; i++) { c.advance(STEP); d.advance(STEP); }
      pausedEndsSame = JSON.stringify(c.posedFrame()) === JSON.stringify(d.posedFrame());
      c.dispose();
      d.dispose();
    } finally {
      p.dispose();
      root.remove();
    }
    return { runs, held: heldRuns, reversal, drape: drapeRuns, b5, badEase, beforePlaySame, pausedHolds, pausedEndsSame };
  } finally {
    wave.dispose();
    held.dispose();
    drape.dispose();
  }
}
