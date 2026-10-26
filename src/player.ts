import { type CompiledDocument, type CoreSlotRow, eventsFired, type LiveTrack, type LiveTracks, type LocalAdjust as CoreLocalAdjust, openTrack, openTracks, physicsClockStep, poseRawSetup, type RawClip, type RawDrawn, type RawPose, type TrackEntryView, underNoSkin, underSkin } from 'rig-c/core';
import { compileRuntime, RuntimeRefusal, type RuntimeModel } from 'rig-c/runtime';
import { checkedLiveFrame, oracleLiveFrame, RuntimeFrames, type LiveFrame } from './liveFrame.js';
import { CanvasRenderer } from './CanvasRenderer.js';
import { DomRenderer, type MeshBackend } from './DomRenderer.js';
import type { ModelAssets, ReadDocument, RigSet } from './loadModel.js';
import { type FrameSource, frameOf, frameSource, type PosedFrame } from './posedFrame.js';

/**
 * Plays a rig built by `rigc build` on a DOM root.
 *
 * The player owns the track and the renderer: `play` opens an animation on a
 * live track (`openTrack` from `rig-c/core`), each `frame(dt)` steps it by
 * `dt × timeScale`, turns the pose into a `PosedFrame` and hands that to its
 * renderer — a `DomRenderer` (`mode: 'dom'`, the default) or a
 * `CanvasRenderer` (`mode: 'canvas'`). Everything the pose holds is computed by
 * the core from the compiled model document; this class schedules and draws.
 */

/**
 * How a player draws: `'dom'` — elements, the rigid tier as `<img>` and the
 * mesh tier on per-part canvases (`DomRenderer`); `'canvas'` — the whole frame
 * into one `<canvas>` through the shared WebGL context (`CanvasRenderer`).
 */
export type RenderMode = 'dom' | 'canvas';

export interface RigPlayerOptions {
  /** Auto selects covered runtime features; oracle is the comparison/control path. */
  poser?: 'auto' | 'oracle';
  /** Development stale/read-only lease checks; defaults to the development build setting. */
  liveFrameChecks?: boolean;
  /**
   * The skin to pose under. Absent is the runtime's "no skin set" — a fresh
   * skeleton whose `setSkin` was never called (`underNoSkin`): no skin's bones
   * or constraints applied, every slot resolved through the default skin.
   */
  skin?: string;
  /** The per-pose adjustment of bone locals (`player.adjust`), set from the first pose. */
  adjust?: BoneAdjust | null;
  /** Which slots this player draws (`player.slots`); every slot when absent. */
  slots?: SlotFilter | null;
  /** How the player draws (see `RenderMode`). Default `'dom'`. Can be changed later through `mode`. */
  mode?: RenderMode;
  /** The mesh tier's rasterizer (see `DomRenderer.meshBackend`) — the DOM mode only. */
  meshBackend?: MeshBackend;
  /**
   * The step `seek` walks the track forward with, in seconds. A seek is
   * "reopen, then step to the time", never a jump: a physics rig has history,
   * and the pose at a time depends on the steps taken to reach it.
   */
  seekStep?: number;
  /**
   * Stand the player on rig-c's live tracks from the first `play`, so the
   * first composing call — a mix, another track, a queue, a clear — never
   * replays. Without it a plain `play` runs on the single live track, and the
   * first composing call carries it over by replaying the time played in
   * `seekStep` increments (there is no hand-over of a live track's physics
   * state in the core), which on a stage that idled a while is one long
   * frame. Pick the single track for a rig whose animations key what the
   * tracks do not mix (constraints, sequences, the draw order, a path's
   * deform); pick the tracks for layering.
   */
  tracks?: boolean;
}

/** What `on('event', …)` hands a listener: one event key the step crossed. */
/**
 * The world a rig's physics answers (`RigPlayer.environment`): spine-core's
 * skeleton-level wind and gravity, x to the right and y down.
 */
export interface RigEnvironment {
  readonly wind: readonly [number, number];
  readonly gravity: readonly [number, number];
}

/** The runtime's start values — spine-core 4.3.13's `Skeleton` defaults. */
const DEFAULT_ENVIRONMENT: RigEnvironment = Object.freeze({ wind: Object.freeze([1, 0] as const), gravity: Object.freeze([0, 1] as const) });

export interface RigEvent {
  name: string;
  /** The key's time in the animation. */
  time: number;
  int: number;
  float: number;
  string: string | null;
  /**
   * The track whose current entry fired it. The core's pose lists a step's
   * events in track order without naming the track, so the player attributes
   * them by counting what each track's current entry fires over the step;
   * when that count does not match the pose (an entry replaced inside the
   * step), the step's events carry no track rather than a guessed one.
   */
  track?: number;
}

/** What `on('complete', …)` hands a listener: the entry that completed, and its track. */
export interface RigComplete {
  animation: string;
  track: number;
}

/** How `play` starts an entry, and `queue` queues one. */
export interface PlayOptions {
  /** Loop; true by default. */
  loop?: boolean;
  /** The track; 0 by default. A base on 0, a layer over it on 1, a one-shot on 2. */
  track?: number;
  /** Seconds the entry this one replaces mixes out over; 0 (the default) cuts. */
  mix?: number;
  /**
   * The entry's weight, from 0 to 1 (1 by default), multiplied into every
   * timeline it applies — the same clip at 0.6 and at 0.85. Change it while
   * the entry plays with `setAlpha`. It does not touch events (fired at any
   * alpha, 0 included) or attachments (kept at any alpha).
   */
  alpha?: number;
  /**
   * The entry adds its keyed bone and deform values to what the tracks below
   * posed, rather than replacing them — a layer keying the same bone channels
   * as the base without covering its motion (false by default). Fixed when the
   * entry is set or queued. A rotation is added as it stands, with no
   * shortest-angle wrap; mixing out, an additive entry fades with its alpha
   * and is never held.
   */
  additive?: boolean;
}

export interface QueueOptions extends PlayOptions {
  /**
   * At or below 0 (the default 0): the entry starts when the one before it
   * completes, less this entry's `mix` — a one-shot then mixes into the next
   * over its last `mix` seconds. Above 0: that many seconds after the entry
   * before it starts.
   */
  delay?: number;
}

/** A track's current entry as the player reads it (`entry(track)`). */
export interface TrackEntry {
  /** What it plays; null for the empty animation a `clear` left. */
  animation: string | null;
  loop: boolean;
  /** The entry's own track time, from its start. */
  trackTime: number;
  /** The animation time it applies at now: the track time wrapped, or held at the duration. */
  animationTime: number;
  duration: number;
  /** The entry's weight as it stands (`PlayOptions.alpha`, `setAlpha`). */
  alpha: number;
  /** Whether the entry adds (`PlayOptions.additive`). */
  additive: boolean;
}

type Listener<T> = (payload: T) => void;

/**
 * One rig on one root.
 *
 * ```ts
 * const player = new RigPlayer(root, assets);
 * player.play('walk');
 * requestAnimationFrame(function tick(now) { player.frame(dt); requestAnimationFrame(tick); });
 * ```
 */
/**
 * One bone's local values at a pose, read and written in place: the seven
 * channels the runtime's bone has, in its units (degrees, world-unit
 * translation, scale factors, shear in degrees). What `BoneAdjust` receives
 * through `AdjustableBones.bone`.
 */
export interface BoneLocals {
  rotation: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
}

/** The bones of one pose, by name, as a `BoneAdjust` sees them. */
export interface AdjustableBones {
  /** The document's bones, in its order. */
  readonly names: readonly string[];
  /** One bone's locals, read and written in place; a name the document has no bone for is refused by name. */
  bone(name: string): BoneLocals;
}

/** The evaluation identity supplied by the core, independent of the displayed player clock. */
export interface BoneAdjustContext {
  /** Current track-0 entry's unwrapped seconds; null when there is no entry. */
  readonly trackTime: number | null;
  /** Current entry's animation; null also for an explicit empty entry (whose time is numeric). */
  readonly animation: string | null;
  /** Running sum of core steps in seconds, independent of the physics clock. */
  readonly globalTime: number;
}

/**
 * A caller's adjustment of a pose's bone locals — a breath's scale, a look's
 * rotation, a mouth's `scaleY` — called once per pose after the animation's
 * timelines and before the world transforms, constraints and physics (the
 * core's `openTrack({ adjust })`, held to the Spine runtime at tolerance 0
 * by rig-c). **A write lasts one pose**: the core poses every step from the
 * setup pose, so a value the caller wants held is written again each pose,
 * and nothing compounds. A non-finite value, an unknown bone, or an error the
 * function throws refuses that step in the core's words.
 */
export type BoneAdjust = (bones: AdjustableBones, ctx: BoneAdjustContext) => void;

/** Runtime scalar responses; the core performs no unit conversion or clamping. */
export interface PhysicsParameters {
  readonly strength: number;
  readonly damping: number;
  readonly inertia: number;
  readonly wind: number;
  readonly gravity: number;
  readonly mix: number;
}

/** Omitted fields retain their pending override. */
export type PhysicsParameterPatch = Partial<PhysicsParameters>;

/** Detached pending patch and last active evaluation (null until evaluated). */
export interface PhysicsParameterRead {
  readonly override: PhysicsParameterPatch | null;
  readonly effective: PhysicsParameters | null;
}

/**
 * Where a bone is in the pose the player holds — world units, Y up, the
 * numbers `rig-c/core` posed (`RawBone`): the world matrix `a b c d`, the
 * world position, the world rotation of each axis in degrees and the world
 * scale of each, and whether the bone is active under the player's skin.
 */
export interface BoneWorld {
  name: string;
  active: boolean;
  x: number;
  y: number;
  a: number;
  b: number;
  c: number;
  d: number;
  rotationX: number;
  rotationY: number;
  scaleX: number;
  scaleY: number;
}

/**
 * Which slots a player draws: an allow list of slot names, or a predicate
 * over the name. The pose is the whole rig's whatever the filter — bones,
 * constraints, physics, `bone()` and `adjust` are untouched — and only the
 * draw is filtered. A clipping slot the filter leaves out does not clip.
 */
export type SlotFilter = readonly string[] | ((slot: string) => boolean);

/**
 * What a set call (`setSet`, `setSets`, `addSet`, `removeSet`) does with the
 * physics hung under the bones the switch re-poses (#173). Only a switch that
 * changes a set's `drawn` re-poses bones, so only then does it apply.
 *
 * - absent: nothing — the constraints read the jump as motion, as before.
 * - `'carry'`: each affected constraint's state is moved by the rigid turn its
 *   deepest re-posed ancestor makes, so the chain keeps its pose relative to
 *   the bone and does not snap.
 * - `'reset'`: each affected constraint starts again at the new pose, as a
 *   physics `reset` key restarts it.
 */
export interface SetActivationOptions {
  physics?: 'carry' | 'reset';
  /**
   * Seconds over which the switch eases the bones it re-poses (#174), instead
   * of snapping them: each covered bone whose drawn rotation this call adds,
   * removes or changes turns from the local it shows to its new one (the
   * drawn local, or the clip's value when its set goes) along the shorter
   * way, by smoothstep(elapsed / ease), and the attachments swap on the frame
   * nearest the middle. A finite number at or above 0; `0` or absent is the
   * instant switch. See `setSets`.
   */
  ease?: number;
}

/** `options.ease` of a set call, checked before anything changes: 0 when absent. */
function setEaseOption(call: string, options: SetActivationOptions | undefined): number {
  const ease = options?.ease;
  if (ease === undefined) return 0;
  if (typeof ease !== 'number' || !Number.isFinite(ease) || ease < 0) {
    throw new Error(`${call}: options.ease must be a finite number of seconds at or above 0, got ${typeof ease === 'number' ? String(ease) : JSON.stringify(ease)}`);
  }
  return ease;
}

/**
 * An eased set switch in flight (#174). Each eased bone turns from `from` to
 * `to`, each a fixed local rotation or `null` for the clip's value at the
 * time; `clip` holds the clip's local of each eased bone as the last pose
 * read it, before the override.
 */
interface SetEase {
  readonly duration: number;
  elapsed: number;
  readonly bones: ReadonlyMap<string, { readonly from: number | null; readonly to: number | null }>;
  readonly clip: Map<string, number>;
  /** The composition drawn until the swap: the one shown when the call was made. */
  readonly fromSet: RigSet | null;
  swapped: boolean;
  readonly physics: 'carry' | 'reset' | undefined;
}

/** u = elapsed / duration, clamped to [0, 1]. */
function easeProgress(ease: SetEase): number {
  return Math.min(Math.max(ease.elapsed / ease.duration, 0), 1);
}

/** smoothstep(u) = u²(3 − 2u): 0 → 1, flat at both ends, never outside [0, 1]. */
function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

/** `options.physics` of a set call, checked before anything changes. */
function setPhysicsOption(call: string, options: SetActivationOptions | undefined): 'carry' | 'reset' | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object') {
    throw new Error(`${call}: options must be an object like { physics: 'carry' }, got ${JSON.stringify(options)}`);
  }
  const physics = options.physics;
  if (physics === undefined || physics === 'carry' || physics === 'reset') return physics;
  throw new Error(`${call}: options.physics must be 'carry' or 'reset', got ${JSON.stringify(physics)}`);
}

/** The bones whose drawn rotation differs between `before` and `after` (added, removed or changed). */
function drawnChanged(before: ReadonlyMap<string, number> | null, after: ReadonlyMap<string, number> | null): Set<string> {
  const changed = new Set<string>();
  if (before !== null) for (const [bone, rotation] of before) if (after?.get(bone) !== rotation) changed.add(bone);
  if (after !== null) for (const [bone, rotation] of after) if (before?.get(bone) !== rotation) changed.add(bone);
  return changed;
}

