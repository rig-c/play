import { poseRawSetup, underNoSkin } from '@rig-c/core/core';
import { CanvasRenderer, rememberComposedClip, type CanvasBackend, type CanvasViewport } from './CanvasRenderer.js';
import { cameraLimits, createCameraHandoff, easeCamera, planeOffsets, planeShift, pointerTarget, type CameraMode } from './composed-camera.js';
import { loadModel, type ModelAssets, type ReadDocument } from './loadModel.js';
import { RigPlayer, type BoneAdjust } from './player.js';
import { frameOf, frameSource, type PosedClip, type PosedFrame, type PosedRegion, type PosedSlot } from './posedFrame.js';
import { discoverTurnDials, normalizedDial, type TurnDial } from './turnDials.js';

export type { CameraMode } from './composed-camera.js';

type Point = { readonly x: number; readonly y: number };
type Offsets = Readonly<Record<string, Point>>;
type ModelAnimation = ReadDocument['doc']['animations'][number];
type Bindings = { background: readonly string[]; figure: readonly string[]; foreground?: readonly string[] };

export interface ComposedPlane {
  slots: readonly string[];
  role: 'backdrop' | 'overlay' | 'figure';
  gain?: number;
  /** The bound region slot's direct root-child bone and its compiled translate timeline. */
  baked?: { bone: string };
}

interface TakeOptions {
  modelUrl: string;
  animation: string;
  loop: true;
  camera?: CameraMode;
  /** Maximum camera excursion in CSS pixels, before per-plane gains. */
  maxDisplacement?: Point;
  backend?: CanvasBackend;
  /** Disable the frame clock when driving advance and render explicitly. */
  autoStart?: boolean;
}

type LegacyTakeOptions = TakeOptions & { slots: Bindings; planes?: never; autoSweep?: never; transitionMs?: never; pointerTurn?: never };
export type ComposedTakeOptions = TakeOptions & {
  planes: Readonly<Record<string, ComposedPlane>>;
  autoSweep?: { periodSeconds: number; maxDisplacement: Point };
  transitionMs?: number;
  /** Blend compiled turn dials into the Parallax handoff by default. Set false for camera-only control. */
  pointerTurn?: boolean;
};
type RuntimeTakeOptions = LegacyTakeOptions | (ComposedTakeOptions & { slots?: never });

type Refusal = 'COMPOSED_STAGE_REQUIRED' | 'COMPOSED_LOOP_REQUIRED' | 'COMPOSED_SLOT_PARTITION'
  | 'COMPOSED_CROSS_PLANE_CLIP' | 'COMPOSED_BACKDROP_COVERAGE' | 'COMPOSED_INVALID_DISPLACEMENT'
  | 'COMPOSED_INVALID_CAMERA' | 'COMPOSED_PLATE_TRACK';

export class ComposedTakeError extends Error {
  constructor(readonly code: Refusal, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, { cause });
  }
}

type TurnValue = Pick<TurnDial, 'axis' | 'min' | 'max'> & {
  readonly baked: number;
  readonly pointer: number;
  readonly value: number;
};
type TurnReadout = TurnValue & {
  /** Whether the current pointer request reaches a limit before easing. */
  readonly clamped: boolean;
};

export interface MountedTake<PlaneOffsets extends Offsets = Offsets> {
  readonly canvas: HTMLCanvasElement;
  readonly player: RigPlayer;
  readonly mode: CameraMode;
  /** Displayed offsets in CSS pixels, with Y down. */
  readonly offsets: PlaneOffsets;
  readonly cameraExcursion: Point;
  /** Latest clamped pointer target before gains, in Y-up CSS pixels. */
  readonly cameraTarget: Point;
  /** Last posed dial values and the current pointer request's limit status. */
  readonly turnReadouts: readonly TurnReadout[];
  readonly refusal: ComposedTakeError | null;
  cameraExcursionFor(mode: CameraMode): Point;
  setCamera(next: CameraMode): void;
  advance(rigElapsed: number, cameraElapsed?: number): void;
  render(): void;
  dispose(): void;
}

const NEUTRAL = { x: 0, y: 0 };
const PLANES = ['background', 'figure', 'foreground'] as const;
const DEFAULT_TRANSITION_MS = 120;
const BACKDROP_GAIN = -0.55;
// Normalized distance from the stage center needed to reach each compiled endpoint.
const TURN_FULL_RANGE_AT_STAGE_EDGE = 1;

function turnCoordinate(axis: TurnDial['axis'], point: Point): number {
  return axis === 'pitch' ? point.y : point.x;
}

type Range = { minX: number; maxX: number; minY: number; maxY: number };
const ZERO_RANGE: Range = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
type BakedTrack = {
  range: Range;
  amplitudeX: number;
  horizontalRoot: string | undefined;
  keys: readonly { time: number; values: readonly number[] }[];
};
type Plate = { id: string; role: 'backdrop' | 'overlay'; setup: PosedRegion; baked?: BakedTrack };
type NamedPlanes = { plates: Plate[]; backdrop: string; figureSlots: ReadonlySet<string>; gains: ReadonlyMap<string, number> };

function checkMode(mode: CameraMode): void {
  if (mode !== 'fixed' && mode !== 'pan' && mode !== 'parallax') {
    throw new ComposedTakeError('COMPOSED_INVALID_CAMERA', `unknown camera mode ${String(mode)}`);
  }
}

