import type { ModelAssets, RigPlayer as RigPlayerType } from '../src/index';
import { RigPlayer } from '../src/index';
import type { ReadDocument } from '../src/loadModel';
import { loadRig } from './rigFrames';

/**
 * A set switch that re-poses bones, and the physics hung under them (#173).
 *
 * The `drape` test rig: a torso the `idle` clip turns and the `shift` clip
 * slides, without a pause either way, an arm
 * whose `shoulder` the `raise` set's `drawn` turns 110° (from hanging at −90°
 * to 20°), a three-link physics `sleeve_*` chain hung from the forearm (under
 * the drawn bone) and a three-link physics `skirt_*` chain hung from the hip,
 * which no set poses (the control).
 *
 * The metric is the bar's D(f): over a chain's links, the largest distance
 * between a link's tip in the re-posed ancestor's local frame (`shoulder` for
 * the sleeve, `hip` for the skirt) at frame f and at f − 1. Read in that frame,
 * the rigid turn the set makes is not motion; whatever the physics adds is.
 * R, the idle range, is the largest D over the 120 frames (1/60 s) before the
 * switch, after 2 s of warm-up.
 */

export type SetPhysicsOption = 'none' | 'carry' | 'reset' | 'plant';

/**
 * A diagnostic variant, reported and not barred: `g0` sets every constraint's
 * gravity to 0 after `play` (so nothing pulls the turned chain), `up` loads
 * `raise` drawing the shoulder at 90° — a 180° turn from hanging, where gravity
 * has no lever on the chain before or after. Both on the `idle` clip.
 */

/**
 * The idle clip: `idle` turns the torso, so the forearm's idle push grows with
 * its distance from the torso's pivot and the raised arm's own idle range is
 * larger than the hanging arm's; `shift` slides the torso, so the forearm is
 * pushed the same way wherever the arm points.
 */
export type SetPhysicsClip = 'idle' | 'shift';
export type SetPhysicsDiagnostic = 'g0' | 'up';

export interface SetPhysicsRun {
  mode: 'track' | 'tracks';
  clip: SetPhysicsClip;
  option: SetPhysicsOption;
  diagnostic?: SetPhysicsDiagnostic;
  /** Idle range: max D over the 120 frames before the switch. */
  R: number;
  /** D of the switch itself (the repose), against the frame before it. */
  dAct: number;
  /** D of the first frame after the switch. */
  dFirst: number;
  /** Max D over the 60 frames after the switch (the first one included). */
  max60: number;
  /** The idle range in the switched pose: max D over the last 60 of the 120 frames held after those 60 (2–3 s after the switch). */
  Rafter: number;
  /** Deactivation (`removeSet`, same option) after 2 s held: D of the switch, of the first frame, and max over 60. */
  deact: { dAct: number; dFirst: number; max60: number };
  /** FNV-1a over every frame's `posedFrame()` JSON from the first pose to the last (482 frames). */
  frameHash: string;
  /** The control chain's bones (x, y, a, b, c, d) over every frame, as one JSON string. */
  control: string;
  /** Control chain: max D over the run, as a check that it moves at all. */
  controlR: number;
}

export interface SetPhysicsProbeResult {
  runs: SetPhysicsRun[];
  /** Diagnostic variants (none and carry, both modes): what the first frame after a carried switch is made of. */
  diagnostics: SetPhysicsRun[];
  /** B5(a): the option absent, `{}` and `{ physics: undefined }` draw the same frames (per mode). */
  absentVariantsSame: Record<string, boolean>;
  /** B5(c): `gesture` (sets with drawn, no physics) — frame hashes per mode and option. */
  noPhysics: Record<string, Record<'none' | 'carry' | 'reset', string>>;
  /** A value that is not 'carry' or 'reset' throws by name and changes nothing. */
  badOptionError: string;
  badOptionUnchanged: boolean;
  badOptionsObjectError: string;
  /** Before `play` (setup pose, no physics state): the option poses exactly as without it. */
  beforePlaySame: boolean;
}

const STEP = 1 / 60;
const SLEEVE = ['sleeve_1', 'sleeve_2', 'sleeve_3'];
const SKIRT = ['skirt_1', 'skirt_2', 'skirt_3'];

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  document.body.appendChild(root);
  return root;
}

function fnv(text: string, h = 0x811c9dc5): number {
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

type Tips = Array<[number, number]>;

/** Each link's tip in `anchor`'s local frame. */
function tips(p: RigPlayerType, lengths: ReadonlyMap<string, number>, links: readonly string[], anchor: string): Tips {
  const w = p.bone(anchor);
  const det = w.a * w.d - w.b * w.c;
  return links.map((name) => {
    const b = p.bone(name);
    const l = lengths.get(name) ?? 0;
    const dx = b.x + l * b.a - w.x;
    const dy = b.y + l * b.c - w.y;
    return [(w.d * dx - w.b * dy) / det, (-w.c * dx + w.a * dy) / det];
  });
}

function dist(a: Tips, b: Tips): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}