/** The physics context a live stepper carries from step to step. */
function physicsContextOf(stepper: LiveTrack | LiveTracks): PhysicsContextInternal {
  return 'first' in stepper ? (stepper as unknown as TrackInternal).track.ctx : (stepper as unknown as TracksInternal).path.ctx;
}

/** A box in world units, Y up: `y` is the bottom edge. */
export interface PoseBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Why a slot in `SlotIdentitySnapshot.slots` is not drawn (`reason !== null`),
 * or `null` when it is drawn in `posedFrame().order`:
 * - `'set-hide'`: hidden by an active attachment set (`set.hides` or a
 *   `<base>_still` companion of a slot an active set covers or hides).
 * - `'timeline-null'`: an attachment timeline (or slider attachment timeline)
 *   keyed the slot to `null` at the current time.
 * - `'no-attachment'`: the slot has no drawable attachment at this pose
 *   (its setup placeholder is `null` with no timeline/set override, its
 *   placeholder is absent from the active and default skins, or its attachment
 *   is non-visual such as a clipping polygon, bounding box, or path).
 * - `'hidden'`: excluded from rendering by the player's `slots` filter or
 *   because its bone is inactive under the active skin.
 */
export type SlotIdentityReason = 'hidden' | 'no-attachment' | 'timeline-null' | 'set-hide';

/** One slot's resolved identity at `z` in the posed draw order (`SlotIdentitySnapshot.slots`). */
export interface SlotIdentity {
  /** The slot's name in `skeleton.model.json`. */
  readonly slot: string;
  /** Index (`0 .. slots.length - 1`) in the posed draw order. */
  readonly z: number;
  /** Resolved attachment key (`string`) when drawn, or `null` when not drawn. */
  readonly attachment: string | null;
  /** Owning skin name (`'default'`, named skin, etc.) for `attachment`, or `null` when `attachment === null`. */
  readonly skin: string | null;
  /** `null` when drawn in `posedFrame().order`; otherwise why the slot is not drawn. */
  readonly reason: SlotIdentityReason | null;
}

/**
 * Read-only slot identity snapshot coherent with the player's current pose
 * and `posedFrame()` (#144).
 */
export interface SlotIdentitySnapshot {
  /** Monotonic pose generation counter matching `player.generation` and `player.posedFrame().generation`. */
  readonly generation: number;
  /** The one active attachment set (`player.set`), or `null` when none or several are active. */
  readonly set: string | null;
  /** Every active attachment set (`player.activeSets`), in `sets.json` declaration order. */
  readonly sets: readonly string[];
  /** Currently active skin (`player.skin ?? null`), or `null` when only `'default'` is active. */
  readonly skin: string | null;
  /** Every slot of the skeleton in the posed draw order (`z = 0 .. slots.length - 1`), hidden/null ones included. */
  readonly slots: readonly SlotIdentity[];
}

/** An allow list as a predicate. */
function predicateOf(names: readonly string[]): (slot: string) => boolean {
  const allowed = new Set(names);
  return (slot) => allowed.has(slot);
}

/** Whether `slotName` is hidden by `set` (`set.hides` or a `<base>_still` companion of a covered/hidden base slot). */
function hiddenBySet(slotName: string, set: RigSet): boolean {
  if (set.hides.includes(slotName)) return true;
  if (slotName.endsWith('_still') && !(slotName in set.slots)) {
    const base = slotName.slice(0, -'_still'.length);
    if (base in set.slots || set.hides.includes(base)) return true;
  }
  return false;
}

/**
 * The slots `set` touches on `view`: every slot it covers plus every slot it
 * hides (`hides` and `<base>_still` companions). Two active sets must touch
 * disjoint slots (#168).
 */
function touchedBySet(view: CompiledDocument, set: RigSet): ReadonlySet<string> {
  const touched = new Set<string>();
  for (const slot of view.slots) {
    if (slot.name in set.slots || hiddenBySet(slot.name, set)) touched.add(slot.name);
  }
  return touched;
}

/** Degrees into (-180, 180]. */
function normaliseDegrees(deg: number): number {
  let v = ((deg % 360) + 360) % 360;
  if (v > 180) v -= 360;
  return v;
}

/**
 * The local rotations that put `drawn`'s bones at their world rotations at
 * the setup pose (#170), the way `@rig-c/parts` poses a set for `check --set`
 * (`poseRigBonesForDrawn`): bones in document order, each drawn bone's local
 * rotation the drawn angle less its world rotation at local 0, under its
 * already-posed parents, with no constraint applied. A bone hanging from a
 * stopped link's drawn twin `<link>_d` reads its parent as `<link>`, as
 * parts reads it (parts #404).
 */
function drawnLocals(view: CompiledDocument, drawn: Readonly<Record<string, number>>): ReadonlyMap<string, number> {
  const names = new Set(view.bones.map((b) => b.name));
  const realParent = (parent: string | undefined): string | undefined =>
    parent !== undefined && parent.endsWith('_d') && names.has(parent.slice(0, -2)) ? parent.slice(0, -2) : parent;
  const bones = view.bones.map((b) => ({ ...b, parent: realParent(b.parent) }));
  const locals = new Map<string, number>();
  for (let i = 0; i < bones.length; i++) {
    const target = drawn[bones[i].name];
    if (target === undefined) continue;
    bones[i] = { ...bones[i], rotation: 0 };
    const pose = poseRawSetup({ ...view, bones, slots: [], constraints: [] });
    const world = pose.bones.find((b) => b.name === bones[i].name);
    if (world === undefined) throw new Error(`drawn bone ${JSON.stringify(bones[i].name)} was not posed`);
    const rotation = normaliseDegrees(target - normaliseDegrees((Math.atan2(world.c, world.a) * 180) / Math.PI));
    bones[i] = { ...bones[i], rotation };
    locals.set(bones[i].name, rotation);
  }
  return locals;
}

/**
 * One set equivalent to `sets` applied together, or `null` for none. One set is
 * returned as it is; several, already checked disjoint, merge their `slots` and
 * `hides` (a slot one set touches no other set names, so the merge hides and
 * covers exactly what each set does alone and does not depend on order).
 */
function composeSets(sets: readonly RigSet[]): RigSet | null {
  if (sets.length === 0) return null;
  if (sets.length === 1) return sets[0];
  const drawn = sets.filter((s) => s.drawn !== undefined);
  return {
    name: sets.map((s) => s.name).join('+'),
    slots: Object.assign({}, ...sets.map((s) => s.slots)) as Record<string, string>,
    hides: sets.flatMap((s) => s.hides),
    ...(drawn.length === 0 ? {} : { drawn: Object.assign({}, ...drawn.map((s) => s.drawn)) as Record<string, number> }),
  };
}

/**
 * Applies `set` to `raw` over `view`: every slot the set covers takes the set's
 * attachment posed against `raw.bones` (keeping the slot's animated colour and
 * dark tint from `raw.slots`); every slot the set `hides` (plus any `<base>_still`
 * slot of a covered or hidden base slot) takes `attachment: null` and is removed
 * from `shown` / `drawn` / `clips`; every uncovered slot keeps its exact `raw.slots`
 * row, `shown` entry and `drawn` geometry (including any track attachment,
 * mesh deform or sequence frame).
 */
function applySetToPose(view: CompiledDocument, raw: RawPose, set: RigSet): RawPose {
  const coveredNames = new Set(Object.keys(set.slots));
  const overrideSlots = view.slots.flatMap((slot) => {
    const setup = set.slots[slot.name];
    return setup !== undefined ? [{ ...slot, setup }] : [];
  });
  const world = new Map(
    raw.bones.map((bone) => [
      bone.name,
      { a: bone.a, b: bone.b, c: bone.c, d: bone.d, worldX: bone.worldX, worldY: bone.worldY },
    ]),
  );
  const overridePose =
    overrideSlots.length > 0
      ? poseRawSetup(
          { ...view, slots: overrideSlots, constraints: [] },
          { evaluate: () => world, constraints: () => [] },
        )
      : null;
  const overRowBySlot = new Map<string, CoreSlotRow>();
  const overShownBySlot = new Map<string, RawPose['shown'][number]>();
  const overDrawnBySlot = new Map<string, RawDrawn>();
  const overClipBySlot = new Map<string, RawClip>();
  if (overridePose !== null) {
    for (const row of overridePose.slots) overRowBySlot.set(row[0], row);
    for (const s of overridePose.shown) overShownBySlot.set(s.slot, s);
    for (const d of overridePose.drawn) overDrawnBySlot.set(d.slot, d);
    for (const c of overridePose.clips) overClipBySlot.set(c[0], c);
  }
  const rawShownBySlot = new Map(raw.shown.map((s) => [s.slot, s]));
  const rawDrawnBySlot = new Map(raw.drawn.map((d) => [d.slot, d]));
  const rawClipBySlot = new Map(raw.clips.map((c) => [c[0], c]));
  const hiddenSlot = (slotName: string): boolean => hiddenBySet(slotName, set);
  const slots: CoreSlotRow[] = raw.slots.map((rawRow): CoreSlotRow => {
    const slotName = rawRow[0];
    if (hiddenSlot(slotName)) {
      return [slotName, null, rawRow[2], rawRow[3], rawRow[4], rawRow[5], rawRow[6], null, rawRow[8]];
    }
    const overRow = overRowBySlot.get(slotName);
    if (overRow !== undefined) {
      return [slotName, overRow[1], rawRow[2], rawRow[3], rawRow[4], rawRow[5], rawRow[6], overRow[7], rawRow[8]];
    }
    return rawRow;
  });
  const shown: RawPose['shown'][number][] = [];
  const drawn: RawDrawn[] = [];
  const clips: RawClip[] = [];
  for (const slotName of raw.drawOrder) {
    if (hiddenSlot(slotName)) continue;
    if (coveredNames.has(slotName)) {
      const s = overShownBySlot.get(slotName);
      if (s !== undefined) shown.push(s);
      const d = overDrawnBySlot.get(slotName);
      if (d !== undefined) drawn.push(d);
      const c = overClipBySlot.get(slotName);
      if (c !== undefined) clips.push(c);
    } else {
      const s = rawShownBySlot.get(slotName);
      if (s !== undefined) shown.push(s);
      const d = rawDrawnBySlot.get(slotName);
      if (d !== undefined) drawn.push(d);
      const c = rawClipBySlot.get(slotName);
      if (c !== undefined) clips.push(c);
    }
  }
  return {
    ...raw,
    slots,
    shown,
    drawn,
    clips,
  };
}

/** Up to 4,096 steps (~68.3 s at 60 Hz) are kept at stride 1; beyond that, every 8th step is kept. */
const SEEK_FINE_STEP_LIMIT = 4096;
const SEEK_COARSE_STRIDE = 8;
/** Maximum number of exact target-time snapshots retained per player. */
const SEEK_EXACT_LIMIT = 1024;

interface PhysicsStateInternal {
  pending: boolean;
  lastTime: number;
  remaining: number;
  ux: number;
  uy: number;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
  xOffset: number;
  xLag: number;
  xVelocity: number;
  yOffset: number;
  yLag: number;
  yVelocity: number;
  rotateOffset: number;
  rotateLag: number;
  rotateVelocity: number;
  scaleOffset: number;
  scaleLag: number;
  scaleVelocity: number;
}

interface PhysicsContextInternal {
  phase: 'reset' | 'update';
  time: number;
  states: Map<string, PhysicsStateInternal>;
  last: number;
  loop?: boolean;
  env?: RigEnvironment;
}

interface TrackInternal {
  readonly first: RawPose;
  readonly track: {
    trackTime: number;
    last: number;
    readonly ctx: PhysicsContextInternal;
  };
  steps: number;
  latest: number;
  refused: string | null;
}

interface MixerEntryInternal {
  delay: number;
  trackTime: number;
  trackLast: number;
  nextTrackLast: number;
  trackEnd: number;
  animationLast: number;
  nextAnimationLast: number;
  mixTime: number;
  mixDuration: number;
  totalAlpha: number;
  alpha: number;
  additive: boolean;
  keepHold: boolean;
  timelineMode: number[];
  timelineHoldMix: unknown[];
  timelinesRotation: number[];
}

interface TracksInternal {
  started: boolean;
  steps: number;
  time: number;
  refused: string | null;
  readonly path: {
    readonly ctx: PhysicsContextInternal;
  };
  readonly mixer: {
    readonly tracks: Array<MixerEntryInternal | null>;
    animationsChanged: boolean;
    readonly propertyIds: Map<string, number>;
  };
}

interface PhysicsContextSnapshot {
  readonly phase: 'reset' | 'update';
  readonly time: number;
  readonly last: number;
  readonly loop: boolean | undefined;
  readonly env: RigEnvironment | undefined;
  readonly states: ReadonlyMap<string, PhysicsStateInternal>;
}

interface TrackStateSnapshot {
  readonly kind: 'track';
  readonly steps: number;
  readonly latest: number;
  readonly refused: string | null;
  readonly trackTime: number;
  readonly last: number;
  readonly ctx: PhysicsContextSnapshot;
}