function bindSlots(assets: ModelAssets, options: RuntimeTakeOptions): Map<string, string> {
  // A player with no explicit skin resolves attachments from the default skin.
  // Count drawable attachment kinds even when the take hides a slot at t=0.
  const { doc } = assets.document as ReadDocument;
  const skin = doc.skins.find(skin => skin.name === 'default');
  const drawable = new Set(doc.slots.filter(({ name }) => {
    const entries = Object.values(skin?.attachments[name] ?? {});
    return entries.some(({ kind }) => kind === 'region' || kind === 'mesh' || kind === 'linkedmesh');
  }).map(slot => slot.name));
  const named = options.planes;
  if ((named === undefined) === (options.slots === undefined)) {
    throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', 'declare either slots or named planes');
  }
  if (named !== undefined && (!named || typeof named !== 'object' || Array.isArray(named))) {
    throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', 'named planes must be a record keyed by plane ID');
  }
  const entries = named === undefined
    ? PLANES.map(id => [id, options.slots?.[id]] as const).filter(([id, slots]) => id !== 'foreground' || slots !== undefined)
    : Object.entries(named).map(([id, plane]) => [id, plane?.slots] as const);
  if (named !== undefined) {
    const records = Object.values(named);
    if (records.filter(record => record?.role === 'backdrop').length !== 1
      || records.filter(record => record?.role === 'figure').length !== 1) {
      throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', 'named planes need one backdrop and one figure');
    }
  }
  const planes = new Map<string, string>();
  for (const [plane, slots] of entries) {
    const role = named?.[plane]?.role;
    if (named && (!plane.trim() || (role !== 'backdrop' && role !== 'overlay' && role !== 'figure'))) {
      throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', `${JSON.stringify(plane)} needs a valid plane ID and role`);
    }
    if (!Array.isArray(slots) || (named ? slots.length === 0 : plane !== 'foreground' && slots.length === 0)) {
      throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', `${plane} needs an explicit slot list`);
    }
    if (named && role !== 'figure' && slots.length !== 1) {
      throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', `${plane} must bind exactly one compiled plate slot`);
    }
    for (const slot of slots) {
      if (!drawable.has(slot) || planes.has(slot)) {
        throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', `${plane} has a non-drawable or duplicate slot ${JSON.stringify(slot)}`);
      }
      planes.set(slot, plane);
    }
  }
  const missing = [...drawable].filter(slot => !planes.has(slot));
  if (missing.length) {
    throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', `unbound drawable slots ${missing.join(', ')}`);
  }
  return planes;
}

function checkFrame(frame: PosedFrame, planes: ReadonlyMap<string, string>, backdropPlane = 'background'): PosedSlot[] {
  const seen = new Set<string>();
  const clipPlanes = new Map<PosedClip, string>();
  const backdrop: PosedSlot[] = [];
  for (const slot of frame.order) {
    const plane = planes.get(slot.slot);
    if (plane === undefined || seen.has(slot.slot)) {
      throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', `unbound or repeated posed slot ${JSON.stringify(slot.slot)}`);
    }
    seen.add(slot.slot);
    if (slot.clip) {
      const owner = clipPlanes.get(slot.clip);
      if (owner !== undefined && owner !== plane) {
        throw new ComposedTakeError('COMPOSED_CROSS_PLANE_CLIP', `one clip covers ${owner} and ${plane} at ${JSON.stringify(slot.slot)}`);
      }
      clipPlanes.set(slot.clip, plane);
    }
    if (plane === backdropPlane) backdrop.push(slot);
  }
  return backdrop;
}

function trackError(id: string, detail: string): ComposedTakeError {
  return new ComposedTakeError('COMPOSED_PLATE_TRACK', `plane ${JSON.stringify(id)} ${detail}`);
}

function namedPlanes(assets: ModelAssets, options: RuntimeTakeOptions): NamedPlanes | undefined {
  if (!options.planes) return undefined;
  const read = assets.document as ReadDocument;
  const doc = underNoSkin(read.doc);
  const skin = doc.skins.find(skin => skin.name === 'default');
  const animation = doc.animations.find(animation => animation.name === options.animation)!;
  const setup = poseRawSetup(doc);
  const setupFrame = frameOf(frameSource(doc, read.parsed), setup);
  const bones = new Map(doc.bones.map(bone => [bone.name, bone]));
  const gains = new Map<string, number>();
  const plates: Plate[] = [];
  const figureSlots = new Set<string>();
  const drivers = new Set<string>();

  function checkStable(id: string, slot: string, chain: ReadonlySet<string>, driver: string | undefined,
    { name, timelines }: Pick<ModelAnimation, 'name' | 'timelines'>): void {
    if (timelines.bones.some(row => chain.has(row.name) && row.name !== driver && row.timelines.length)
      || timelines.slots.some(row => row.name === slot && row.timelines.some(timeline => timeline.kind === 'attachment'))
      || timelines.attachments.some(row => row.slot === slot && row.sequence)) {
      throw trackError(id, `has non-translation motion or an unstable attachment in ${JSON.stringify(name)}`);
    }
  }

  for (const [id, { role, slots, gain, baked }] of Object.entries(options.planes)) {
    if (gain !== undefined && !Number.isFinite(gain)) {
      throw new ComposedTakeError('COMPOSED_INVALID_DISPLACEMENT', `plane ${JSON.stringify(id)} needs a finite gain`);
    }
    if (role === 'figure') {
      if (baked !== undefined || (gain !== undefined && gain !== 0)) {
        throw trackError(id, 'must stay at focal gain 0 without a baked camera track');
      }
      gains.set(id, 0);
      for (const slot of slots) figureSlots.add(slot);
      continue;
    }

    const slot = doc.slots.find(slot => slot.name === slots[0])!;
    const region = setupFrame.order.find(drawn => drawn.slot === slot.name);
    if (region?.kind !== 'region') {
      throw new ComposedTakeError('COMPOSED_BACKDROP_COVERAGE', `plane ${JSON.stringify(id)} has no rigid setup quad (all edges)`);
    }
    const plate: Plate = { id, role, setup: region };
    plates.push(plate);
    if (gain !== undefined || role === 'backdrop') gains.set(id, gain ?? BACKDROP_GAIN);
    if (role === 'overlay' && baked === undefined) continue;

    const attachment = slot.setup === null ? undefined : skin?.attachments[slot.name]?.[slot.setup];
    if (attachment?.kind !== 'region' || (attachment.sequenceCount ?? 1) !== 1) {
      throw trackError(id, 'needs one stable setup region');
    }
    const chain = new Set<string>();
    for (let bone = bones.get(slot.bone); bone; bone = bone.parent === undefined ? undefined : bones.get(bone.parent)) {
      chain.add(bone.name);
    }
    const driver = baked?.bone;
    checkStable(id, slot.name, chain, driver, animation);
    for (const { record } of doc.constraints) {
      if (!record) continue;
      if (record.kind === 'slider') {
        checkStable(id, slot.name, chain, undefined, { name: record.animation, timelines: record.timelines });
      } else if (record.kind === 'physics' ? chain.has(record.bone) : record.bones.some(bone => chain.has(bone))) {
        throw trackError(id, `has a moving or constrained plate ancestry (${JSON.stringify(record.name)})`);
      }
    }
    if (baked === undefined) continue;
    const parentName = bones.get(slot.bone)?.parent;
    const parent = setup.bones.find(bone => bone.name === parentName);
    if (driver !== slot.bone || !parent?.active || parent.parent !== null || drivers.has(driver)) {
      throw trackError(id, 'needs an independent translate track on its compiled slot’s direct root-child bone');
    }
    drivers.add(driver);

    const rows = animation.timelines.bones.filter(row => row.name === driver);
    const timelines = rows[0]?.timelines;
    const keys = timelines?.[0]?.keys;
    const duration = animation.timelines.duration;
    const isCenter = (key: NonNullable<typeof keys>[number]) => key.values[0] === 0 && key.values[1] === 0;
    if (rows.length !== 1 || timelines?.length !== 1 || timelines[0].kind !== 'translate'
      || !keys || keys.length < 2 || keys[0].time !== 0 || keys[keys.length - 1].time !== duration
      || !isCenter(keys[0]) || !isCenter(keys[keys.length - 1])
      || keys.some((key, i) => key.curve !== 'linear' || !Number.isFinite(key.time)
        || key.values.length !== 2 || !key.values.every(Number.isFinite)
        || (i > 0 && key.time <= keys[i - 1].time))) {
      throw trackError(id, 'needs a finite linear translate loop with ordered keys and setup-center endpoints');
    }

    // Root translation drops out. Its constant matrix maps every local key
    // into the same world axes the renderer uses, with screen Y down.
    const range = { ...ZERO_RANGE };
    let amplitudeX = 0;
    let horizontal = parent.c === 0 && parent.a !== 0;
    for (const { values: [x, y] } of keys) {
      horizontal &&= y === 0;
      amplitudeX = Math.max(amplitudeX, Math.abs(x));
      const dx = parent.a * x + parent.b * y;
      const dy = -(parent.c * x + parent.d * y);
      range.minX = Math.min(range.minX, dx);
      range.maxX = Math.max(range.maxX, dx);
      range.minY = Math.min(range.minY, dy);
      range.maxY = Math.max(range.maxY, dy);
    }
    if (!Object.values(range).every(Number.isFinite)) throw trackError(id, 'has a non-finite world translation envelope');
    plate.baked = { range, amplitudeX, horizontalRoot: horizontal ? parent.name : undefined, keys };
  }

  const backdrop = plates.find(plate => plate.role === 'backdrop')!;
  const backdropGain = gains.get(backdrop.id)!;
  const reference = backdrop.baked;
  if (options.autoSweep && plates.some(plate => plate.baked)) {
    throw trackError(backdrop.id, 'cannot combine a camera-only autoSweep with baked plate motion');
  }
  for (const { id, baked } of plates) {
    if (gains.has(id)) continue;
    // Compare X signs only at identical key times across the validated linear loops.
    const comparable = baked && reference && reference.horizontalRoot !== undefined && baked.horizontalRoot === reference.horizontalRoot
      && reference.amplitudeX > 0 && baked.amplitudeX > 0
      && baked.keys.length === reference.keys.length
      && baked.keys.every((key, i) => key.time === reference.keys[i].time
        && Math.sign(key.values[0]) === Math.sign(reference.keys[i].values[0]));
    const gain = comparable ? backdropGain * (baked.amplitudeX / reference.amplitudeX) : NaN;
    if (!Number.isFinite(gain)) {
      throw trackError(id, `needs an explicit gain for motion relative to backdrop plane ${JSON.stringify(backdrop.id)}`);
    }
    gains.set(id, gain);
  }
  return { plates, backdrop: backdrop.id, figureSlots, gains };
}