type Activate = (p: RigPlayerType, names: string[], options: unknown) => void;
/** Called as a caller would, the options argument absent when `options` is the string 'absent'. */
const callSetSets: Activate = (p, names, options) => {
  if (options === 'absent') p.setSets(names);
  else (p.setSets as (n: string[], o: unknown) => void).call(p, names, options);
};
const callRemoveSet: Activate = (p, names, options) => {
  if (options === 'absent') p.removeSet(names[0]);
  else (p.removeSet as (n: string, o: unknown) => void).call(p, names[0], options);
};

function optionsOf(option: SetPhysicsOption): unknown {
  if (option === 'none') return 'absent';
  if (option === 'plant') return { physics: 'carry' };
  return { physics: option };
}

/**
 * B7's plant: a test-only private switch on the player (`carryPlant`), not
 * public API — the carry runs as written (affected set, trial step, capture
 * and restore) but maps every state through the identity instead of M.
 */
function plant(p: RigPlayerType): void {
  (p as unknown as { carryPlant: boolean }).carryPlant = true;
}

/** `loadRig` with the build's `sets.json` edited on the way in. */
function loadRigWithSets(rig: string, edit: (doc: Record<string, unknown>) => unknown): Promise<ModelAssets> {
  return loadRig(rig, {
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const response = await fetch(input, init);
      if (!url.endsWith('/sets.json') || !response.ok) return response;
      return new Response(JSON.stringify(edit((await response.json()) as Record<string, unknown>)), { status: 200 });
    },
  });
}

function runDrape(assets: ModelAssets, tracks: boolean, clip: SetPhysicsClip, option: SetPhysicsOption, variant?: unknown, diagnostic?: SetPhysicsDiagnostic): SetPhysicsRun {
  const doc = (assets.document as ReadDocument).doc;
  const lengths = new Map(doc.bones.map((b) => [b.name, (b as { length?: number }).length ?? 0]));
  const root = makeRoot();
  const p = new RigPlayer(root, assets, { mode: 'canvas', tracks });
  if (option === 'plant') plant(p);
  const opts = variant ?? optionsOf(option);
  let hash = 0x811c9dc5;
  const control: unknown[] = [];
  let controlPrev: Tips | null = null;
  let controlR = 0;
  const record = (): void => {
    hash = fnv(JSON.stringify(p.posedFrame()), hash);
    control.push(SKIRT.map((n) => {
      const b = p.bone(n);
      return [b.x, b.y, b.a, b.b, b.c, b.d];
    }));
    const c = tips(p, lengths, SKIRT, 'hip');
    if (controlPrev !== null) controlR = Math.max(controlR, dist(c, controlPrev));
    controlPrev = c;
  };
  const sleeve = (): Tips => tips(p, lengths, SLEEVE, 'shoulder');
  try {
    p.play(clip);
    if (diagnostic === 'g0') {
      for (const c of doc.constraints) if (c.kind === 'physics') p.setPhysicsParameters(c.name, { gravity: 0 });
    }
    record();
    for (let i = 0; i < 120; i++) { p.advance(STEP); record(); }
    let prev = sleeve();
    let R = 0;
    for (let i = 0; i < 120; i++) {
      p.advance(STEP);
      record();
      const cur = sleeve();
      R = Math.max(R, dist(cur, prev));
      prev = cur;
    }
    // The switch.
    callSetSets(p, ['raise'], opts);
    record();
    let cur = sleeve();
    const dAct = dist(cur, prev);
    prev = cur;
    let dFirst = 0;
    let max60 = 0;
    for (let i = 0; i < 60; i++) {
      p.advance(STEP);
      record();
      cur = sleeve();
      const d = dist(cur, prev);
      if (i === 0) dFirst = d;
      max60 = Math.max(max60, d);
      prev = cur;
    }
    let Rafter = 0;
    for (let i = 0; i < 120; i++) {
      p.advance(STEP);
      record();
      cur = sleeve();
      if (i >= 60) Rafter = Math.max(Rafter, dist(cur, prev));
      prev = cur;
    }
    // Deactivation.
    callRemoveSet(p, ['raise'], opts);
    record();
    cur = sleeve();
    const deact = { dAct: dist(cur, prev), dFirst: 0, max60: 0 };
    prev = cur;
    for (let i = 0; i < 60; i++) {
      p.advance(STEP);
      record();
      cur = sleeve();
      const d = dist(cur, prev);
      if (i === 0) deact.dFirst = d;
      deact.max60 = Math.max(deact.max60, d);
      prev = cur;
    }
    return {
      mode: tracks ? 'tracks' : 'track',
      clip,
      option,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      R,
      dAct,
      dFirst,
      max60,
      Rafter,
      deact,
      frameHash: hash.toString(16),
      control: JSON.stringify(control),
      controlR,
    };
  } finally {
    p.dispose();
    root.remove();
  }
}