interface TracksStateSnapshot {
  readonly kind: 'tracks';
  readonly started: boolean;
  readonly steps: number;
  readonly time: number;
  readonly refused: string | null;
  readonly animationsChanged: boolean;
  readonly propertyIds: ReadonlyMap<string, number>;
  readonly entry: {
    readonly delay: number;
    readonly trackTime: number;
    readonly trackLast: number;
    readonly nextTrackLast: number;
    readonly trackEnd: number;
    readonly animationLast: number;
    readonly nextAnimationLast: number;
    readonly mixTime: number;
    readonly mixDuration: number;
    readonly totalAlpha: number;
    readonly alpha: number;
    readonly additive: boolean;
    readonly keepHold: boolean;
    readonly timelineMode: readonly number[];
    readonly timelineHoldMix: readonly unknown[];
    readonly timelinesRotation: readonly number[];
  } | null;
  readonly ctx: PhysicsContextSnapshot;
}

type StepperStateSnapshot = TrackStateSnapshot | TracksStateSnapshot;

interface SeekGridEntry {
  readonly state: StepperStateSnapshot;
  readonly rawPose: RawPose;
  readonly parameters: ReadonlyMap<string, PhysicsParameterRead>;
}

interface SeekExactEntry extends SeekGridEntry {
  readonly pose: RawPose;
}

interface SeekCache {
  readonly mode: 'track' | 'tracks';
  readonly frontier: LiveTrack | LiveTracks;
  frontierSteps: number;
  readonly grid: Map<number, SeekGridEntry>;
  readonly exact: Map<number, SeekExactEntry>;
}

function capturePhysicsContext(ctx: PhysicsContextInternal): PhysicsContextSnapshot {
  const states = new Map<string, PhysicsStateInternal>();
  for (const [name, s] of ctx.states) states.set(name, { ...s });
  return {
    phase: ctx.phase,
    time: ctx.time,
    last: ctx.last,
    loop: ctx.loop,
    env: ctx.env,
    states,
  };
}

function restorePhysicsContext(ctx: PhysicsContextInternal, snap: PhysicsContextSnapshot): void {
  ctx.phase = snap.phase;
  ctx.time = snap.time;
  ctx.last = snap.last;
  if (snap.loop === undefined) delete ctx.loop;
  else ctx.loop = snap.loop;
  if (snap.env === undefined) delete ctx.env;
  else ctx.env = snap.env;
  ctx.states.clear();
  for (const [name, s] of snap.states) ctx.states.set(name, { ...s });
}

function captureStepperState(stepper: LiveTrack | LiveTracks): StepperStateSnapshot {
  if ('first' in stepper) {
    const internal = stepper as unknown as TrackInternal;
    return {
      kind: 'track',
      steps: internal.steps,
      latest: internal.latest,
      refused: internal.refused,
      trackTime: internal.track.trackTime,
      last: internal.track.last,
      ctx: capturePhysicsContext(internal.track.ctx),
    };
  }
  const internal = stepper as unknown as TracksInternal;
  const entry = internal.mixer.tracks[0] ?? null;
  return {
    kind: 'tracks',
    started: internal.started,
    steps: internal.steps,
    time: internal.time,
    refused: internal.refused,
    animationsChanged: internal.mixer.animationsChanged,
    propertyIds: new Map(internal.mixer.propertyIds),
    entry:
      entry === null
        ? null
        : {
            delay: entry.delay,
            trackTime: entry.trackTime,
            trackLast: entry.trackLast,
            nextTrackLast: entry.nextTrackLast,
            trackEnd: entry.trackEnd,
            animationLast: entry.animationLast,
            nextAnimationLast: entry.nextAnimationLast,
            mixTime: entry.mixTime,
            mixDuration: entry.mixDuration,
            totalAlpha: entry.totalAlpha,
            alpha: entry.alpha,
            additive: entry.additive,
            keepHold: entry.keepHold,
            timelineMode: [...entry.timelineMode],
            timelineHoldMix: [...entry.timelineHoldMix],
            timelinesRotation: [...entry.timelinesRotation],
          },
    ctx: capturePhysicsContext(internal.path.ctx),
  };
}

function restoreStepperState(stepper: LiveTrack | LiveTracks, snap: StepperStateSnapshot): void {
  if (snap.kind === 'track') {
    const internal = stepper as unknown as TrackInternal;
    internal.steps = snap.steps;
    internal.latest = snap.latest;
    internal.refused = snap.refused;
    internal.track.trackTime = snap.trackTime;
    internal.track.last = snap.last;
    restorePhysicsContext(internal.track.ctx, snap.ctx);
    return;
  }
  const internal = stepper as unknown as TracksInternal;
  internal.started = snap.started;
  internal.steps = snap.steps;
  internal.time = snap.time;
  internal.refused = snap.refused;
  internal.mixer.animationsChanged = snap.animationsChanged;
  internal.mixer.propertyIds.clear();
  for (const [k, v] of snap.propertyIds) internal.mixer.propertyIds.set(k, v);
  const entry = internal.mixer.tracks[0] ?? null;
  if (entry !== null && snap.entry !== null) {
    entry.delay = snap.entry.delay;
    entry.trackTime = snap.entry.trackTime;
    entry.trackLast = snap.entry.trackLast;
    entry.nextTrackLast = snap.entry.nextTrackLast;
    entry.trackEnd = snap.entry.trackEnd;
    entry.animationLast = snap.entry.animationLast;
    entry.nextAnimationLast = snap.entry.nextAnimationLast;
    entry.mixTime = snap.entry.mixTime;
    entry.mixDuration = snap.entry.mixDuration;
    entry.totalAlpha = snap.entry.totalAlpha;
    entry.alpha = snap.entry.alpha;
    entry.additive = snap.entry.additive;
    entry.keepHold = snap.entry.keepHold;
    entry.timelineMode = [...snap.entry.timelineMode];
    entry.timelineHoldMix = [...snap.entry.timelineHoldMix];
    entry.timelinesRotation = [...snap.entry.timelinesRotation];
  }
  restorePhysicsContext(internal.path.ctx, snap.ctx);
}

export class RigPlayer {
  /**
   * The renderer this player draws through — its knobs and counters are the
   * caller's to read and set. A `DomRenderer` in the DOM mode, a
   * `CanvasRenderer` in the canvas mode; a new object after `mode` changes.
   */
  get renderer(): DomRenderer | CanvasRenderer {
    return this.active;
  }
  /** Multiplies every step. 0 holds the pose (nothing is re-posed); negative is refused by the track. */
  timeScale = 1;
  /** The player's whole-rig colour, r g b a — multiplied into every slot's tint. Not a document value. */
  color: [number, number, number, number] = [1, 1, 1, 1];

  private active: DomRenderer | CanvasRenderer;
  private readonly root: HTMLElement;
  private readonly assets: ModelAssets;
  private readonly meshBackend: MeshBackend | undefined;
  private view: CompiledDocument;
  private source: FrameSource;
  private readonly read: ReadDocument;
  private skinName: string | undefined;
  private readonly seekStep: number;
  /** The environment the page set, or null for the runtime's start values (`environment`). */
  private env: RigEnvironment | null = null;
  /**
   * The single live track (`openTrack`): what a plain `play` on track 0 runs
   * on, as every 1.x player did — one animation, every construct the core
   * poses, `seek` and a skin change by reopening. Null once the player is
   * composed.
   */
  private track: LiveTrack | null = null;
  /**
   * The live tracks (`openTracks`): opened by the first composing call — a
   * `play` with a mix or on another track, a `queue`, a `clear` — from the
   * single track's animation stepped to its time. The mixing is the Spine
   * runtime's, which does not mix a constraint, sequence, draw-order or
   * path-deform timeline, so such an animation is refused here and plays on
   * the single track only.
   */
  private tracks: LiveTracks | null = null;
  /** Track 0's animation and loop as `play` last set them — what `seek` and a skin change reopen. */
  private animation: string | null = null;
  private loop = true;
  /** One past the highest track touched — how many `current(track)` reads a step takes. */
  private trackCount = 0;
  /** `RigPlayerOptions.tracks`: every play opens the live tracks, never the single track. */
  private readonly trackMode: boolean;
  /** Set once anything beyond a plain play on track 0 happened: a mix, another track, a queue, a clear. `seek` and `skin` then cannot replay and refuse. */
  private beyondBase = false;
  private paused = false;
  private pose: RawPose | null = null;
  /** The un-overridden pose from the track/tracks (or setup pose when `setSet` is called before `play`). */
  private rawPose: RawPose | null = null;
  private setup: RawPose | null = null;
  private seekCache: SeekCache | null = null;
  private poseGeneration = 0;
  private runtimeModel: RuntimeModel | null = null;
  private runtimeFrames: RuntimeFrames | null = null;
  private runtimeReadback: RawPose | null = null;
  private runtimeCompletionClock = { trackTime: 0 };
  private poserLabel = 'oracle: not selected';
  private readonly oracleOnly: boolean;
  private readonly liveChecks: boolean;
  private liveDisposed = false;
  private cachedIdentity: SlotIdentitySnapshot | null = null;
  private cachedIdentityGen = -1;
  private readonly setList: readonly RigSet[];
  private readonly setsByName: ReadonlyMap<string, RigSet>;
  /** The active sets in declaration order (#168); `activeSet` is their composition. */
  private activeList: readonly RigSet[] = [];
  private activeSet: RigSet | null = null;
  private readonly touchedSets = new Map<string, ReadonlySet<string>>();
  /** The active sets' drawn bones as local rotations, applied before `adjust` on every pose (#170); null when none draws. */
  private drawnPose: ReadonlyMap<string, number> | null = null;
  /** Test-only (#173's planted control): `carry` maps every state through the identity instead of the anchor's turn. Not API. */
  private carryPlant = false;
  /** An eased set switch in flight (#174), or null. */
  private easing: SetEase | null = null;
  /** The last positive step `advance` took: what predicts the next one when an ease starts. */
  private lastStep = 0;
  /** Test-only (#174's planted controls): swap the attachments at u = 0, or ease by w = 1.2u (1 at u = 1). Not API. */
  private easePlant: 'swap-at-0' | 'overshoot' | null = null;
  private adjustFn: BoneAdjust | null = null;
  /** Current preview patches, reapplied through the public core API on replay; no edit history. */
  private readonly physicsPatches = new Map<string, PhysicsParameterPatch>();
  /** Public read snapshots belonging to a restored seek pose, not the core's private evaluation cache. */
  private heldParameters: ReadonlyMap<string, PhysicsParameterRead> | null = null;
  private slotFilter: SlotFilter | null = null;
  /** `slotFilter` as a predicate; every slot when null. */
  private draws: (slot: string) => boolean = () => true;
  /** Handed to every track the player opens; reads the current `adjust` so setting it later needs no reopen. */
  private readonly adjustHook: CoreLocalAdjust = (locals, ctx) => {
    if (this.easing !== null) this.applyEase(this.easing, locals);
    else if (this.drawnPose !== null) for (const [bone, rotation] of this.drawnPose) locals.bone(bone).rotation = rotation;
    if (this.adjustFn !== null) this.adjustFn(locals, ctx);
  };
  private readonly listeners = {
    event: new Set<Listener<RigEvent>>(),
    complete: new Set<Listener<RigComplete>>(),
  };