function transformFrame(
  frame: PosedFrame,
  shiftFor: (slot: PosedSlot) => Point,
  { origin = NEUTRAL, scale = { x: 1, y: 1 }, centered, clipInStockSpace = false }: {
    origin?: Point;
    scale?: Point;
    centered?: ReadonlyMap<string, PosedRegion>;
    clipInStockSpace?: boolean;
  } = {},
): PosedFrame {
  const clips = new Map<PosedClip, PosedClip>();
  const native = origin.x === 0 && origin.y === 0 && scale.x === 1 && scale.y === 1;
  return { order: frame.order.map(slot => {
    const shift = shiftFor(slot);
    const setup = centered?.get(slot.slot);
    if (native && shift.x === 0 && shift.y === 0 && !setup) {
      // A neutral draw still uses the composed clip path, with the original coordinates.
      return clipInStockSpace && slot.clip ? rememberComposedClip({ ...slot }, slot, shift, origin, scale) : slot;
    }
    const transform = (xy: number[], delta = shift) => xy.map((value, i) => i % 2 === 0
      ? (value + delta.x - origin.x) * scale.x
      : (value - delta.y - origin.y) * scale.y);
    let clip = slot.clip;
    if (clip) {
      const transformed = clips.get(clip) ?? { ...clip, polygon: transform(clip.polygon) };
      clips.set(clip, transformed);
      clip = transformed;
    }
    const positioned: PosedSlot = slot.kind === 'mesh'
      ? { ...slot, clip, vertices: transform(slot.vertices) }
      : { ...slot, clip, corners: setup ? (native ? setup.corners : transform(setup.corners, NEUTRAL)) : transform(slot.corners) };
    if (!clipInStockSpace || !slot.clip) return positioned;
    // Centering pins the quad to setup while the polygon still follows the plane.
    // Undo the plane shift on those corners so both inputs share the original clip space.
    const source: PosedSlot = slot.kind === 'region' && setup
      ? { ...slot, corners: setup.corners.map((value, i) => i % 2 === 0 ? value - shift.x : value + shift.y) }
      : slot;
    return rememberComposedClip(positioned, source, shift, origin, scale);
  }) };
}

type Layout = {
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
  dpr: number;
  excursion: Point;
  native: boolean;
};

const stageTop = (stage: CanvasViewport) => stage.y + stage.height;
const edgeTolerance = (a: number, b: number) => Math.max(Math.abs(a), Math.abs(b), 1) * 2 ** -23;

function requireStage(stage: ModelAssets['stage']): CanvasViewport {
  if (!stage || ![stage.x, stage.y, stage.width, stage.height, stage.x + stage.width, stageTop(stage)].every(Number.isFinite)
    || stage.x + stage.width <= stage.x || stageTop(stage) <= stage.y) {
    throw new ComposedTakeError('COMPOSED_STAGE_REQUIRED', 'the compiled model needs a positive stage with finite coordinates');
  }
  return stage;
}