/** `gesture`: sets with `drawn`, no physics anywhere — the option must change no frame. */
function runNoPhysics(assets: ModelAssets, tracks: boolean, option: 'none' | 'carry' | 'reset'): string {
  const root = makeRoot();
  const p = new RigPlayer(root, assets, { mode: 'canvas', tracks });
  const opts = optionsOf(option);
  let hash = 0x811c9dc5;
  const record = (): void => { hash = fnv(JSON.stringify(p.posedFrame()), hash); };
  try {
    p.play('swing');
    for (let i = 0; i < 30; i++) { p.advance(STEP); record(); }
    callSetSets(p, ['wave'], opts);
    record();
    for (let i = 0; i < 60; i++) { p.advance(STEP); record(); }
    callSetSets(p, ['wave', 'nod'], opts);
    record();
    for (let i = 0; i < 30; i++) { p.advance(STEP); record(); }
    callRemoveSet(p, ['wave'], opts);
    record();
    for (let i = 0; i < 60; i++) { p.advance(STEP); record(); }
    return hash.toString(16);
  } finally {
    p.dispose();
    root.remove();
  }
}

export async function setPhysicsProbe(): Promise<SetPhysicsProbeResult> {
  const drape = await loadRig('drape');
  const gesture = await loadRig('gesture');
  const up = await loadRigWithSets('drape', (doc) => {
    const sets = doc.sets as Record<string, Record<string, unknown>>;
    return { ...doc, sets: { ...sets, raise: { ...sets.raise, drawn: { shoulder: 90 } } } };
  });
  try {
    const runs: SetPhysicsRun[] = [];
    const diagnostics: SetPhysicsRun[] = [];
    const absentVariantsSame: Record<string, boolean> = {};
    const noPhysics: SetPhysicsProbeResult['noPhysics'] = {};
    for (const tracks of [false, true]) {
      const mode = tracks ? 'tracks' : 'track';
      for (const clip of ['idle', 'shift'] as const) {
        for (const option of ['none', 'carry', 'reset', 'plant'] as const) runs.push(runDrape(drape, tracks, clip, option));
      }
      const none = runs.find((r) => r.mode === mode && r.clip === 'idle' && r.option === 'none') as SetPhysicsRun;
      absentVariantsSame[mode] =
        runDrape(drape, tracks, 'idle', 'none', {}).frameHash === none.frameHash &&
        runDrape(drape, tracks, 'idle', 'none', { physics: undefined }).frameHash === none.frameHash;
      for (const option of ['none', 'carry'] as const) {
        diagnostics.push(runDrape(drape, tracks, 'idle', option, undefined, 'g0'));
        diagnostics.push(runDrape(up, tracks, 'idle', option, undefined, 'up'));
      }
      noPhysics[mode] = {
        none: runNoPhysics(gesture, tracks, 'none'),
        carry: runNoPhysics(gesture, tracks, 'carry'),
        reset: runNoPhysics(gesture, tracks, 'reset'),
      };
    }

    // A bad value throws by name before anything changes.
    const root = makeRoot();
    const p = new RigPlayer(root, drape, { mode: 'canvas' });
    let badOptionError = '';
    let badOptionsObjectError = '';
    let badOptionUnchanged = false;
    let beforePlaySame = false;
    try {
      p.play('idle');
      for (let i = 0; i < 30; i++) p.advance(STEP);
      const before = { sets: JSON.stringify(p.activeSets), frame: JSON.stringify(p.posedFrame()), gen: p.generation };
      try { callSetSets(p, ['raise'], { physics: 'bogus' }); } catch (e) { badOptionError = (e as Error).message; }
      try { callSetSets(p, ['raise'], 'carry'); } catch (e) { badOptionsObjectError = (e as Error).message; }
      badOptionUnchanged = JSON.stringify(p.activeSets) === before.sets && JSON.stringify(p.posedFrame()) === before.frame && p.generation === before.gen;
      // Before play: the setup pose, no physics state to carry or reset.
      const r2 = makeRoot();
      const a = new RigPlayer(r2, drape, { mode: 'canvas' });
      const b = new RigPlayer(r2, drape, { mode: 'canvas' });
      const c = new RigPlayer(r2, drape, { mode: 'canvas' });
      callSetSets(a, ['raise'], 'absent');
      callSetSets(b, ['raise'], { physics: 'carry' });
      callSetSets(c, ['raise'], { physics: 'reset' });
      const fa = JSON.stringify(a.posedFrame());
      beforePlaySame = fa === JSON.stringify(b.posedFrame()) && fa === JSON.stringify(c.posedFrame());
      a.dispose();
      b.dispose();
      c.dispose();
      r2.remove();
    } finally {
      p.dispose();
      root.remove();
    }
    return { runs, diagnostics, absentVariantsSame, noPhysics, badOptionError, badOptionUnchanged, badOptionsObjectError, beforePlaySame };
  } finally {
    drape.dispose();
    gesture.dispose();
    up.dispose();
  }
}