  constructor(root: HTMLElement, assets: ModelAssets, options: RigPlayerOptions = {}) {
    const read = assets.document as ReadDocument;
    this.read = read;
    if (options.poser !== undefined && options.poser !== 'auto' && options.poser !== 'oracle') throw new Error(`poser must be auto or oracle, got ${String(options.poser)}`);
    this.oracleOnly = options.poser === 'oracle';
    this.liveChecks = options.liveFrameChecks ?? (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
    this.skinName = options.skin;
    this.view = options.skin === undefined ? underNoSkin(read.doc) : underSkin(read.doc, options.skin);
    this.source = frameSource(this.view, read.parsed);
    this.seekStep = options.seekStep ?? 1 / 60;
    this.trackMode = options.tracks === true;
    if (!(this.seekStep > 0)) throw new Error(`seekStep must be a positive number of seconds, got ${String(options.seekStep)}`);
    this.root = root;
    this.assets = assets;
    this.setList = assets.sets ?? [];
    this.setsByName = new Map(this.setList.map((s) => [s.name, s]));
    this.meshBackend = options.meshBackend;
    this.adjustFn = options.adjust ?? null;
    if (options.slots !== undefined && options.slots !== null) this.slots = options.slots;
    this.poseGeneration = 0;
    this.cachedIdentity = null;
    this.active = this.create(options.mode ?? 'dom');
    this.selectRuntime();
  }

  /**
   * How the player draws. Setting it swaps the renderer without reloading
   * anything: the old one is disposed (its elements removed, its GPU pages
   * handed back), the new one is created over the same root and the same
   * assets, `pixelRatio` and `clipping` carry over, and the pose the player
   * holds is drawn again at once.
   */
  get mode(): RenderMode {
    return this.active instanceof CanvasRenderer ? 'canvas' : 'dom';
  }

  set mode(mode: RenderMode) {
    if (mode !== 'dom' && mode !== 'canvas') throw new Error(`mode must be 'dom' or 'canvas', got ${String(mode)}`);
    if (mode === this.mode) return;
    const old = this.active;
    const next = this.create(mode);
    next.pixelRatio = old.pixelRatio;
    next.clipping = old.clipping;
    old.dispose();
    this.active = next;
    this.draw();
  }

  private create(mode: RenderMode): DomRenderer | CanvasRenderer {
    if (mode === 'canvas') {
      const renderer = new CanvasRenderer(this.root, this.assets.pageImages);
      // The rig's own framing, so the canvas starts at the size the setup pose
      // needs rather than growing into it frame by frame.
      if (this.assets.stage) renderer.reserve(this.assets.stage);
      return renderer;
    }
    if (mode !== 'dom') throw new Error(`mode must be 'dom' or 'canvas', got ${String(mode)}`);
    if (this.assets.regions === 'none') {
      throw new Error(
        "these assets were loaded with regions: 'none' (no region bitmaps, for the canvas mode only); the DOM mode needs a load with regions 'atlas', 'blob' or 'data'",
      );
    }
    const renderer = new DomRenderer(this.root, this.assets.regionImages, this.assets.pageImages, this.assets.atlasRegions);
    if (this.meshBackend) renderer.meshBackend = this.meshBackend;
    return renderer;
  }

  /** What track 0 plays, or null before `play` and after a `clear` of track 0 has mixed out. */
  get current(): string | null {
    return this.tracks !== null ? (this.tracks.current(0)?.animation ?? null) : this.animation;
  }

  /** The player's time — the running sum of the steps since `play` (or the last `seek`). */
  get time(): number {
    return this.runtimeFrames?.pose.trackTime ?? this.tracks?.trackTime ?? this.track?.trackTime ?? 0;
  }

  /**
   * Plays `name` on a track — track 0 by default, which is what `play(name)`
   * has always meant: the first `play` opens the tracks at their first pose
   * with the physics reset there, and the pose is drawn on the next `frame`.
   * Later calls replace what the track plays: the entry it replaces mixes out
   * over `mix` seconds (0 cuts), and every entry queued on that track is
   * dropped. The pose the player holds is re-posed at once, so a held player
   * shows the change on its next `draw`. The mixing is the Spine runtime's,
   * which rig-c holds at tolerance 0; an animation keying what the tracks do
   * not mix — a constraint, a sequence, the draw order, a path's deform — is
   * refused here, by name, in the core's words.
   */
  play(name: string, options: PlayOptions = {}): void {
    const track = options.track ?? 0;
    const loop = options.loop ?? true;
    const mix = options.mix ?? 0;
    const alpha = options.alpha ?? 1;
    const additive = options.additive ?? false;
    this.paused = false;
    this.clearSeekCache();
    const plain = track === 0 && mix === 0 && alpha === 1 && !additive;
    if (!plain) this.beyondBase = true;
    if (this.tracks === null && plain && !this.trackMode) {
      if (this.tryRuntimePlay(name, loop)) return;
      this.oracle('animation not supported by the runtime');
      // A plain play on track 0: the single live track, reopened at the
      // animation's first pose with the physics reset there.
      this.animation = name;
      this.loop = loop;
      this.track = openTrack(this.view, name, { loop, reset: 'animation', adjust: this.adjustHook, clock: physicsClockStep });
      this.setRawPose(this.initializeSingle(this.track));
      this.applyEnvironment(this.track);
      return;
    }
    const tracks = this.compose();
    tracks.setAnimation(track, name, { loop, mixDuration: mix, alpha, additive });
    this.trackCount = Math.max(this.trackCount, track + 1);
    if (track === 0) {
      this.animation = name;
      this.loop = loop;
    }
    this.setRawPose(tracks.step(0));
  }

  /**
   * Queues `name` after the last entry on `track` (`QueueOptions`): with
   * `delay` at or below 0 it starts when that entry completes less its own
   * `mix`, so a one-shot hands over to it across a mix; on an empty track it
   * is set. Before any `play`, the tracks are opened for it.
   */
  queue(name: string, options: QueueOptions = {}): void {
    const track = options.track ?? 0;
    this.beyondBase = true;
    this.clearSeekCache();
    const tracks = this.compose();
    tracks.addAnimation(track, name, { loop: options.loop ?? true, mixDuration: options.mix ?? 0, delay: options.delay ?? 0, alpha: options.alpha ?? 1, additive: options.additive ?? false });
    this.trackCount = Math.max(this.trackCount, track + 1);
    this.setRawPose(tracks.step(0));
  }

  /**
   * Mixes `track` out to nothing over `mix` seconds — the layer or one-shot
   * gone and the tracks below showing through. Track 0 cleared shows the
   * setup pose. The pose the player holds is re-posed at once.
   */
  clear(track = 0, options: { mix?: number } = {}): void {
    this.beyondBase = true;
    this.clearSeekCache();
    const tracks = this.compose();
    tracks.setEmptyAnimation(track, options.mix ?? 0);
    this.trackCount = Math.max(this.trackCount, track + 1);
    this.setRawPose(tracks.step(0));
  }

  /**
   * Queues a mix out to nothing after the last entry on `track`, over `mix`
   * seconds; with `delay` 0 (the default) the mix ends as that entry
   * completes, so a one-shot queued this way plays once and fades out over
   * its last `mix` seconds.
   */
  queueClear(track = 0, options: { mix?: number; delay?: number } = {}): void {
    this.beyondBase = true;
    this.clearSeekCache();
    const tracks = this.compose();
    tracks.addEmptyAnimation(track, options.mix ?? 0, options.delay ?? 0);
    this.trackCount = Math.max(this.trackCount, track + 1);
    this.setRawPose(tracks.step(0));
  }

  /**
   * Sets the weight of `track`'s current entry, from 0 to 1, from the next pose
   * on — the pose the player holds is re-posed at once, so a held player shows
   * it on its next `draw`. An entry it is mixing from keeps its own weight. A
   * track playing nothing, or a weight outside 0..1, is refused in the core's
   * words. On the single track this composes: the player moves onto the tracks.
   */
  setAlpha(track: number, alpha: number): void {
    this.beyondBase = true;
    this.clearSeekCache();
    const tracks = this.compose();
    tracks.setAlpha(track, alpha);
    this.setRawPose(tracks.step(0));
  }

  /** `track`'s current entry, or null where it plays nothing (and before `play`). */
  entry(track = 0): TrackEntry | null {
    if (this.runtimeFrames !== null) {
      if (track !== 0 || this.animation === null) return null;
      const pose = this.runtimeFrames.pose;
      return { animation: this.animation, loop: this.loop, trackTime: pose.trackTime, animationTime: pose.time, duration: this.runtimeFrames.model.animation(this.animation).duration, alpha: 1, additive: false };
    }
    if (this.tracks !== null) {
      const view = this.tracks.current(track);
      return view === null
        ? null
        : { animation: view.animation, loop: view.loop, trackTime: view.trackTime, animationTime: view.animationTime, duration: view.duration, alpha: view.alpha, additive: view.additive };
    }
    const single = this.track;
    if (track !== 0 || single === null) return null;
    return { animation: this.animation, loop: this.loop, trackTime: single.trackTime, animationTime: single.animationTime, duration: single.duration, alpha: 1, additive: false };
  }

  /** Whether the player is composed: on the live tracks rather than the single track. */
  get composed(): boolean {
    return this.tracks !== null;
  }

  /**
   * The live tracks, opened by the first composing call (or by the first
   * `play` under `tracks: true`). A single track in play is carried over by
   * replay: track 0 set to its animation, pose 0 taken by `start()` (the
   * player's — nothing steps before it) and the tracks stepped to the single
   * track's time in `seekStep` increments, so a physics rig's history
   * restarts there and nothing is fired on the way. The core offers no
   * hand-over of a live track's state, so that replay costs one pose per
   * `seekStep` of time played — which `tracks: true` avoids entirely.
   */
  private compose(): LiveTracks {
    this.oracle('track composition');
    if (this.tracks !== null) return this.tracks;
    this.clearSeekCache();
    const tracks = openTracks(this.view, { reset: 'animation', adjust: this.adjustHook, clock: physicsClockStep });
    const single = this.track;
    const time = single?.trackTime ?? 0;
    if (single !== null && this.animation !== null) {
      tracks.setAnimation(0, this.animation, { loop: this.loop, mixDuration: 0 });
      this.trackCount = 1;
    }
    this.tracks = tracks;
    this.track = null;
    this.setRawPose(tracks.start());
    this.applyPhysicsParameters(tracks);
    this.applyEnvironment(tracks);
    if (time > 0) this.stepTo(time);
    return tracks;
  }

  /** Stores `raw` and applies the shown set (`activeSet`, or before an ease's swap the composition it eases from). Zero work when none. */
  private setRawPose(raw: RawPose): void {
    this.rawPose = raw;
    this.heldParameters = null;
    const set = this.shownSet();
    this.pose = set === null ? raw : applySetToPose(this.view, raw, set);
    this.poseGeneration++;
    this.cachedIdentity = null;
  }

  /**
   * Sets a named physics constraint's pending patch, after keyed/slider values
   * and before the integrator on the next evaluation. No pose or clock change.
   * Unknown names/kinds/fields and non-finite values are refused atomically by
   * the core. Requires a live track (call play/queue first).
   */
  setPhysicsParameters(name: string, patch: PhysicsParameterPatch): void {
    const live = this.requirePhysicsTrack('setPhysicsParameters', name);
    live.setPhysicsParameters(name, patch);
    const standing = live.readPhysicsParameters(name).override;
    if (standing !== null) this.physicsPatches.set(name, standing);
    this.clearSeekCache();
  }

  /** Pending override and the held pose's last active evaluation, detached. Does not evaluate a pose. */
  readPhysicsParameters(name: string): PhysicsParameterRead {
    const read = this.requirePhysicsTrack('readPhysicsParameters', name).readPhysicsParameters(name);
    if (this.heldParameters === null) return read;
    const effective = this.heldParameters.get(name)?.effective ?? null;
    return { override: read.override, effective: effective === null ? null : { ...effective } };
  }

  /** Removes only the patch; authored values resume next evaluation. Physics history is retained. */
  clearPhysicsParameters(name: string): void {
    this.requirePhysicsTrack('clearPhysicsParameters', name).clearPhysicsParameters(name);
    this.physicsPatches.delete(name);
    this.clearSeekCache();
  }

  private requirePhysicsTrack(operation: string, name: string): LiveTrack | LiveTracks {
    const live = this.stepper();
    if (live === null) throw new Error(`${operation}(${JSON.stringify(name)}) before play: no live track`);
    return live;
  }

  /** No private parameter state is copied into the core's seek snapshots. */
  private readParameters(live: LiveTrack | LiveTracks): ReadonlyMap<string, PhysicsParameterRead> {
    return new Map(this.view.constraints.filter((c) => c.kind === 'physics')
      .map((c) => [c.name, live.readPhysicsParameters(c.name)]));
  }

  private applyPhysicsParameters(live: LiveTrack | LiveTracks): void {
    for (const [name, patch] of this.physicsPatches) live.setPhysicsParameters(name, patch);
  }

  /** Like the environment, standing patches are pending after the ordinary first pose; no extra evaluation. */
  private initializeSingle(live: LiveTrack): RawPose {
    this.applyPhysicsParameters(live);
    return live.first;
  }

  /**
   * The world the rig's physics answers (#121): `wind` and `gravity`, as
   * spine-core's skeleton-level `windX/windY` and `gravityX/gravityY` — x to
   * the right and **y down**, the runtime's axes — to which each physics
   * constraint's authored `wind` / `gravity` is the response. The runtime's
   * start values are `{ wind: [1, 0], gravity: [0, 1] }`; a player never given
   * one poses exactly as it did without this method. A half left out keeps its
   * standing value, `null` returns both to the start values, and the call
   * applies from the next step on, at any time, with no ramp of the player's
   * own — the springs are the smoothing. It is the player's, not a track's:
   * every track and layer answers the same world, and a `seek` or a replay
   * poses under the environment as it stands (no history is kept). Returns the
   * environment now standing.
   */
  environment(environment?: Partial<RigEnvironment> | null): RigEnvironment {
    if (environment === null) {
      this.env = null;
      this.clearSeekCache();
      this.stepper()?.setEnvironment(DEFAULT_ENVIRONMENT);
    } else if (environment !== undefined) {
      this.clearSeekCache();
      const live = this.stepper();
      if (live) {
        live.setEnvironment(environment);
        this.env = live.environment;
      } else {
        const base = this.env ?? DEFAULT_ENVIRONMENT;
        this.env = { wind: environment.wind ?? base.wind, gravity: environment.gravity ?? base.gravity };
      }
    }
    return this.stepper()?.environment ?? this.env ?? DEFAULT_ENVIRONMENT;
  }

  /**
   * The page moved or turned the whole rig since the last step (#121), in the
   * skeleton's world — units, y up, degrees counter-clockwise — so physics
   * sees it the way spine-core's `Skeleton.physicsTranslate` /
   * `physicsRotate(0, 0, Δ)` make it: a rig dragged across the page trails
   * its cloth. The root element's layout stays the caller's; this tells the
   * physics what the caller did to it (a page-pixel delta divided by the
   * root's scale, its y negated). Applies to the next step; before `play`
   * there is nothing to move.
   */
  moved(motion: { x?: number; y?: number; rotation?: number }): void {
    if (this.runtimeFrames !== null && Number.isFinite(motion.x ?? 0) && Number.isFinite(motion.y ?? 0) && Number.isFinite(motion.rotation ?? 0)) return;
    const live = this.stepper();
    if (!live) return;
    const x = motion.x ?? 0;
    const y = motion.y ?? 0;
    if (x !== 0 || y !== 0) live.physicsTranslate(x, y);
    if (motion.rotation) live.physicsRotate(0, 0, motion.rotation);
  }

  /** Stops stepping; `frame` keeps drawing the pose it holds. */
  pause(): void {
    this.paused = true;
  }

  /** Resumes stepping after `pause`. */
  resume(): void {
    this.paused = false;
  }

  /**
   * Moves a single animation on track 0 to `time`: snapshot-backed deterministic
   * seek (#141) that produces the exact pose and physics state of reopening at 0
   * and stepping forward in `seekStep` increments (the last one shorter) until
   * `time` is reached. Events and completes crossed on the way are not fired.
   * It has a meaning for one animation on one track only — the player cannot
   * replay when a mix, a second track or a queue was asked for — so after any
   * of those it refuses by name; step the player forward instead.
   */
  seek(time: number): void {
    if (this.animation === null) throw new Error('seek before play: no animation is open');
    if (!(time >= 0) || !Number.isFinite(time)) throw new Error(`seek time must be a finite time at or above 0, got ${String(time)}`);
    if (this.beyondBase) throw new Error('seek is defined for a single animation on track 0; after a mix, another track, a queue or a clear the player cannot replay to a time — step it forward with frame/advance instead');
    if (this.runtimeFrames !== null) {
      // Keep the documented replay clock, including floating-point accumulation.
      // A direct jump to `time` can differ from the old seek's last pose by ulps.
      const steps = Math.floor(time / this.seekStep);
      let replayTime = 0;
      for (let i = 0; i < steps; i++) replayTime += this.seekStep;
      const rest = time - replayTime;
      if (rest > 0) replayTime += rest;
      this.runtimeFrames.pose.trackTime = replayTime;
      this.applyRuntimeTime();
      return;
    }
    // A replay has no history to ease through: an eased switch in flight lands at once.
    this.easing = null;
    const cache = this.ensureSeekCache();
    const stepper = this.tracks ?? (this.track as LiveTrack);
    const exactHit = cache.exact.get(time);
    if (exactHit !== undefined) {
      restoreStepperState(stepper, exactHit.state);
      this.rawPose = exactHit.rawPose;
      this.pose = exactHit.pose;
      this.heldParameters = exactHit.parameters;
      this.poseGeneration++;
      this.cachedIdentity = null;
      return;
    }
    const steps = Math.floor(time / this.seekStep);
    while (cache.frontierSteps < steps) {
      const raw = cache.frontier.step(this.seekStep);
      cache.frontierSteps++;
      if (cache.frontierSteps <= SEEK_FINE_STEP_LIMIT || cache.frontierSteps % SEEK_COARSE_STRIDE === 0) {
        cache.grid.set(cache.frontierSteps, {
          state: captureStepperState(cache.frontier),
          rawPose: raw,
          parameters: this.readParameters(cache.frontier),
        });
      }
    }
    let parameters: ReadonlyMap<string, PhysicsParameterRead>;
    const gridHit = cache.grid.get(steps);
    if (gridHit !== undefined) {
      restoreStepperState(stepper, gridHit.state);
      this.rawPose = gridHit.rawPose;
      parameters = gridHit.parameters;
    } else {
      const baseStep = steps - (steps % SEEK_COARSE_STRIDE);
      const baseSnap = cache.grid.get(baseStep) as SeekGridEntry;
      restoreStepperState(stepper, baseSnap.state);
      this.rawPose = baseSnap.rawPose;
      for (let i = baseStep; i < steps; i++) this.rawPose = stepper.step(this.seekStep);
      parameters = this.readParameters(stepper);
    }
    const rest = time - stepper.trackTime;
    if (rest > 0) {
      this.rawPose = stepper.step(rest);
      parameters = this.readParameters(stepper);
    }
    if (this.rawPose !== null) this.setRawPose(this.rawPose);
    this.heldParameters = parameters;
    if (this.rawPose !== null && this.pose !== null) {
      if (cache.exact.size >= SEEK_EXACT_LIMIT) {
        const oldest = cache.exact.keys().next().value;
        if (oldest !== undefined) cache.exact.delete(oldest);
      }
      cache.exact.set(time, {
        state: captureStepperState(stepper),
        rawPose: this.rawPose,
        pose: this.pose,
        parameters,
      });
    }
  }

  private clearSeekCache(): void {
    this.seekCache = null;
  }

  private ensureSeekCache(): SeekCache {
    const mode = this.tracks !== null ? 'tracks' : 'track';
    if (this.seekCache !== null && this.seekCache.mode === mode) {
      return this.seekCache;
    }
    if (this.tracks === null && this.track === null) {
      this.reopen();
    }
    let frontier: LiveTrack | LiveTracks;
    let firstPose: RawPose;
    if (mode === 'tracks') {
      const tracks = openTracks(this.view, { reset: 'animation', adjust: this.adjustHook, clock: physicsClockStep });
      tracks.setAnimation(0, this.animation as string, { loop: this.loop, mixDuration: 0 });
      firstPose = tracks.start();
      this.applyPhysicsParameters(tracks);
      this.applyEnvironment(tracks);
      frontier = tracks;
    } else {
      const track = openTrack(this.view, this.animation as string, { loop: this.loop, reset: 'animation', adjust: this.adjustHook, clock: physicsClockStep });
      firstPose = this.initializeSingle(track);
      this.applyEnvironment(track);
      frontier = track;
    }
    const grid = new Map<number, SeekGridEntry>();
    grid.set(0, { state: captureStepperState(frontier), rawPose: firstPose, parameters: this.readParameters(frontier) });
    this.seekCache = {
      mode,
      frontier,
      frontierSteps: 0,
      grid,
      exact: new Map<number, SeekExactEntry>(),
    };
    return this.seekCache;
  }

  /** Whatever is open, opened again with track 0's animation as `play` last set it, at pose 0: the single track, or the tracks under `tracks: true`. */
  private reopen(): void {
    if (this.tracks !== null) {
      const tracks = openTracks(this.view, { reset: 'animation', adjust: this.adjustHook, clock: physicsClockStep });
      tracks.setAnimation(0, this.animation as string, { loop: this.loop, mixDuration: 0 });
      this.trackCount = 1;
      this.tracks = tracks;
      this.setRawPose(tracks.start());
      this.applyPhysicsParameters(tracks);
      this.applyEnvironment(tracks);
      return;
    }
    this.track = openTrack(this.view, this.animation as string, { loop: this.loop, reset: 'animation', adjust: this.adjustHook, clock: physicsClockStep });
    this.setRawPose(this.initializeSingle(this.track));
    this.applyEnvironment(this.track);
  }

  /** What is open: the tracks, the single track, or nothing before `play`. */
  private stepper(): LiveTrack | LiveTracks | null {
    this.oracle('oracle track operation');
    return this.tracks ?? this.track;
  }

  /** A newly opened track or tracks answer the environment the player stands in; one never set leaves it untouched. */
  private applyEnvironment(live: LiveTrack | LiveTracks): void {
    if (this.env !== null) live.setEnvironment(this.env);
  }

  /** Steps whatever is open forward to `time` in `seekStep` increments, the last one shorter. */
  private stepTo(time: number): void {
    const stepper = this.tracks ?? (this.track as LiveTrack);
    const steps = Math.floor(time / this.seekStep);
    for (let i = 0; i < steps; i++) this.rawPose = stepper.step(this.seekStep);
    const rest = time - stepper.trackTime;
    if (rest > 0) this.rawPose = stepper.step(rest);
    if (this.rawPose !== null) this.setRawPose(this.rawPose);
  }

  /** Adds a listener; returns a function that removes it. */
  on(type: 'event', listener: Listener<RigEvent>): () => void;
  on(type: 'complete', listener: Listener<RigComplete>): () => void;
  on(type: 'event' | 'complete', listener: Listener<never>): () => void {
    const set = this.listeners[type] as Set<Listener<never>>;
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * Advances the track by `dt × timeScale` seconds and draws the pose —
   * `advance(dt)` then `draw()`.
   */
  frame(dt: number): void {
    this.advance(dt);
    this.draw();
  }

  /**
   * Steps the track by `dt × timeScale` seconds and fires the step's listeners,
   * without drawing. A paused player, or a step of zero, keeps the pose it
   * holds without re-posing it, so a held rig costs the renderer's dirty
   * checks and nothing else. The physics clock moves by `physicsClockStep`
   * of the step — the step and 2⁻³⁰ of it more, rig-c's render clock — so a
   * caller stepping at a fixed rate whose frame is a whole number of physics
   * steps (`frame(1/60)`, a capture) shows no spring jump; the animation time,
   * the events and `time` stay on the steps themselves (#103).
   */
  advance(dt: number): void {
    if (this.runtimeFrames !== null) {
      const step = dt * this.timeScale;
      if (this.paused || !(step > 0)) return;
      if (!Number.isFinite(step)) throw new Error(`advance step must be finite, got ${String(step)}`);
      const before = this.runtimeFrames.pose.trackTime;
      const duration = this.runtimeFrames.model.animations.get(this.animation as string)!.duration;
      this.runtimeFrames.pose.trackTime += step;
      this.lastStep = step;
      this.applyRuntimeTime();
      const completionClock = this.runtimeCompletionClock;
      if (this.listeners.event.size > 0) {
        // A listener may play/seek/advance again, overwriting the borrowed list.
        // Preserve this delivery batch exactly as the oracle's detached rows do.
        const events = this.runtimeFrames.pose.events.slice();
        for (const key of events) {
          const payload: RigEvent = { name: key.name, time: key.time, int: key.int, float: key.float, string: key.string, track: 0 };
          for (const listener of this.listeners.event) listener(payload);
        }
      }
      if (this.listeners.complete.size > 0) {
        // Retain this play entry, as dispatchSingle retains its LiveTrack.
        // seek/advance inside delivery changes its clock; play replaces it.
        const after = completionClock.trackTime;
        const complete = this.loop ? (duration === 0 || Math.floor(after / duration) > Math.floor(before / duration)) : before < duration && after >= duration;
        if (complete) {
          const payload: RigComplete = { animation: this.animation as string, track: 0 };
          for (const listener of this.listeners.complete) listener(payload);
        }
      }
      return;
    }
    if (this.pose === null) return;
    const step = dt * this.timeScale;
    if (this.paused || !(step > 0)) return;
    this.lastStep = step;
    if (this.easing !== null) this.advanceEase(this.easing, step);
    const tracks = this.tracks;
    if (tracks !== null) {
      const before: Array<TrackEntryView | null> = [];
      for (let t = 0; t < this.trackCount; t++) before.push(tracks.current(t));
      const raw = tracks.step(step);
      this.setRawPose(raw);
      this.dispatch(raw, before, tracks);
      return;
    }
    const track = this.track;
    if (track === null) return;
    const before = track.trackTime;
    const raw = track.step(step);
    this.setRawPose(raw);
    this.dispatchSingle(raw, before, track);
  }

  /** Draws the pose the player holds. */
  draw(): void {
    if (this.runtimeFrames !== null) {
      this.runtimeFrames.update(this.poseGeneration, this.color, this.draws, false);
      this.renderer.render(this.runtimeFrames.live);
      return;
    }
    if (this.pose === null) return;
    this.renderer.render(this.posedFrame());
  }

  /**
   * The skin the rig is posed under — `RigPlayerOptions.skin`, or undefined
   * for no skin set. Setting it re-resolves the pose under the new skin
   * (which attachment each slot shows, which bones and constraints are
   * active) and keeps the animation, its loop and its track time: the track
   * is reopened under the new skin and stepped to the same time the way
   * `seek` does, so a physics rig's history restarts there and nothing is
   * fired on the way. The pose is drawn on the next `draw`/`frame`. An
   * unknown skin is refused by name, and the player is left as it was.
   */
  get skin(): string | undefined {
    return this.skinName;
  }

  set skin(name: string | undefined) {
    if (name === this.skinName) return;
    if (this.beyondBase) throw new Error('skin cannot change after a mix, another track, a queue or a clear: the player cannot replay those to the current time — set it before composing, or play again');
    const view = name === undefined ? underNoSkin(this.read.doc) : underSkin(this.read.doc, name);
    this.oracle('skin change');
    this.view = view;
    this.source = frameSource(view, this.read.parsed);
    this.selectRuntime();
    this.skinName = name;
    this.setup = null;
    this.easing = null;
    this.clearSeekCache();
    if (this.animation !== null && (this.track !== null || this.tracks !== null)) {
      const time = this.time;
      const animation = this.animation;
      const animationTime = this.entry(0)!.animationTime;
      if (this.tryRuntimePlay(animation, this.loop)) {
        const frames = this.runtimeFrames!;
        frames.pose.restore(animation, time, animationTime);
        this.poseGeneration++;
        this.cachedIdentity = null;
        this.runtimeReadback = null;
        frames.update(this.poseGeneration, this.color, this.draws);
        return;
      }
      this.reopen();
      this.stepTo(time);
    } else if (this.rawPose !== null) {
      this.setRawPose(this.drawnSetup());
    } else {
      this.poseGeneration++;
      this.cachedIdentity = null;
    }
  }

  /**
   * The named attachment sets declared in `sets.json` (`ModelAssets.sets`),
   * with the slots each covers (`slots`) and hides (`hides`). Empty (`[]`)
   * when the build has no `sets.json`.
   */
  sets(): readonly RigSet[] {
    return this.setList;
  }

  /**
   * The active attachment set's name when exactly one is active; `null` when
   * the base attachments are active or when several sets are (read
   * `activeSets` for the list).
   */
  get set(): string | null {
    return this.activeList.length === 1 ? this.activeList[0].name : null;
  }

  /** Every active attachment set's name, in `sets.json` declaration order (`[]` when none). */
  get activeSets(): readonly string[] {
    return this.activeList.map((s) => s.name);
  }

  /**
   * Switches the active attachment set (#134): every slot the set covers takes
   * the set's attachment (`null` restores the base / track attachments), and
   * every slot the set `hides` (plus any `<base>_still` slot of a covered or
   * hidden base slot) is hidden. Applied immediately to the pose the player
   * holds (including the setup pose before `play`) and after track evaluation
   * on every subsequent `advance`, so a track key on a covered slot is
   * overridden while the set is active and restored when cleared (`setSet(null)`).
   * Uncovered slots keep their track attachments, mesh deforms and sequence
   * frames untouched; when no set is active (`null`), track evaluation runs
   * with zero overhead and produces byte-identical poses.
   *
   * A set with `drawn` (#170) also poses its bones at those world angles, as
   * `@rig-c/parts check --set` does, replacing a clip's rotation of them.
   *
   * `setSet(name)` means exactly this one set: any other active sets are
   * cleared (`setSets([name])`), and `setSet(null)` is `setSets([])`.
   *
   * A name not in `sets.json` throws by name; a build without `sets.json` has
   * `sets()` empty and `setSet` throws.
   */
  setSet(name: string | null, options?: SetActivationOptions): void {
    if (this.setList.length === 0) {
      throw new Error(`cannot setSet(${JSON.stringify(name)}): this model has no sets.json`);
    }
    const physics = setPhysicsOption('setSet', options);
    const ease = setEaseOption('setSet', options);
    this.activate(name === null ? [] : [this.namedSet(name)], physics, ease);
  }

  /**
   * Makes exactly `names` the active attachment sets (#168), together: each
   * set covers and hides its slots as it does alone, provided no two of them
   * touch the same slot (cover it, hide it, or hide it as a `<base>_still`
   * companion). Composition does not depend on the order of `names`. An
   * unknown name, a repeated name or two sets touching one slot throw by name
   * and leave the active sets as they were; `[]` restores the base.
   *
   * `options.physics` (#173) decides what a switch that re-poses `drawn` bones
   * does to the physics constraints hung under them — on a bone whose drawn
   * rotation this call adds, removes or changes, or on a descendant of one:
   * `'carry'` moves each one's remembered state (where its bone was and
   * pointed) by the rigid turn of its deepest re-posed ancestor, so the chain
   * keeps its pose relative to the bone; `'reset'` restarts each one at the
   * new pose, as a physics `reset` key does. Absent, the constraints read the
   * jump as motion and kick, as they always have. Anything else throws before
   * anything changes. Nothing to do before `play` or when no physics hangs
   * under a re-posed bone. A later `seek` replays from the start with the sets
   * then active and does not reproduce a carried switch. `setSet`, `addSet`
   * and `removeSet` take the same option.
   *
   * `options.ease` (#174, seconds, a finite number at or above 0) eases the
   * bones the call re-poses instead of snapping them. Each bone whose drawn
   * rotation the call adds, removes or changes turns from what it shows to
   * its new local rotation along the shorter way, as
   * `start + shortestΔ(start, end) · smoothstep(elapsed / ease)`: going on,
   * from the clip's value at the time to the drawn local; going off, from the
   * drawn local to the clip's value. The attachments the pose draws stay the
   * previous ones until the frame whose `elapsed / ease` is nearest ½ (the
   * next step predicted from the current one; a tie goes to the later frame),
   * then become the call's; `activeSets` and `slotIdentity().sets` name the
   * call's sets at once, while `slotIdentity().slots` follows what is drawn.
   * On the frame the elapsed time reaches `ease` the player is in exactly the
   * instant switch's state. The elapsed time is the player's step
   * (`dt × timeScale`), so a paused player or a zero step holds the ease;
   * before `play`, or when no bone's rotation changes, the switch is instant.
   * A call during an ease eases again from the angles shown (a call without
   * `ease` lands it at once), and `seek` or a skin change lands it at once.
   * With `physics: 'carry'` the chains under the eased bones are carried on
   * every eased frame, by the turn that frame's blend makes; with `'reset'`
   * they restart once, at the call. `0` or absent is the instant switch on
   * the same code path; anything else throws by name before anything changes.
   */
  setSets(names: readonly string[], options?: SetActivationOptions): void {
    if (this.setList.length === 0) {
      throw new Error(`cannot setSets(${JSON.stringify(names)}): this model has no sets.json`);
    }
    const physics = setPhysicsOption('setSets', options);
    const ease = setEaseOption('setSets', options);
    const sets = names.map((name) => this.namedSet(name));
    for (let i = 0; i < sets.length; i++) {
      for (let j = 0; j < i; j++) {
        if (sets[i] === sets[j]) throw new Error(`set ${JSON.stringify(sets[i].name)} is named twice in setSets`);
      }
    }
    this.activate(sets, physics, ease);
  }

  /**
   * Activates `name` beside the sets already active (#168): a set already
   * active is left as it is; one touching a slot an active set touches throws
   * by name (the slot and both sets) and changes nothing.
   */
  addSet(name: string, options?: SetActivationOptions): void {
    if (this.setList.length === 0) {
      throw new Error(`cannot addSet(${JSON.stringify(name)}): this model has no sets.json`);
    }
    const physics = setPhysicsOption('addSet', options);
    const ease = setEaseOption('addSet', options);
    const found = this.namedSet(name);
    if (this.activeList.includes(found)) return;
    this.activate([...this.activeList, found], physics, ease);
  }

  /**
   * Deactivates `name`, keeping every other active set (#168). An unknown name
   * throws by name; a set that is not active is left as it is.
   */
  removeSet(name: string, options?: SetActivationOptions): void {
    if (this.setList.length === 0) {
      throw new Error(`cannot removeSet(${JSON.stringify(name)}): this model has no sets.json`);
    }
    const physics = setPhysicsOption('removeSet', options);
    const ease = setEaseOption('removeSet', options);
    const found = this.namedSet(name);
    if (!this.activeList.includes(found)) return;
    this.activate(this.activeList.filter((s) => s !== found), physics, ease);
  }

  /** The declared set named `name`, or a throw naming it and the available sets. */
  private namedSet(name: string): RigSet {
    const found = this.setsByName.get(name);
    if (found === undefined) {
      throw new Error(
        `no set named ${JSON.stringify(name)} in sets.json (available: ${this.setList.map((s) => s.name).join(', ')})`,
      );
    }
    return found;
  }

  /**
   * Poses again after the drawn bones changed (#170): through the tracks at
   * the same time when the player has played, else the setup pose with the
   * drawn bones at their rotations.
   */
  private reposeDrawn(): void {
    const stepper = this.tracks ?? this.track;
    if (stepper !== null && this.pose !== null) {
      this.setRawPose(stepper.step(0));
      return;
    }
    this.setRawPose(this.drawnSetup());
  }

  /** The setup pose with the active sets' drawn bones at their rotations (#170); the plain setup pose when none draws. */
  private drawnSetup(): RawPose {
    const setup = this.setup ?? (this.setup = poseRawSetup(this.view));
    if (this.drawnPose === null) return setup;
    return poseRawSetup({
      ...this.view,
      bones: this.view.bones.map((b) => {
        const rotation = this.drawnPose?.get(b.name);
        return rotation === undefined ? b : { ...b, rotation };
      }),
    });
  }

  /** The slots `set` touches, computed once per set. */
  private touched(set: RigSet): ReadonlySet<string> {
    let touched = this.touchedSets.get(set.name);
    if (touched === undefined) {
      touched = touchedBySet(this.view, set);
      this.touchedSets.set(set.name, touched);
    }
    return touched;
  }

  /**
   * The physics under the bones a set switch re-poses (#173), before the
   * repose step: the `changed` bones' rotations went from what the held pose
   * shows to what the player now applies (`drawnPose`, or an ease's next
   * blend, #174), and every physics constraint whose bone is one of the
   * changed bones or a descendant of one is carried or reset. Nothing to do
   * before `play` (the setup pose carries no physics state) or when no
   * constraint hangs under a changed bone.
   */
  private handOverPhysics(changed: ReadonlySet<string>, mode: 'carry' | 'reset'): void {
    const stepper = this.tracks ?? this.track;
    if (stepper === null || this.pose === null || this.rawPose === null) return;
    if (changed.size === 0) return;
    const parentOf = new Map(this.view.bones.map((b) => [b.name, b.parent]));
    /** The deepest changed bone on the way from `bone` to the root (itself included). */
    const anchorOf = (bone: string): string | undefined => {
      for (let b: string | undefined = bone; b !== undefined; b = parentOf.get(b)) if (changed.has(b)) return b;
      return undefined;
    };
    const ctx = physicsContextOf(stepper);
    const affected: Array<{ name: string; anchor: string }> = [];
    for (const c of this.view.constraints) {
      if (c.kind !== 'physics') continue;
      const bone = (c.record as { bone?: string } | undefined)?.bone;
      const anchor = bone === undefined ? undefined : anchorOf(bone);
      if (anchor === undefined) continue;
      const state = ctx.states.get(c.name);
      // A constraint not updated yet, or pending, takes its bone as it finds it on its next update.
      if (state === undefined || state.pending) continue;
      affected.push({ name: c.name, anchor });
    }
    if (affected.length === 0) return;
    if (mode === 'reset') {
      for (const { name } of affected) {
        const s = ctx.states.get(name) as PhysicsStateInternal;
        s.remaining = 0;
        s.lastTime = ctx.time;
        s.pending = true;
        s.xOffset = s.xLag = s.xVelocity = 0;
        s.yOffset = s.yLag = s.yVelocity = 0;
        s.rotateOffset = s.rotateLag = s.rotateVelocity = 0;
        s.scaleOffset = s.scaleLag = s.scaleVelocity = 0;
      }
      return;
    }
    // carry: W_old from the held pose, W_new from a trial step(0) under the new drawn rotations, undone.
    const anchors = new Set(affected.map((a) => a.anchor));
    const worlds = (pose: RawPose): Map<string, RawPose['bones'][number]> => {
      const out = new Map<string, RawPose['bones'][number]>();
      for (const b of pose.bones) if (anchors.has(b.name)) out.set(b.name, b);
      return out;
    };
    const old = worlds(this.rawPose);
    const snapshot = captureStepperState(stepper);
    const now = worlds(stepper.step(0));
    // The restore puts copies back: the states are read again by name below.
    restoreStepperState(stepper, snapshot);
    const maps = new Map<string, readonly [number, number, number, number, number, number]>();
    for (const anchor of anchors) {
      const o = old.get(anchor);
      const n = now.get(anchor);
      if (o === undefined || n === undefined) continue;
      if (this.carryPlant) {
        maps.set(anchor, [1, 0, 0, 1, 0, 0]);
        continue;
      }
      // M = W_new ∘ W_old⁻¹, as [a, b, c, d, x, y].
      const det = o.a * o.d - o.b * o.c;
      // A zero-scale anchor has no inverse: its chains are left as they are, as without the option, rather than written NaN.
      if (!Number.isFinite(det) || det === 0) continue;
      const ia = o.d / det;
      const ib = -o.b / det;
      const ic = -o.c / det;
      const id = o.a / det;
      const a = n.a * ia + n.b * ic;
      const b = n.a * ib + n.b * id;
      const c = n.c * ia + n.d * ic;
      const d = n.c * ib + n.d * id;
      maps.set(anchor, [a, b, c, d, n.worldX - (a * o.worldX + b * o.worldY), n.worldY - (c * o.worldX + d * o.worldY)]);
    }
    const states = physicsContextOf(stepper).states;
    for (const { name, anchor } of affected) {
      const m = maps.get(anchor);
      const s = states.get(name);
      if (m === undefined || s === undefined) continue;
      const [a, b, c, d, x, y] = m;
      const ux = s.ux;
      s.ux = a * ux + b * s.uy + x;
      s.uy = c * ux + d * s.uy + y;
      const cx = s.cx;
      s.cx = a * cx + b * s.cy + x;
      s.cy = c * cx + d * s.cy + y;
      const tx = s.tx;
      s.tx = a * tx + b * s.ty;
      s.ty = c * tx + d * s.ty;
    }
  }

  /**
   * The composition the held pose draws: `activeSet`, except before an ease's
   * swap (#174), when it is the composition the ease started from.
   */
  private shownSet(): RigSet | null {
    const easing = this.easing;
    return easing === null || easing.swapped ? this.activeSet : easing.fromSet;
  }

  /** The local an eased bone shows at the ease's current progress, given the clip's local `clip`. */
  private easedLocal(easing: SetEase, from: number | null, to: number | null, clip: number): number {
    const start = from ?? clip;
    const end = to ?? clip;
    const u = easeProgress(easing);
    const w = this.easePlant === 'overshoot' ? (u < 1 ? 1.2 * u : 1) : smoothstep(u);
    return start + normaliseDegrees(end - start) * w;
  }

  /**
   * The ease's part of `adjustHook` (#174): every drawn bone the ease does not
   * turn takes its drawn local, as without an ease; every eased bone reads
   * the clip's local (what the timelines left) and then takes its blend.
   */
  private applyEase(easing: SetEase, locals: Parameters<CoreLocalAdjust>[0]): void {
    for (const bone of easing.bones.keys()) easing.clip.set(bone, locals.bone(bone).rotation);
    if (this.drawnPose !== null) {
      for (const [bone, rotation] of this.drawnPose) if (!easing.bones.has(bone)) locals.bone(bone).rotation = rotation;
    }
    for (const [bone, { from, to }] of easing.bones) {
      locals.bone(bone).rotation = this.easedLocal(easing, from, to, easing.clip.get(bone) as number);
    }
  }

  /**
   * Starts an eased switch (#174) to the sets already made active, from what
   * the held pose shows: an eased bone's start is the local it shows (fixed),
   * or the clip's value for a bone that showed the clip's; its end is the new
   * drawn local, or the clip's value for a bone whose set went. Returns false,
   * changing nothing, when there is nothing to ease — before `play` (no step
   * to ease over) or when no bone's rotation changes — and the call is then
   * an instant one.
   */
  private startEase(duration: number, shownBefore: RigSet | null, drawn: Readonly<Record<string, number>> | undefined, physics: 'carry' | 'reset' | undefined): boolean {
    const stepper = this.tracks ?? this.track;
    if (stepper === null || this.pose === null) return false;
    const before = this.drawnPose;
    const after = drawn === undefined ? null : drawnLocals(this.view, drawn);
    const previous = this.easing;
    const candidates = drawnChanged(before, after);
    if (previous !== null) for (const bone of previous.bones.keys()) candidates.add(bone);
    const bones = new Map<string, { from: number | null; to: number | null }>();
    for (const bone of candidates) {
      const to = after?.get(bone) ?? null;
      let from: number | null;
      const eased = previous?.bones.get(bone);
      if (previous !== null && eased !== undefined) {
        // Mid-ease: what it shows now. At u = 0 that is the previous start, the clip's value included.
        from = previous.elapsed > 0 ? this.easedLocal(previous, eased.from, eased.to, previous.clip.get(bone) as number) : eased.from;
      } else {
        from = before?.get(bone) ?? null;
      }
      if (from === to) continue;
      bones.set(bone, { from, to });
    }
    if (bones.size === 0) return false;
    const easing: SetEase = {
      duration,
      elapsed: 0,
      bones,
      clip: new Map(),
      fromSet: shownBefore,
      swapped: false,
      physics,
    };
    // The call's own pose is u = 0; it is the swap frame only when the next step, predicted by the last one, passes farther from ½.
    if (this.easePlant === 'swap-at-0' || this.swapsNow(0, this.lastStep / duration)) easing.swapped = true;
    this.easing = easing;
    this.drawnPose = after;
    // `reset` restarts the chains under the eased bones once, at the start; `carry` runs on every eased frame (`advanceEase`).
    if (physics === 'reset') this.handOverPhysics(new Set(bones.keys()), 'reset');
    this.reposeDrawn();
    return true;
  }

  /**
   * Whether the frame at progress `u` is the one nearest ½, the next frame
   * being at `next`: it is when `u` reached ½ or the next one would be
   * farther from it; a tie (within 1e-9) goes to the later frame.
   */
  private swapsNow(u: number, next: number): boolean {
    if (u >= 0.5) return true;
    return next > u && 0.5 - u < next - 0.5 - 1e-9;
  }

  /**
   * One step of an eased switch (#174), before the track steps: the elapsed
   * time advances by the step, the attachments swap when this is the frame
   * nearest ½ (`swapsNow`, the next step predicted by this one), and the
   * ease ends — the instant switch's state, `drawnPose` alone — on the frame
   * it reaches its duration. With `physics: 'carry'`, the chains under the
   * eased bones are carried by the turn this frame's blend makes, read by a
   * trial `step(0)` at the previous time (`handOverPhysics`).
   */
  private advanceEase(easing: SetEase, step: number): void {
    easing.elapsed += step;
    if (easing.elapsed >= easing.duration) this.easing = null;
    else if (!easing.swapped && this.swapsNow(easing.elapsed / easing.duration, (easing.elapsed + step) / easing.duration)) easing.swapped = true;
    if (easing.physics === 'carry') this.handOverPhysics(new Set(easing.bones.keys()), 'carry');
  }

  /**
   * Makes `sets` (distinct) the active sets: refuses any two touching one slot
   * before changing anything, then applies their composition to the held pose.
   */
  private activate(sets: readonly RigSet[], physics?: 'carry' | 'reset', ease = 0): void {
    this.oracle('attachment sets');
    for (let i = 0; i < sets.length; i++) {
      for (let j = 0; j < i; j++) {
        const other = this.touched(sets[j]);
        for (const slot of this.touched(sets[i])) {
          if (other.has(slot)) {
            throw new Error(
              `sets ${JSON.stringify(sets[j].name)} and ${JSON.stringify(sets[i].name)} both touch slot ${JSON.stringify(slot)}; ` +
                'active sets must cover and hide disjoint slots',
            );
          }
        }
        const otherDrawn = sets[j].drawn;
        for (const bone of Object.keys(sets[i].drawn ?? {})) {
          if (otherDrawn !== undefined && bone in otherDrawn) {
            throw new Error(
              `sets ${JSON.stringify(sets[j].name)} and ${JSON.stringify(sets[i].name)} both pose bone ${JSON.stringify(bone)}; ` +
                'active sets must draw disjoint bones',
            );
          }
        }
      }
    }
    const drawnBefore = this.activeSet?.drawn;
    const shownBefore = this.shownSet();
    this.activeList = this.setList.filter((s) => sets.includes(s));
    this.activeSet = composeSets(this.activeList);
    this.clearSeekCache();
    const drawn = this.activeSet?.drawn;
    if (ease > 0 && this.startEase(ease, shownBefore, drawn, physics)) return;
    const easing = this.easing;
    if (easing !== null) {
      // An instant call during an ease lands every eased bone at once, from what it shows.
      this.easing = null;
      const posedBefore = this.drawnPose;
      this.drawnPose = drawn === undefined ? null : drawnLocals(this.view, drawn);
      const changed = drawnChanged(posedBefore, this.drawnPose);
      for (const bone of easing.bones.keys()) changed.add(bone);
      if (physics !== undefined) this.handOverPhysics(changed, physics);
      this.reposeDrawn();
      return;
    }
    if (drawn !== drawnBefore && !(drawn === undefined && drawnBefore === undefined)) {
      const posedBefore = this.drawnPose;
      this.drawnPose = drawn === undefined ? null : drawnLocals(this.view, drawn);
      if (physics !== undefined) this.handOverPhysics(drawnChanged(posedBefore, this.drawnPose), physics);
      this.reposeDrawn();
      return;
    }
    const base = this.rawPose ?? (this.setup ?? (this.setup = poseRawSetup(this.view)));
    this.rawPose = base;
    this.pose = this.activeSet === null ? base : applySetToPose(this.view, base, this.activeSet);
    this.poseGeneration++;
    this.cachedIdentity = null;
  }

  /**
   * Which slots this player draws (`SlotFilter`), or null for every slot.
   * Settable on a live player: the next `draw` shows it, and `bounds()` reads
   * the drawn slots. An allow list naming a slot the document does not have
   * is refused by name. The pose is the whole rig's: `bone()`, `adjust`, the
   * events and the tracks see no filter.
   */
  get slots(): SlotFilter | null {
    return this.slotFilter;
  }

  set slots(filter: SlotFilter | null) {
    if (filter === null) {
      this.slotFilter = null;
      this.draws = () => true;
      this.poseGeneration++;
      this.cachedIdentity = null;
      return;
    }
    if (typeof filter === 'function') {
      this.slotFilter = filter;
      this.draws = filter;
      this.poseGeneration++;
      this.cachedIdentity = null;
      return;
    }
    if (!Array.isArray(filter)) throw new Error(`slots must be an array of slot names, a function, or null, got ${typeof filter}`);
    const known = new Set(this.read.doc.slots.map((slot) => slot.name));
    const unknown = filter.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(`no slot named ${unknown.map((n) => JSON.stringify(n)).join(', ')} in this document (slots: ${[...known].join(', ')})`);
    }
    const allowed = new Set(filter);
    this.slotFilter = [...filter];
    this.draws = (slot) => allowed.has(slot);
    this.poseGeneration++;
    this.cachedIdentity = null;
  }

  /**
   * The per-pose adjustment of bone locals (`BoneAdjust`), or null for none.
   * It is applied by every track the player opens — `play`, the reopen inside
   * `seek` — and by the pose drawn again after `mode` changes, on every pose
   * the animation is applied to, the first one included. Setting it re-poses
   * the pose the player holds at once (`repose`), so a held or paused player
   * shows the change on its next `draw` without a step.
   */
  get adjust(): BoneAdjust | null {
    return this.adjustFn;
  }

  set adjust(fn: BoneAdjust | null) {
    if (fn !== null && typeof fn !== 'function') throw new Error(`adjust must be a function or null, got ${typeof fn}`);
    this.oracle('local adjustment');
    this.adjustFn = fn;
    this.clearSeekCache();
    this.repose();
  }

  /**
   * Poses the held pose again at the same track time, through the current
   * `adjust`, without stepping, firing or drawing. A paused player and a zero
   * step re-pose nothing, so a caller whose adjustment reads its own state
   * (a mouth driven while the body is held) calls this when that state
   * changed, then `draw`. Nothing before `play`.
   */
  repose(): void {
    if (this.runtimeFrames !== null) { this.applyRuntimeTime(); return; }
    this.clearSeekCache();
    const stepper = this.tracks ?? this.track;
    if (stepper === null || this.pose === null) return;
    this.setRawPose(stepper.step(0));
  }

  /**
   * Where `name` is in the pose the player holds — the pose of the last
   * `advance`/`frame`/`seek`, or the setup pose before `play`. Read off the
   * core's pose, so it is the same in `dom` and `canvas` mode and costs nothing
   * until called. An unknown bone is refused by name.
   */
  bone(name: string): BoneWorld {
    const pose = this.posed();
    for (const bone of pose.bones) {
      if (bone.name !== name) continue;
      return {
        name,
        active: bone.active,
        x: bone.worldX,
        y: bone.worldY,
        a: bone.a,
        b: bone.b,
        c: bone.c,
        d: bone.d,
        rotationX: bone.rotationX,
        rotationY: bone.rotationY,
        scaleX: bone.scaleX,
        scaleY: bone.scaleY,
      };
    }
    throw new Error(`no bone named ${JSON.stringify(name)} in this document (bones: ${pose.bones.map((b) => b.name).join(', ')})`);
  }

  /**
   * The box of what the pose the player holds draws, in world units, Y up:
   * every region's four corners and every mesh's vertices, in the same frame
   * record the renderer takes (`posedFrame`). A slot under a clip counts only
   * inside the clip polygon's own box (an inverse clip removes nothing from
   * the count); bounding boxes, paths and points are not drawn and do not
   * count. `null` when nothing draws. The same numbers in `dom` and `canvas`
   * mode; nothing is computed until called.
   */
  bounds(): PoseBounds | null {
    const frame = this.runtimeFrames !== null ? this.posedFrame() : this.pose === null ? frameOf(this.source, this.posed(), this.color, this.draws) : this.posedFrame();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const slot of frame.order) {
      const points = slot.kind === 'region' ? slot.corners : slot.vertices;
      let lo = -Infinity, lb = -Infinity, hi = Infinity, hb = Infinity;
      if (slot.clip && !slot.clip.inverse) {
        const c = slot.clip.polygon;
        lo = Infinity; lb = Infinity; hi = -Infinity; hb = -Infinity;
        for (let i = 0; i < c.length; i += 2) {
          if (c[i] < lo) lo = c[i];
          if (c[i] > hi) hi = c[i];
          if (c[i + 1] < lb) lb = c[i + 1];
          if (c[i + 1] > hb) hb = c[i + 1];
        }
      }
      for (let i = 0; i < points.length; i += 2) {
        const x = Math.min(Math.max(points[i], lo), hi);
        const y = Math.min(Math.max(points[i + 1], lb), hb);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** The pose the reads above see: the track's, or the setup pose before `play` (posed once). */
  private posed(): RawPose {
    if (this.runtimeFrames !== null && this.animation !== null) {
      if (this.runtimeReadback === null) {
        const track = openTrack(this.view, this.animation, { loop: this.loop, reset: 'animation', clock: physicsClockStep });
        this.runtimeReadback = this.time > 0 ? track.step(this.time) : track.first;
      }
      return this.runtimeReadback;
    }
    if (this.pose !== null) return this.pose;
    if (this.setup === null) this.setup = poseRawSetup(this.view);
    return this.activeSet === null ? this.setup : applySetToPose(this.view, this.setup, this.activeSet);
  }

  /** Selected poser, including the named reason when the oracle is required. */
  get poser(): string { return this.runtimeFrames !== null ? 'runtime' : this.poserLabel === 'runtime' ? 'oracle: no runtime animation is active' : this.poserLabel; }

  private selectRuntime(): void {
    this.runtimeModel = null;
    if (this.oracleOnly) { this.poserLabel = 'oracle: explicitly selected'; return; }
    try {
      this.runtimeModel = compileRuntime(this.view);
      this.poserLabel = this.trackMode ? 'oracle: track composition' : this.adjustFn !== null ? 'oracle: local adjustment' : 'runtime';
    } catch (error) {
      if (!(error instanceof RuntimeRefusal)) throw error;
      this.poserLabel = `oracle: ${error.message}`;
    }
  }

  private tryRuntimePlay(name: string, loop: boolean): boolean {
    if (this.runtimeModel === null) return false;
    const blocked = this.trackMode ? 'track composition' : this.adjustFn !== null ? 'local adjustment' : this.activeSet !== null ? 'attachment sets' : this.easing !== null ? 'set easing' : this.env !== null ? 'environment configuration' : null;
    if (blocked !== null) { this.poserLabel = `oracle: ${blocked}`; return false; }
    if (!this.runtimeModel.animations.has(name)) {
      const refused = this.runtimeModel.refused.find(value => value.animation === name);
      if (refused) this.poserLabel = `oracle: ${new RuntimeRefusal(refused.missing).message}`;
      return false;
    }
    const frames = this.runtimeFrames ?? new RuntimeFrames(this.source, this.runtimeModel);
    frames.pose.setAnimation(name);
    frames.pose.apply(0);
    this.runtimeFrames = frames;
    this.runtimeCompletionClock = { trackTime: 0 };
    this.animation = name;
    this.loop = loop;
    this.track = null;
    this.tracks = null;
    this.pose = null;
    this.rawPose = null;
    this.poserLabel = 'runtime';
    this.poseGeneration++;
    this.cachedIdentity = null;
    this.runtimeReadback = null;
    frames.update(this.poseGeneration, this.color, this.draws);
    return true;
  }

  private applyRuntimeTime(): void {
    const frames = this.runtimeFrames!;
    const duration = frames.model.animations.get(this.animation as string)!.duration;
    const time = frames.pose.trackTime;
    this.runtimeCompletionClock.trackTime = time;
    frames.pose.apply(duration === 0 ? 0 : this.loop ? time % duration : Math.min(time, duration));
    this.poseGeneration++;
    this.cachedIdentity = null;
    this.runtimeReadback = null;
    frames.update(this.poseGeneration, this.color, this.draws);
  }

  /** Materialize the old track only at an operation stage 0 cannot execute. */
  private oracle(reason: string): void {
    if (this.runtimeFrames === null || this.animation === null) return;
    const time = this.runtimeFrames.pose.trackTime;
    const generation = this.poseGeneration;
    this.runtimeFrames = null;
    this.runtimeReadback = null;
    if (this.poserLabel === 'runtime') this.poserLabel = `oracle: ${reason}`;
    this.track = openTrack(this.view, this.animation, { loop: this.loop, reset: 'animation', adjust: this.adjustHook, clock: physicsClockStep });
    this.setRawPose(this.track.first);
    if (time > 0) this.setRawPose(this.track.step(time));
    this.poseGeneration = generation;
    this.applyEnvironment(this.track);
  }

  /** Borrow buffers until the next pose mutation. Request posedFrame() to retain a snapshot. */
  liveFrame(): LiveFrame {
    if (this.liveDisposed) throw new Error('LIVE_FRAME_DISPOSED: cannot borrow a frame after dispose');
    let frame: LiveFrame;
    if (this.runtimeFrames !== null) {
      this.runtimeFrames.update(this.poseGeneration, this.color, this.draws, false);
      frame = this.runtimeFrames.live;
    } else {
      const identities = new Map(this.slotIdentity().slots.map(slot => [slot.slot, slot]));
      frame = oracleLiveFrame(this.posedFrame(), identities, this.source.slotIndex);
    }
    return this.liveChecks ? this.checkedFrame(frame) : frame;
  }

  /** Keep lease closures out of the production borrow's call environment. */
  private checkedFrame(frame: LiveFrame): LiveFrame {
    const generation = this.poseGeneration;
    const state = this.runtimeFrames;
    const revision = state?.revision;
    return checkedLiveFrame(frame, () => this.poseGeneration === generation && (state === null || state.revision === revision) ? generation : -1);
  }

  /** Monotonic pose generation counter matching `posedFrame().generation` and `slotIdentity().generation`. */
  get generation(): number {
    return this.poseGeneration;
  }

  /**
   * The pose the player holds, as the frame record the renderer draws — under
   * this player's `slots` filter, or under `slots` given here instead (a
   * second renderer over the same assets drawing this player's pose on
   * another root: `other.render(player.posedFrame(['hand_f']))`, the one rig
   * posed once).
   */
  posedFrame(slots?: SlotFilter | null): PosedFrame {
    const draws = slots === undefined ? this.draws : slots === null ? () => true : typeof slots === 'function' ? slots : predicateOf(slots);
    if (this.runtimeFrames !== null) this.runtimeFrames.update(this.poseGeneration, this.color, this.draws, false);
    const frame: PosedFrame = this.runtimeFrames !== null ? this.runtimeFrames.snapshot(draws) : this.pose === null ? { order: [] } : frameOf(this.source, this.pose, this.color, draws);
    Object.defineProperty(frame, 'generation', {
      value: this.poseGeneration,
      enumerable: false,
      configurable: true,
    });
    return frame;
  }

  /**
   * A read-only slot identity snapshot coherent with `posedFrame()` (#144):
   * for every slot in the posed draw order (`z = 0 .. slots.length - 1`, hidden
   * and null slots included), its resolved attachment key (`string | null`),
   * the skin that owns that attachment (`string | null`), and `reason` (`null`
   * when drawn in `posedFrame().order`, or `'hidden' | 'no-attachment' | 'timeline-null' | 'set-hide'`
   * when not drawn), together with the active `set`, active `skin`, and frame
   * `generation`. Read off the held pose without `seek`, `repose`, or physics
   * restart.
   */
  slotIdentity(): SlotIdentitySnapshot {
    if (this.cachedIdentity !== null && this.cachedIdentityGen === this.poseGeneration) {
      return this.cachedIdentity;
    }
    const setupPose = this.setup ?? (this.setup = poseRawSetup(this.view));
    const pose = this.posed();
    const raw = this.runtimeFrames !== null ? pose : this.rawPose ?? setupPose;
    const shownBySlot = new Map(pose.shown.map((s) => [s.slot, s]));
    const setupShownSlots = new Set(setupPose.shown.map((s) => s.slot));
    const rawRowBySlot = new Map(raw.slots.map((r) => [r[0], r]));
    const slots: SlotIdentity[] = [];
    // The attachments the pose draws: before an ease's swap (#174), the composition it eases from.
    const shownSet = this.shownSet();
    for (let z = 0; z < pose.drawOrder.length; z++) {
      const slotName = pose.drawOrder[z];
      if (shownSet !== null && hiddenBySet(slotName, shownSet)) {
        slots.push(Object.freeze({
          slot: slotName,
          z,
          attachment: null,
          skin: null,
          reason: 'set-hide' as const,
        }));
        continue;
      }
      const shown = shownBySlot.get(slotName);
      const isDrawableKind =
        shown !== undefined &&
        (shown.geometry.kind === 'region' || shown.geometry.kind === 'mesh' || shown.geometry.kind === 'linkedmesh');
      if (shown !== undefined && isDrawableKind) {
        const bone = this.source.boneOf.get(slotName);
        const boneActive = bone !== undefined && this.source.active.has(bone);
        if (this.draws(slotName) && boneActive) {
          slots.push(Object.freeze({
            slot: slotName,
            z,
            attachment: shown.name,
            skin: shown.skin,
            reason: null,
          }));
        } else {
          slots.push(Object.freeze({
            slot: slotName,
            z,
            attachment: null,
            skin: null,
            reason: 'hidden' as const,
          }));
        }
        continue;
      }
      const rawRow = rawRowBySlot.get(slotName);
      const overriddenBySet = shownSet !== null && slotName in shownSet.slots;
      const setupHadAttachment = setupShownSlots.has(slotName);
      const isTimelineNull =
        !overriddenBySet &&
        ((setupHadAttachment && rawRow?.[1] === null) ||
          this.isSlotKeyedNullByTimeline(slotName, raw.animationTime));
      slots.push(Object.freeze({
        slot: slotName,
        z,
        attachment: null,
        skin: null,
        reason: isTimelineNull ? ('timeline-null' as const) : ('no-attachment' as const),
      }));
    }
    const snapshot: SlotIdentitySnapshot = Object.freeze({
      generation: this.poseGeneration,
      set: this.set,
      sets: Object.freeze(this.activeSets),
      skin: this.skinName ?? null,
      slots: Object.freeze(slots),
    });
    this.cachedIdentity = snapshot;
    this.cachedIdentityGen = this.poseGeneration;
    return snapshot;
  }

  /** Whether an active animation's attachment timeline explicitly keyed `null` on `slotName` at `animationTime`. */
  private isSlotKeyedNullByTimeline(slotName: string, animationTime: number): boolean {
    const checkAnimation = (animName: string | null, time: number): boolean | undefined => {
      if (animName === null) return undefined;
      const anim = this.view.animations.find((a) => a.name === animName);
      if (anim === undefined) return undefined;
      const target = anim.timelines.slots.find((s) => s.name === slotName);
      if (target === undefined) return undefined;
      let keyed: boolean | undefined;
      for (const tl of target.timelines) {
        if (tl.kind !== 'attachment') continue;
        let activeKey: { time: number; name?: string | null } | null = null;
        for (const k of tl.keys) {
          if (k.time <= time) activeKey = k;
          else break;
        }
        if (activeKey !== null) {
          keyed = activeKey.name === null || activeKey.name === undefined;
        }
      }
      return keyed;
    };
    if (this.tracks !== null) {
      let result = false;
      for (let t = 0; t < this.trackCount; t++) {
        const cur = this.tracks.current(t);
        if (cur !== null && cur.animation !== null) {
          const k = checkAnimation(cur.animation, cur.animationTime);
          if (k !== undefined) result = k;
        }
      }
      return result;
    }
    if ((this.track !== null || this.runtimeFrames !== null) && this.animation !== null) {
      return checkAnimation(this.animation, animationTime) === true;
    }
    return false;
  }

  /** Removes the renderer's elements and hands its GPU pages back. The assets stay the caller's. */
  dispose(): void {
    this.runtimeFrames = null;
    this.runtimeReadback = null;
    this.liveDisposed = true;
    this.poseGeneration++;
    this.renderer.dispose();
    this.clearSeekCache();
    this.cachedIdentity = null;
    this.easing = null;
    this.tracks = null;
    this.track = null;
    this.pose = null;
    this.rawPose = null;
  }

  /** The single track's step: its events (track 0) and its complete, as every 1.x player fired them. */
  private dispatchSingle(pose: RawPose, before: number, track: LiveTrack): void {
    if (this.listeners.event.size > 0) {
      for (const [name, time, int, float, string] of pose.events) {
        const event: RigEvent = { name, time, int, float, string, track: 0 };
        for (const listener of this.listeners.event) listener(event);
      }
    }
    if (this.listeners.complete.size > 0) {
      const d = track.duration;
      const after = track.trackTime;
      const cycles = d > 0 ? Math.floor(after / d) : Infinity;
      const was = d > 0 ? Math.floor(before / d) : -Infinity;
      if (this.loop ? cycles > 0 && cycles > was : before < d && after >= d) {
        const payload: RigComplete = { animation: this.animation as string, track: 0 };
        for (const listener of this.listeners.complete) listener(payload);
      }
    }
  }

  /**
   * The step's events, then its completes, each with its track. The core
   * fires a track's keys from its current entry (`pose.events`, in track
   * order and in the runtime's order across a wrap) — an entry mixing out
   * fires none — and leaves `complete` to the player, which derives it per
   * track from that track's current entry: on a looping entry, once on a step
   * whose whole cycles rose; on a held one, on the step that reaches its
   * duration. An entry replaced inside the step — by `play`, or by a queued
   * entry starting at its completion less the mix — is no longer current and
   * completes no more than it fires, which is the runtime's rule too.
   */
  private dispatch(pose: RawPose, before: ReadonlyArray<TrackEntryView | null>, tracks: LiveTracks): void {
    const after: Array<TrackEntryView | null> = [];
    for (let t = 0; t < this.trackCount; t++) after.push(tracks.current(t));
    const same = (b: TrackEntryView | null, a: TrackEntryView | null): boolean =>
      b !== null && a !== null && b.animation === a.animation && b.loop === a.loop && a.trackTime >= b.trackTime;

    if (this.listeners.event.size > 0 && pose.events.length > 0) {
      // Attribute by count: what each track's current entry fired over the step.
      const counts: number[] = [];
      let total = 0;
      for (let t = 0; t < this.trackCount; t++) {
        const a = after[t];
        const b = before[t];
        let n = 0;
        if (a !== null && a.animation !== null) {
          const keys = this.view.animations.find((anim) => anim.name === a.animation)?.timelines.events ?? [];
          if (keys.length > 0) {
            const last = same(b, a) ? (b as TrackEntryView).animationTime : -1;
            n = eventsFired(keys, last, a.animationTime, undefined, a.animationTime < last).length;
          }
        }
        counts.push(n);
        total += n;
      }
      const attributed = total === pose.events.length;
      let track = 0;
      let left = counts[0] ?? 0;
      for (const [name, time, int, float, string] of pose.events) {
        if (attributed) {
          while (left === 0 && track < counts.length - 1) {
            track++;
            left = counts[track];
          }
          left--;
        }
        const event: RigEvent = attributed ? { name, time, int, float, string, track } : { name, time, int, float, string };
        for (const listener of this.listeners.event) listener(event);
      }
    }
    if (this.listeners.complete.size > 0) {
      for (let t = 0; t < this.trackCount; t++) {
        const a = after[t];
        const b = before[t];
        if (!same(b, a) || a === null || a.animation === null) continue;
        const d = a.duration;
        const cycles = d > 0 ? Math.floor(a.trackTime / d) : Infinity;
        const was = d > 0 ? Math.floor((b as TrackEntryView).trackTime / d) : -Infinity;
        const fired = a.loop ? cycles > 0 && cycles > was : (b as TrackEntryView).trackTime < d && a.trackTime >= d;
        if (!fired) continue;
        const payload: RigComplete = { animation: a.animation, track: t };
        for (const listener of this.listeners.complete) listener(payload);
      }
    }
  }
}