function backdropAlphaAudit(renderer: CanvasRenderer) {
  let lastNonOpaque: number | undefined;
  let renderFailure: { error: unknown } | undefined;
  return (frame: PosedFrame, viewport: CanvasViewport, pixelRatio = 1): number => {
    renderer.viewport = viewport;
    renderer.pixelRatio = pixelRatio;
    try {
      renderer.render(frame);
    } catch (error) {
      renderFailure = { error };
      lastNonOpaque = undefined;
      throw error;
    }
    if (renderer.framesReused && renderFailure) throw renderFailure.error;
    renderFailure = undefined;
    if (!renderer.framesReused || lastNonOpaque === undefined) {
      lastNonOpaque = undefined;
      const ctx = renderer.canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D readback is unavailable');
      const { data } = ctx.getImageData(0, 0, renderer.canvas.width, renderer.canvas.height);
      let count = 0;
      for (let i = 3; i < data.length; i += 4) count += Number(data[i] !== 255);
      lastNonOpaque = count;
    }
    return lastNonOpaque;
  };
}

function backdropGuard(audit: ReturnType<typeof backdropAlphaAudit>, stage: CanvasViewport) {
  return (order: PosedSlot[], layout: Layout, mode: CameraMode): void => {
    if (mode === 'fixed') return;
    const shift = planeOffsets(layout.excursion, mode).background;
    const requested = { x: Math.abs(shift.x), y: Math.abs(shift.y) };
    const x = requested.x * stage.width / layout.cssWidth;
    const y = requested.y * stage.height / layout.cssHeight;
    const stageRight = stage.x + stage.width;
    const topOfStage = stageTop(stage);
    const bounds = { left: stage.x - x, right: stageRight + x, top: topOfStage + y, bottom: stage.y - y };

    let left = Infinity, right = -Infinity, top = -Infinity, bottom = Infinity;
    for (const slot of order) {
      const points = slot.kind === 'region' ? slot.corners : slot.vertices;
      for (let i = 0; i < points.length; i += 2) {
        left = Math.min(left, points[i]);
        right = Math.max(right, points[i]);
        bottom = Math.min(bottom, points[i + 1]);
        top = Math.max(top, points[i + 1]);
      }
    }
    // Core geometry can land a few float ulps off an authored edge. The
    // opacity check below still requires every sampled alpha to equal 255.
    const fail = (detail: string) => {
      const cssPixels = (value: number) => Number.isFinite(value) ? String(Number(value.toFixed(3))) : 'unavailable';
      const available = (edge: number, stageEdge: number, sign: number, cssPerUnit: number) => {
        if (!Number.isFinite(edge)) return 'unavailable';
        const margin = (edge - stageEdge) * sign;
        return cssPixels(Math.abs(margin) <= edgeTolerance(edge, stageEdge) ? 0 : margin * cssPerUnit);
      };
      const cssPerX = layout.cssWidth / stage.width;
      const cssPerY = layout.cssHeight / stage.height;
      const horizontal = `left=${available(left, stage.x, -1, cssPerX)}, right=${available(right, stageRight, 1, cssPerX)}`;
      const vertical = `top=${available(top, topOfStage, 1, cssPerY)}, bottom=${available(bottom, stage.y, -1, cssPerY)}`;
      return new ComposedTakeError('COMPOSED_BACKDROP_COVERAGE',
        `${mode} at ${cssPixels(layout.cssWidth)} × ${cssPixels(layout.cssHeight)} CSS px needs an opaque backdrop `
        + `(camera excursion ${cssPixels(layout.excursion.x)} × ${cssPixels(layout.excursion.y)} CSS px); `
        + `requested shift per edge X=${cssPixels(requested.x)}, Y=${cssPixels(requested.y)} CSS px; `
        + `available geometric overscan ${horizontal}, ${vertical} CSS px; ${detail}`);
    };
    if (!Object.values(bounds).every(Number.isFinite)) throw fail('the requested envelope has non-finite world bounds');
    const outside = (edge: number, expected: number, sign: number) => !Number.isFinite(edge)
      || (edge - expected) * sign > edgeTolerance(edge, expected);
    const uncovered = [
      outside(left, bounds.left, 1) && 'left', outside(right, bounds.right, -1) && 'right',
      outside(top, bounds.top, -1) && 'top', outside(bottom, bounds.bottom, 1) && 'bottom',
    ].filter(Boolean);
    if (uncovered.length) throw fail(`uncovered geometric edges ${uncovered.join(', ')}`);

    // The union of all stage locations in backdrop space is one rectangle.
    // Rasterize its entire area, including both edges of each axis and the
    // interior. Fit the raster to this rectangle without adding a guard pad.
    // The coverage probe cuts in the projected envelope's coordinates.
    const width = Math.ceil(layout.width + 2 * x * layout.width / stage.width);
    const height = Math.ceil(layout.height + 2 * y * layout.height / stage.height);
    const envelope = transformFrame({ order }, () => NEUTRAL, {
      origin: { x: bounds.left, y: bounds.top },
      scale: { x: width / (bounds.right - bounds.left), y: height / (bounds.top - bounds.bottom) },
    });
    let lastNonOpaque: number;
    try {
      lastNonOpaque = audit(envelope, { x: 0, y: -height, width, height });
    } catch (error) {
      throw fail(`backdrop alpha cannot be read (${String(error)})`);
    }
    if (lastNonOpaque) throw fail(`${lastNonOpaque} envelope pixels have alpha below 255`);
  };
}

type LivePlate = { plate: Plate; slot: PosedRegion; live: Point };

function plateCoverageError(id: string, mode: CameraMode, detail: string): ComposedTakeError {
  return new ComposedTakeError('COMPOSED_BACKDROP_COVERAGE', `plane ${JSON.stringify(id)} in ${mode}: ${detail}`);
}

function livePlates(frame: PosedFrame, named: NamedPlanes, mode: CameraMode): LivePlate[] {
  const slots = new Map(frame.order.map(slot => [slot.slot, slot]));
  return named.plates.map(plate => {
    const { id, role, setup, baked } = plate;
    const slot = slots.get(setup.slot);
    if (slot?.kind !== 'region') throw plateCoverageError(id, mode, 'missing live rigid quad (all edges)');
    if (!baked && role === 'overlay') return { plate, slot, live: NEUTRAL };

    const { corners } = slot;
    const x = corners[0] - setup.corners[0];
    const y = setup.corners[1] - corners[1];
    const range = baked?.range ?? ZERO_RANGE;
    const tolerance = Math.max(...corners.map((value, i) => edgeTolerance(value, setup.corners[i])));
    if (slot.region !== setup.region || slot.page !== setup.page || corners.length !== 8
      || !corners.every((value, i) => Math.abs(value - (setup.corners[i] + (i % 2 === 0 ? x : -y))) <= tolerance)
      || x < range.minX - tolerance || x > range.maxX + tolerance
      || y < range.minY - tolerance || y > range.maxY + tolerance) {
      throw plateCoverageError(id, mode, 'live quad is outside its stable translation contract (all edges)');
    }
    return { plate, slot, live: { x, y } };
  });
}

function plateEnvelope(baked: Range, pointer: Point, sweep: Point, mode: CameraMode): Range {
  if (mode === 'fixed') return baked;
  if (mode === 'pan') return {
    minX: baked.minX - pointer.x, maxX: baked.maxX + pointer.x,
    minY: baked.minY - pointer.y, maxY: baked.maxY + pointer.y,
  };
  // Linear key intervals, sine travel, bounded pointer easing and handoffs
  // stay in the axis-wise hull of the automatic and pointer endpoints.
  const x = Math.max(pointer.x, sweep.x);
  const y = Math.max(pointer.y, sweep.y);
  return { minX: Math.min(baked.minX, -x), maxX: Math.max(baked.maxX, x),
    minY: Math.min(baked.minY, -y), maxY: Math.max(baked.maxY, y) };
}

function checkPlateEnvelopes(
  stage: CanvasViewport, layout: Layout, mode: CameraMode, excursion: Point,
  plates: LivePlate[], gains: NamedPlanes['gains'], sweep: Point,
): void {
  const backingX = layout.width / stage.width;
  const backingY = layout.height / stage.height;
  const cssToBacking = { x: layout.width / layout.cssWidth, y: layout.height / layout.cssHeight };

  for (const { plate: { id, setup, baked, role }, slot } of plates) {
    const stable = baked || role === 'backdrop';
    const gain = Math.abs(mode === 'pan' ? 1 : gains.get(id)!);
    const range = baked?.range ?? ZERO_RANGE;
    const requested = plateEnvelope({ minX: range.minX * backingX, maxX: range.maxX * backingX,
      minY: range.minY * backingY, maxY: range.maxY * backingY },
    { x: gain * excursion.x * cssToBacking.x, y: gain * excursion.y * cssToBacking.y },
    { x: gain * sweep.x * cssToBacking.x, y: gain * sweep.y * cssToBacking.y }, mode);
    const left = -requested.maxX;
    const right = layout.width - requested.minX;
    const top = -requested.maxY;
    const bottom = layout.height - requested.minY;
    const corners = stable ? setup.corners : slot.corners;
    const xs = [0, 2, 4, 6].map(i => (corners[i] - stage.x) * backingX);
    const ys = [1, 3, 5, 7].map(i => (stageTop(stage) - corners[i]) * backingY);
    const bounds = (numbers: number[]) => `[${numbers.map(n => Number(n.toFixed(4))).join(', ')}]`;
    const fail = (detail: string) => plateCoverageError(id, mode, `${detail}; at ${layout.width} × ${layout.height} backing px, `
      + `swept stage X=${bounds([left, right])}, Y=${bounds([top, bottom])}, `
      + `quad X=${bounds([Math.min(...xs), Math.max(...xs)])}, Y=${bounds([Math.min(...ys), Math.max(...ys)])}`);
    if (corners.length !== 8 || ![left, right, top, bottom, ...xs, ...ys].every(value => Number.isFinite(Math.fround(value)))) {
      throw fail('non-finite swept quad bounds (all edges)');
    }
    if (!xs.every(x => [requested.minX, requested.maxX].every(shift => Number.isFinite(Math.fround(x + shift))))
      || !ys.every(y => [requested.minY, requested.maxY].every(shift => Number.isFinite(Math.fround(y + shift))))) {
      throw fail('swept quad exceeds finite backing coordinates (all edges)');
    }

    // BL, UL, UR, BR. Test each actual quad edge and the corners of the
    // inverse-shifted stage rect in backing pixels, including sheared quads.
    const edgeNames = ['left', 'top', 'right', 'bottom'];
    const distances = xs.map((x, i) => {
      const next = (i + 1) % 4;
      const dx = xs[next] - x;
      const dy = ys[next] - ys[i];
      const length = Math.hypot(dx, dy);
      return (px: number, py: number) => (dx * (py - ys[i]) - dy * (px - x)) / length;
    });
    const winding = Math.sign(distances[0](xs[2], ys[2]));
    const invalid = distances.findIndex((distance, i) => [2, 3].some(step => {
      const corner = (i + step) % 4;
      return !(distance(xs[corner], ys[corner]) * winding > 0);
    }));
    if (invalid !== -1) throw fail(`invalid quad at ${edgeNames[invalid]} edge`);
    // An overlay only needs a valid drawable surface. Translations preserve
    // its edge lengths and winding, and it may be smaller than the stage.
    if (role === 'overlay') continue;

    const tolerance = Math.max(1, ...xs.map(Math.abs), ...ys.map(Math.abs), Math.abs(right), Math.abs(bottom)) * 2 ** -23;
    const uncovered = edgeNames.filter((_edge, i) => [left, right].some(x => [top, bottom].some(y =>
      distances[i](x, y) * winding < -tolerance)));
    if (uncovered.length) throw fail(`uncovered geometric edges ${uncovered.join(', ')}`);
  }
}

export function mountComposedTake(root: HTMLElement, options: ComposedTakeOptions): Promise<MountedTake>;
export async function mountComposedTake(root: HTMLElement, options: RuntimeTakeOptions): Promise<MountedTake> {
  const initial = options.camera ?? 'fixed';
  checkMode(initial);
  if (options.loop !== true) throw new ComposedTakeError('COMPOSED_LOOP_REQUIRED', 'declare the existing take as loop: true');
  const override = options.maxDisplacement;
  const validLimit = (limit: Point) => limit && Number.isFinite(limit.x) && limit.x >= 0
    && Number.isFinite(limit.y) && limit.y >= 0;
  if (override !== undefined && !validLimit(override)) {
    throw new ComposedTakeError('COMPOSED_INVALID_DISPLACEMENT', 'x and y must both be finite nonnegative CSS pixel excursions');
  }
  const explicit = override && { ...override };
  const sweep = options.autoSweep;
  if (sweep !== undefined && (!sweep || !Number.isFinite(sweep.periodSeconds) || sweep.periodSeconds <= 0
    || !validLimit(sweep.maxDisplacement))) {
    throw new ComposedTakeError('COMPOSED_INVALID_DISPLACEMENT', 'autoSweep needs a positive finite periodSeconds and finite nonnegative axis caps');
  }
  const sweepLimit = sweep ? { ...sweep.maxDisplacement } : NEUTRAL;
  const sweepPeriod = sweep?.periodSeconds;
  const transitionSeconds = (options.transitionMs === undefined ? DEFAULT_TRANSITION_MS : options.transitionMs) / 1000;
  if (!Number.isFinite(options.transitionMs ?? DEFAULT_TRANSITION_MS) || !(transitionSeconds > 0)) {
    throw new ComposedTakeError('COMPOSED_INVALID_DISPLACEMENT', 'transitionMs must be positive and finite');
  }
  const assets = await loadModel({ modelUrl: options.modelUrl, regions: 'none', setsUrl: null, crossOrigin: 'anonymous' }).catch(error => {
    if (error instanceof Error && /(?:problem\(s\): |; )(?:stage[.: ]|section "stage" is missing(?=; | — |$))/.test(error.message)) {
      throw new ComposedTakeError('COMPOSED_STAGE_REQUIRED', 'the compiled model needs a valid stage', error);
    }
    throw error;
  });
  const doc = root.ownerDocument;
  const surface = doc.createElement('div');
  let player: RigPlayer | undefined;
  let audit: CanvasRenderer | undefined;
  try {
    const stage = requireStage(assets.stage);
    const take = assets.animations.find(animation => animation.name === options.animation);
    if (!take || !Number.isFinite(take.duration) || take.duration <= 0) {
      throw new ComposedTakeError('COMPOSED_LOOP_REQUIRED', `no positive-duration animation named ${JSON.stringify(options.animation)}`);
    }
    const planes = bindSlots(assets, options);
    const named = namedPlanes(assets, options);
    const dials = named && options.pointerTurn !== false
      ? discoverTurnDials((assets.document as ReadDocument).parsed, assets.animations) : [];
    const handoff = createCameraHandoff(transitionSeconds);
    let mode: CameraMode = initial;
    let turnInput = { weight: 0, pointer: NEUTRAL };
    let posedTurnInput = turnInput;
    let turnValues: readonly TurnValue[] = [];

    const adjustTurn: BoneAdjust = bones => {
      const { weight, pointer } = turnInput;
      turnValues = dials.map(dial => {
        const { axis, bone, channel, min, max } = dial;
        const locals = bones.bone(bone);
        // Core starts each pose from setup and applies the live timelines before this hook.
        const baked = locals[channel];
        const n = turnCoordinate(axis, pointer) / TURN_FULL_RANGE_AT_STAGE_EDGE;
        const limited = normalizedDial(n, dial);
        const value = weight === 0 ? baked : (1 - weight) * baked + weight * limited;
        if (value !== baked) locals[channel] = value;
        return { axis, min, max, baked, pointer: limited, value };
      });
      posedTurnInput = turnInput;
    };

    function syncTurn(next: CameraMode): void {
      if (!dials.length) return;
      const weight = mode === 'parallax' && next === mode ? handoff.weight : 0;
      const pointer = weight === 0 ? NEUTRAL : handoff.pointer;
      if (weight !== turnInput.weight || pointer.x !== turnInput.pointer.x || pointer.y !== turnInput.pointer.y) {
        turnInput = { weight, pointer };
      }
    }

    Object.assign(surface.style, {
      position: 'relative', overflow: 'hidden', width: '100%', height: '100%', aspectRatio: `${stage.width} / ${stage.height}`,
    });
    root.appendChild(surface);
    const poser = player = new RigPlayer(surface, assets, { mode: 'canvas', adjust: dials.length ? adjustTurn : null });
    const renderer = poser.renderer as CanvasRenderer;
    const coverage = audit = new CanvasRenderer(doc.createElement('div'), assets.pageImages);
    renderer.backend = coverage.backend = options.backend ?? 'webgl';
    const canvas = renderer.canvas;
    poser.play(take.name, { loop: true });

    let offsets: Offsets = planeOffsets(NEUTRAL, 'fixed');
    let camera = NEUTRAL;
    let target = NEUTRAL;
    let hover: number | undefined;
    let layout: Layout;
    let refusal: ComposedTakeError | null = null;
    let stopped = false;
    let disposed = false;
    let frameId: number | undefined;
    const window = doc.defaultView!;
    const auditBackdrop = backdropAlphaAudit(coverage);
    const requireCoverage = backdropGuard(auditBackdrop, stage);
    const origin = { x: stage.x, y: stageTop(stage) };
    const autoStart = options.autoStart !== false;
    let lastCameraAt = window.performance.now();

    function measure(): void {
      const box = surface.getBoundingClientRect();
      const cssWidth = box.width || stage.width;
      const cssHeight = box.height || stage.height;
      const dpr = window.devicePixelRatio;
      if (layout?.cssWidth === cssWidth && layout.cssHeight === cssHeight && layout.dpr === dpr) return;
      const width = Math.ceil(cssWidth * dpr);
      const height = Math.ceil(cssHeight * dpr);
      const pixelRatio = width / stage.width;
      const native = [stage.x, stage.y, stage.width, stage.height].every(Number.isInteger)
        && stage.width * pixelRatio === width && stage.height * pixelRatio === height;
      const excursion = explicit ?? cameraLimits(cssWidth, cssHeight);
      layout = { cssWidth, cssHeight, width, height, dpr, native, excursion };
      renderer.viewport = native ? stage : { x: 0, y: -height, width, height };
      renderer.pixelRatio = native ? pixelRatio : 1;
    }

    function cameraExcursionFor(next: CameraMode): Point {
      const { excursion } = layout;
      // In Parallax the vertical pointer axis drives the turn; Pan keeps both axes.
      return next === 'parallax' && dials.length ? { x: excursion.x, y: 0 } : excursion;
    }

    const cssTarget = (point: Point, excursion: Point): Point => ({ x: point.x * excursion.x, y: point.y * excursion.y });

    function prepareFrame(frame: PosedFrame, plates: LivePlate[], next: CameraMode, excursion: Point): { frame: PosedFrame; offsets: Offsets } {
      const worldX = stage.width / layout.cssWidth;
      const worldY = stage.height / layout.cssHeight;
      const centered = new Map<string, PosedRegion>();
      const shifts = planeOffsets(cssTarget(camera, excursion), next) as Offsets;
      let frameOffsets = shifts;
      let namedShifts: Map<string, Point> | undefined;
      if (named) {
        const liveByPlane = new Map(plates.map(plate => [plate.plate.id, plate]));
        const changingMode = mode !== next;
        const weight = changingMode ? 0 : handoff.weight;
        const pointer = cssTarget(changingMode ? NEUTRAL : next === 'pan' ? camera : handoff.pointer, excursion);
        const phase = sweepPeriod === undefined ? 0 : Math.sin(2 * Math.PI * ((poser.time % sweepPeriod) / sweepPeriod));
        const automatic = { x: sweepLimit.x * phase, y: sweepLimit.y * phase };
        const liveOffsets = new Map<string, Point>();
        namedShifts = new Map();
        for (const [id, gain] of named.gains) {
          const state = liveByPlane.get(id);
          const live = state?.live ?? NEUTRAL;
          const translated = planeShift(pointer, next === 'pan' ? 1 : gain);
          const baked = state?.plate.baked;
          let correction = NEUTRAL;
          let displayed = { x: live.x / worldX, y: live.y / worldY };
          if (next === 'pan') {
            correction = translated;
            displayed = { x: displayed.x + correction.x, y: displayed.y + correction.y };
          } else if (next === 'parallax') {
            const auto = baked ? displayed : planeShift(automatic, gain);
            displayed = { x: (1 - weight) * auto.x + weight * translated.x,
              y: (1 - weight) * auto.y + weight * translated.y };
            correction = baked ? { x: weight * (translated.x - auto.x), y: weight * (translated.y - auto.y) } : displayed;
            if (baked && weight === 1 && pointer.x === 0 && pointer.y === 0) centered.set(state.plate.setup.slot, state.plate.setup);
          }
          liveOffsets.set(id, displayed);
          namedShifts.set(id, correction);
        }
        frameOffsets = Object.fromEntries(liveOffsets);
      }
      const shiftFor = (slot: PosedSlot) => {
        const { x, y } = namedShifts?.get(planes.get(slot.slot)!) ?? shifts[planes.get(slot.slot)!];
        return { x: x * stage.width / layout.cssWidth, y: y * stage.height / layout.cssHeight };
      };
      let positioned: PosedFrame;
      if (!layout.native) {
        // CanvasRenderer rounds world viewports outward. Project fractional
        // stage edges onto the exact integer backing rect before it draws.
        positioned = transformFrame(frame, shiftFor, {
          origin, scale: { x: layout.width / stage.width, y: layout.height / stage.height }, centered, clipInStockSpace: true,
        });
      } else if (!centered.size && (namedShifts ? [...namedShifts.values()] : Object.values(shifts))
        .every(shift => shift.x === 0 && shift.y === 0)) {
        positioned = frame;
        if (frame.order.some(slot => slot.clip)) {
          positioned = transformFrame(frame, () => NEUTRAL, { clipInStockSpace: true });
          const generation = Object.getOwnPropertyDescriptor(frame, 'generation');
          if (generation) Object.defineProperty(positioned, 'generation', generation);
        }
      } else {
        positioned = transformFrame(frame, shiftFor, { centered, clipInStockSpace: true });
      }
      return { frame: positioned, offsets: frameOffsets };
    }

    function checkBackdropAlpha(frame: PosedFrame, { figureSlots, backdrop }: NamedPlanes, next: CameraMode): void {
      // Hidden figure slots still mark the boundary between foreground and backdrop.
      const isFigure = (slot: { slot: string }) => figureSlots.has(slot.slot);
      const figures = frame.order.filter(isFigure);
      const firstFigure = figures.length === figureSlots.size ? figures[0] : poser.slotIdentity().slots.find(isFigure);
      // Keep the prepared slots so the audit samples the same clip geometry as the display.
      const order = frame.order.filter(slot => slot.z < (firstFigure?.z ?? Infinity));
      coverage.backend = renderer.backend;
      coverage.clipping = renderer.clipping;
      coverage.meshSourceRect = renderer.meshSourceRect;
      let nonOpaque: number;
      try {
        nonOpaque = auditBackdrop({ order }, renderer.viewport!, renderer.pixelRatio);
      } catch (error) {
        throw plateCoverageError(backdrop, next, `backdrop alpha cannot be read (${String(error)})`);
      }
      if (nonOpaque) {
        throw plateCoverageError(backdrop, next, `${nonOpaque} stage pixels have alpha below 255 at ${layout.width} × ${layout.height} backing px`);
      }
    }

    function currentFrame(next: CameraMode) {
      syncTurn(next);
      // Paused, held or zero-time steps may retain the prior pose.
      if (posedTurnInput !== turnInput) poser.repose();
      const frame = poser.posedFrame(null);
      if (named) return { frame, backdrop: checkFrame(frame, planes, named.backdrop) };
      return { frame, backdrop: checkFrame(frame, planes) };
    }

    function drawMode(frame: PosedFrame, backdrop: PosedSlot[], next: CameraMode, switching: boolean): void {
      const plates = named ? livePlates(frame, named, next) : [];
      const excursion = cameraExcursionFor(next);
      if (named) checkPlateEnvelopes(stage, layout, next, excursion, plates, named.gains, sweepLimit);
      else requireCoverage(backdrop, layout, next);

      const prepared = prepareFrame(frame, plates, next, excursion);
      if (named) checkBackdropAlpha(prepared.frame, named, next);
      renderer.render(prepared.frame);

      if (named && mode !== next) {
        camera = NEUTRAL;
        handoff.reset();
        if (next === 'parallax' && hover !== undefined) handoff.enter();
      }
      mode = next;
      if (!named && switching && mode === 'fixed') camera = target = NEUTRAL;
      offsets = prepared.offsets;
      if (named && mode === 'parallax') handoff.painted();
      canvas.style.visibility = '';
      Object.assign(canvas.style, { width: '100%', height: '100%', transform: 'none', pointerEvents: 'auto' });
    }

    function select(next: CameraMode, switching: boolean, allowFallback: boolean): void {
      const { frame, backdrop } = currentFrame(next);
      try {
        drawMode(frame, backdrop, next, switching);
      } catch (error) {
        if (!(error instanceof ComposedTakeError) || error.code !== 'COMPOSED_BACKDROP_COVERAGE'
          || next === 'fixed' || (!named && !allowFallback)) throw error;
        // Check the authored Fixed mode independently before presenting it.
        try {
          const fixed = turnInput.weight === 0 ? { frame, backdrop } : currentFrame('fixed');
          drawMode(fixed.frame, fixed.backdrop, 'fixed', true);
        } catch (fixedError) {
          canvas.style.visibility = 'hidden';
          throw fixedError;
        }
        refusal = error;
        if (!allowFallback) throw error;
      }
    }

    function renderCurrent(): void {
      try {
        select(mode, false, true);
      } catch (error) {
        if (error instanceof ComposedTakeError) refusal = error;
        if (named) canvas.style.visibility = 'hidden';
        stopped = true;
        if (frameId !== undefined) window.cancelAnimationFrame(frameId);
        throw error;
      }
    }

    function setCamera(next: CameraMode): void {
      if (disposed || stopped) return;
      try {
        checkMode(next);
        measure();
        select(next, true, false);
        refusal = null;
      } catch (error) {
        if (error instanceof ComposedTakeError) refusal = error;
        if (named && next === 'fixed') canvas.style.visibility = 'hidden';
        throw error;
      }
    }

    function advanceCamera(elapsed: number): void {
      if (!(elapsed > 0)) return;
      if (named && mode === 'parallax') handoff.advance(elapsed, target);
      else camera = easeCamera(camera, target, elapsed);
    }

    function syncCamera(now: number): void {
      const next = Math.max(lastCameraAt, now);
      advanceCamera((next - lastCameraAt) / 1000);
      lastCameraAt = next;
    }

    function advance(rigElapsed: number, cameraElapsed = rigElapsed): void {
      if (disposed || stopped) return;
      advanceCamera(cameraElapsed);
      syncTurn(mode);
      poser.advance(rigElapsed);
    }

    function render(): void {
      if (disposed || stopped) return;
      measure();
      renderCurrent();
    }

    measure();
    select(initial, true, named !== undefined);

    function leave(): void {
      if (hover === undefined || stopped) return;
      if (autoStart) syncCamera(window.performance.now());
      hover = undefined;
      target = NEUTRAL;
      if (mode === 'parallax') handoff.leave();
    }

    const boundaryEvent = (event: PointerEvent) => event.target === root || event.bubbles;
    const aim = (event: PointerEvent) => {
      if (!event.isPrimary || stopped) return;
      if (named) {
        if (event.pointerType === 'touch' || (event.type === 'pointerenter' && !boundaryEvent(event))
          || (hover !== undefined && hover !== event.pointerId)) return;
        if (event.pointerType === 'pen' && event.buttons !== 0) {
          leave();
          return;
        }
      }
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      const box = surface.getBoundingClientRect();
      if (!(box.width > 0 && box.height > 0)) return;
      if (named) {
        if (autoStart) syncCamera(window.performance.now());
        if (hover === undefined && mode === 'parallax') handoff.enter();
        hover = event.pointerId;
      }
      target = pointerTarget(event.clientX, event.clientY, box);
    };
    const recenter = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      if (!named) {
        target = NEUTRAL;
        return;
      }
      if (event.pointerType !== 'touch' && hover === event.pointerId
        && (event.type !== 'pointerleave' || boundaryEvent(event))) leave();
    };
    const contact = (event: PointerEvent) => {
      if (event.pointerType === 'pen' && event.isPrimary && hover === event.pointerId) leave();
    };
    root.addEventListener('pointermove', aim, true);
    root.addEventListener('pointerleave', recenter, true);
    root.addEventListener('pointercancel', recenter, true);
    if (named) {
      root.addEventListener('pointerenter', aim, true);
      root.addEventListener('pointerdown', contact, true);
      root.addEventListener('lostpointercapture', recenter, true);
      window.addEventListener('blur', leave);
    }
    const observer = new ResizeObserver(() => {
      try { render(); } catch (error) { if (!(error instanceof ComposedTakeError)) throw error; }
    });
    observer.observe(surface);

    if (autoStart) {
      let last = window.performance.now();
      lastCameraAt = last;
      frameId = window.requestAnimationFrame(function tick(now) {
        if (disposed || stopped) return;
        const elapsed = Math.max(0, (now - last) / 1000);
        last = now;
        if (named) {
          syncCamera(now);
          advance(Math.min(elapsed, 1 / 15), 0);
        } else {
          advance(Math.min(elapsed, 1 / 15), elapsed);
        }
        if (named || layout.dpr !== window.devicePixelRatio) measure();
        try { renderCurrent(); } catch (error) { if (!(error instanceof ComposedTakeError)) throw error; }
        if (!stopped) frameId = window.requestAnimationFrame(tick);
      });
    }

    return {
      canvas, player: poser,
      get mode() { return mode; },
      get offsets() { return offsets; },
      get cameraExcursion() { return cameraExcursionFor(mode); },
      cameraExcursionFor,
      get cameraTarget() { return cssTarget(target, cameraExcursionFor(mode)); },
      get turnReadouts() {
        return turnValues.map(reading => {
          const n = turnCoordinate(reading.axis, target);
          const clamped = mode === 'parallax' && hover !== undefined && (Math.abs(n) >= TURN_FULL_RANGE_AT_STAGE_EDGE
            || (n < 0 && reading.min === 0) || (n > 0 && reading.max === 0));
          return { ...reading, clamped };
        });
      },
      get refusal() { return refusal; },
      setCamera, advance, render,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (frameId !== undefined) window.cancelAnimationFrame(frameId);
        observer.disconnect();
        root.removeEventListener('pointermove', aim, true);
        root.removeEventListener('pointerleave', recenter, true);
        root.removeEventListener('pointercancel', recenter, true);
        if (named) {
          root.removeEventListener('pointerenter', aim, true);
          root.removeEventListener('pointerdown', contact, true);
          root.removeEventListener('lostpointercapture', recenter, true);
          window.removeEventListener('blur', leave);
        }
        poser.dispose();
        coverage.dispose();
        surface.remove();
        assets.dispose();
      },
    };
  } catch (error) {
    player?.dispose();
    audit?.dispose();
    surface.remove();
    assets.dispose();
    throw error;
  }
}
