import { CORE_DOCUMENT_SPEC, CoreInputError, poseRawAnimation, readModel } from '@rig-c/core/core';
import type { CanvasViewport } from './CanvasRenderer.js';

export type SceneCameraClock =
  | { basis: 'authored' | 'compiled'; seconds: number; endpoint?: 'phase' }
  | { endpoint: 'terminal' };

export interface SceneCameraFrame {
  readonly animation: string;
  readonly authoredSeconds: number;
  readonly compiledSeconds: number;
  /** Authored offsets in scene pixels, with Y down. */
  readonly pan: readonly [number, number];
  readonly zoom: number;
  readonly viewWorld: Readonly<CanvasViewport>;
  readonly output: Readonly<{ width: number; height: number }>;
  readonly loop: boolean;
}

export interface BoundSceneCamera {
  sample(animation: string, clock: SceneCameraClock): SceneCameraFrame | null;
}

export type SceneCameraRefusal = 'SCENE_CAMERA_REPORT_INVALID' | 'SCENE_CAMERA_MODEL_MISMATCH'
  | 'SCENE_CAMERA_CLIP_MISMATCH' | 'SCENE_CAMERA_CLOCK_INVALID' | 'SCENE_CAMERA_VIEW_INVALID'
  | 'SCENE_CAMERA_REPORT_TOO_LARGE';

// Parts 9da1aee / Core 3.11.0 wrote 7,777,629 UTF-8 bytes with two camera
// tracks and one figure per row. At 12 fps the 600-second shot has 7,201 rows
// and the 4-second idle has 49. Round up to the next power-of-two MiB (8 MiB).
// This budgets about ten minutes for the measured one-figure format, at
// about 1,072 bytes per added row. Budget about half the time for two figures
// if each is charged the full one-figure row cost.
export const SCENE_CAMERA_REPORT_MAX_BYTES = 8 * 1024 * 1024;

type Refuse = (code: SceneCameraRefusal, detail: string, cause?: unknown) => never;
type Sample = Pick<SceneCameraFrame, 'pan' | 'zoom'>;
type Key = Sample & { t: number; curve?: number[] | 'stepped' };
type Track = {
  duration: number;
  compiledDuration: number;
  loop: boolean;
  sample: (time: number) => Sample;
};

const PAN_CURVE_LENGTH = 8;
const SHA256 = /^[a-f0-9]{64}$/;
const floatBits = new DataView(new ArrayBuffer(4));
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;

function isReportBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Reflect.get(typedArrayPrototype, Symbol.toStringTag, value) === 'Uint8Array';
}

/** @internal Shared by the streaming loader and direct raw-byte binding. */
export function checkSceneCameraReportSize(byteLength: number, refuse: Refuse): void {
  if (byteLength > SCENE_CAMERA_REPORT_MAX_BYTES) {
    refuse('SCENE_CAMERA_REPORT_TOO_LARGE',
      `observed ${byteLength} raw report bytes with a cap of ${SCENE_CAMERA_REPORT_MAX_BYTES} bytes`);
  }
}

/** @internal Decode the exact bounded byte range as UTF-8 JSON. */
export function decodeSceneCameraReport(bytes: Uint8Array, refuse: Refuse): unknown {
  const byteLength = Reflect.get(typedArrayPrototype, 'byteLength', bytes) as number;
  checkSceneCameraReportSize(byteLength, refuse);
  try {
    // Fix the checked extent even for a length-tracking view of a growable buffer.
    const buffer = Reflect.get(typedArrayPrototype, 'buffer', bytes) as ArrayBufferLike;
    const byteOffset = Reflect.get(typedArrayPrototype, 'byteOffset', bytes) as number;
    const view = new Uint8Array(buffer, byteOffset, byteLength);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(view)) as unknown;
  } catch (error) {
    return refuse('SCENE_CAMERA_REPORT_INVALID', 'the scene report is not valid UTF-8 JSON', error);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const durationValue = (value: unknown): value is number => finite(value) && value >= 0;
const positive = (value: unknown): value is number => finite(value) && value > 0;
const usableZoom = (zoom: unknown): zoom is number => positive(zoom) && positive(1 / zoom);
const isDigest = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);
const matchesSample = (a: Sample, b: Sample): boolean =>
  a.pan[0] === b.pan[0] && a.pan[1] === b.pan[1] && a.zoom === b.zoom;

function readCameraHeader(report: unknown, refuse: Refuse) {
  if (isRecord(report) && report.spec === 'spine-parts-scene-report/1') return null;
  if (!isRecord(report) || report.spec !== 'spine-parts-scene-report/2' || !isRecord(report.camera)) {
    return refuse('SCENE_CAMERA_REPORT_INVALID', 'expected a scene report /1 or a scene report /2 with a camera record');
  }
  const { canvas, camera } = report;
  const { backdrop, fps, coverage, tracks, model_sha256: digest } = camera;
  if (typeof backdrop !== 'string' || !backdrop.length || fps !== 12 || !isRecord(tracks) || Object.keys(tracks).length === 0
    || !isRecord(coverage) || coverage.status !== 'PASS' || coverage.max_edge_overrun_px !== 0
    || coverage.nonopaque_source_texels !== 0 || coverage.nonopaque_output_pixels !== 0
    || !isRecord(canvas) || !positive(canvas.width) || !positive(canvas.height)) {
    return refuse('SCENE_CAMERA_REPORT_INVALID', 'expected a canvas and a keyed 12 fps camera with PASS coverage and zero overruns and alpha counts');
  }
  return { width: canvas.width, height: canvas.height, backdrop, fps, tracks, digest };
}

function requireDigest(digest: unknown, refuse: Refuse): string {
  if (digest === undefined || digest === null) {
    return refuse('SCENE_CAMERA_MODEL_MISMATCH', 'the scene camera report needs a model SHA-256');
  }
  if (!isDigest(digest)) return refuse('SCENE_CAMERA_REPORT_INVALID', 'the model SHA-256 must be 64 lowercase hexadecimal digits');
  return digest;
}

/** @internal Read the expected digest before the model loader parses its response. */
export function sceneCameraModelDigest(report: unknown, refuse: Refuse): string | null {
  const camera = readCameraHeader(report, refuse);
  return camera === null ? null : requireDigest(camera.digest, refuse);
}

type ScreenShift = { x: number; y: number };

function finiteTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && [...value].every(finite);
}

/** @internal Admit extra translation using only the producer's sampled geometry. */
export function sceneCameraDriftEvidence(report: unknown, refuse: Refuse) {
  const camera = readCameraHeader(report, refuse);
  if (!camera) return null;
  const { backdrop, width, height, fps, tracks } = camera;
  return {
    backdrop,
    failure(animation: string, pointer: ScreenShift, sweep: ScreenShift, backingPixel: ScreenShift): string | undefined {
      const track = tracks[animation];
      if (!isRecord(track) || !durationValue(track.duration) || !durationValue(track.compiled_duration)
        || !Array.isArray(track.frames)) return 'missing sampled backdrop geometry';
      const { duration, compiled_duration: compiled, frames } = track;
      const ticks = Math.ceil(duration * fps);
      const terminal = ticks > 0 && (ticks - 1) / fps >= duration ? ticks - 1 : ticks;
      if (ticks >= 0xffffffff || frames.length !== terminal + 1) {
        return `incomplete sampled backdrop geometry at ${fps} fps through ${duration} s`;
      }
      for (const [i, row] of frames.entries()) {
        const at = i === terminal ? duration : i / fps;
        const label = `sample ${i} at ${at} authored s`;
        if (!isRecord(row) || row.frame !== i || row.authored_time !== at
          || row.compiled_time !== (i === terminal ? compiled : at / duration * compiled)
          || !usableZoom(row.zoom) || !finiteTuple(row.view, 4) || !Array.isArray(row.backdrop_quad)
          || row.backdrop_quad.length !== 4 || ![...row.backdrop_quad].every(point => finiteTuple(point, 2))) {
          return `${label} has invalid backdrop evidence`;
        }
        const { zoom, view: [left, top, right, bottom], backdrop_quad: quad } = row;
        const viewWidth = right - left, viewHeight = bottom - top;
        // Use the producer's coordinate-scale tolerance for double-precision edge contact.
        const tolerance = 4 * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(top), Math.abs(right), Math.abs(bottom));
        if (!positive(viewWidth) || !positive(viewHeight)
          || Math.abs(viewWidth - width / zoom) > tolerance || Math.abs(viewHeight - height / zoom) > tolerance) {
          return `${label} has a view inconsistent with its output size and zoom`;
        }
        const px = pointer.x / zoom, py = pointer.y / zoom;
        const sx = sweep.x / zoom, sy = sweep.y / zoom;
        if (![px, py, sx, sy].every(finite)) return `${label} has a nonfinite scene excursion`;
        const gx = backingPixel.x / zoom, gy = backingPixel.y / zoom;
        if (!positive(gx) || !positive(gy)) return `${label} has an invalid backing-pixel edge guard`;

        const edgeTolerance = Math.max(tolerance, 4 * Number.EPSILON * Math.max(...quad.flat().map(Math.abs)));
        let winding = 0;
        for (const [edge, [x, y]] of quad.entries()) {
          const [nextX, nextY] = quad[(edge + 1) % 4];
          const dx = nextX - x, dy = nextY - y;
          const length = Math.hypot(dx, dy);
          const nx = -dy / length, ny = dx / length;
          const distance = ([a, b]: number[]) => nx * (a - x) + ny * (b - y);
          const a = distance(quad[(edge + 2) % 4]), b = distance(quad[(edge + 3) % 4]);
          if (edge === 0) winding = Math.sign(a);
          const side = ['left', 'top', 'right', 'bottom'][edge];
          if (!positive(length) || !finite(a) || !finite(b) || !(a * winding > 0 && b * winding > 0)) {
            return `${label} has an invalid convex backdrop quad at its ${side} edge`;
          }
          const margin = winding * distance([nx * winding >= 0 ? left : right, ny * winding >= 0 ? top : bottom]);
          // Pointer travel fills a rectangle. Both sweep axes share one sine,
          // so the sweep is a segment. A convex handoff uses the greater support.
          const excursion = Math.max(Math.abs(nx * px) + Math.abs(ny * py), Math.abs(nx * sx + ny * sy));
          if (!finite(margin) || !finite(excursion)) return `${label} has nonfinite ${side} edge margin or excursion`;
          // The raster needs one backing pixel along both axes at the drift limit.
          const guard = Math.abs(nx) * gx + Math.abs(ny) * gy;
          const requiredExcursion = excursion + guard;
          if (!positive(guard) || !finite(requiredExcursion)) return `${label} has an invalid ${side} edge guard or guarded excursion`;
          if (margin - requiredExcursion < -edgeTolerance) {
            return `${label}, ${side} edge margin ${margin} scene px, required excursion ${excursion} scene px, edge guard ${guard} scene px`;
          }
        }
      }
      return undefined;
    },
  };
}

/** Core's model format uses the shortest decimal naming a float32. Core uses
 * those stated decimals when it constructs the curve, then rounds the keys.
 * Keep the storage rule from compile.ts here so the Node compiler stays out
 * of the browser graph. Evaluation stays in the bundled Core poser.
 */
function storedFloat32(value: number): number {
  const rounded = Math.fround(value);
  if (rounded === 0 || !Number.isFinite(rounded)) return rounded === 0 ? 0 : rounded;
  const magnitude = Math.abs(rounded);
  const sign = rounded < 0 ? '-' : '';
  floatBits.setFloat32(0, magnitude);
  const word = floatBits.getUint32(0);
  const exponent = word >>> 23;
  const significand = BigInt((word & 0x7fffff) | (exponent === 0 ? 0 : 0x800000));
  const doubledPower = (exponent === 0 ? -149 : exponent - 150) + 1;
  for (let digits = 1; digits <= 9; digits++) {
    const [mantissa, power] = magnitude.toExponential(digits - 1).split('e');
    const nearest = BigInt(mantissa.replace('.', ''));
    const scale = Number(power) - (digits - 1);
    const candidates = [nearest - 1n, nearest, nearest + 1n].filter(
      candidate => candidate > 0n && Math.fround(Number(`${candidate}e${scale}`)) === magnitude,
    );
    if (candidates.length === 0) continue;
    const chosen = candidates.reduce((a, b) => {
      // Compare the exact midpoint of the two decimals to the binary float.
      let midpoint = a + b;
      let float = significand;
      if (scale >= 0) midpoint *= 10n ** BigInt(scale);
      else float *= 10n ** BigInt(-scale);
      if (doubledPower >= 0) float <<= BigInt(doubledPower);
      else midpoint <<= BigInt(-doubledPower);
      return midpoint < float || (midpoint === float && b % 2n === 0n) ? b : a;
    });
    return Number(`${sign}${chosen}e${scale}`);
  }
  // Nine digits suffice for every finite float32.
  return rounded;
}

function storedTime(time: number): number {
  const named = storedFloat32(time);
  const nearest = Math.fround(time);
  if (named === time || nearest <= time || !Number.isFinite(nearest)) return named;
  floatBits.setFloat32(0, nearest);
  floatBits.setUint32(0, floatBits.getUint32(0) - 1);
  return storedFloat32(floatBits.getFloat32(0));
}

function coreSampler(keys: Key[], duration: number, label: string, refuse: Refuse): (time: number) => Sample {
  const times = keys.map(key => storedTime(key.t));
  for (const [i, key] of keys.entries()) {
    if (!Number.isFinite(times[i]) || (i > 0 && times[i] <= times[i - 1])
      || !key.pan.every(value => Number.isFinite(Math.fround(value))) || !positive(Math.fround(1 / key.zoom))) {
      refuse('SCENE_CAMERA_REPORT_INVALID', `${label} key ${i} cannot be stored in a float32 translation timeline`);
    }
  }
  const name = 'camera';
  try {
    // The three channels are the world translations of two independent roots,
    // as in Parts. The synthetic document never carries model or report data
    // beyond these normalized timelines.
    const doc = readModel(JSON.stringify({
      spec: CORE_DOCUMENT_SPEC, referenceScale: 1, stage: null,
      bones: [{ name: 'pan' }, { name: 'span' }], slots: [], skins: [], constraints: [], events: [],
      animations: [{
        name, duration, slots: [], constraints: { ik: [], transform: [], path: [], physics: [], slider: [] },
        attachments: [], drawOrder: [], events: [],
        bones: [
          { name: 'pan', timelines: [{ name: 'translate', keys: keys.map((key, i) => ({
            time: times[i], x: storedFloat32(key.pan[0]), y: storedFloat32(key.pan[1]),
            curve: Array.isArray(key.curve) ? key.curve.slice(0, PAN_CURVE_LENGTH) : key.curve,
          })) }] },
          { name: 'span', timelines: [{ name: 'translatex', keys: keys.map((key, i) => ({
            time: times[i], value: storedFloat32(1 / key.zoom),
            curve: Array.isArray(key.curve) ? key.curve.slice(PAN_CURVE_LENGTH) : key.curve,
          })) }] },
        ],
      }],
      editorOrder: { skins: [], animations: [name] },
      images: [], pageGrids: [], droppedStates: [], absentParts: [], meshBones: [], meshes: [], physics: [],
      deformTransforms: [], trackDerivations: [], rig: {}, pages: [], spine: { sha256: '0'.repeat(64) },
    }), label);
    return time => {
      try {
        const [pan, span] = poseRawAnimation(doc, name, time === 0 ? [] : [time]).at(-1)!.bones;
        const zoom = 1 / span.worldX;
        if (!finite(pan.worldX) || !finite(pan.worldY) || !usableZoom(zoom)) {
          return refuse('SCENE_CAMERA_VIEW_INVALID', `${label} evaluates at ${time} s to nonfinite pan or unusable zoom`);
        }
        return { pan: [pan.worldX, pan.worldY], zoom };
      } catch (error) {
        if (!(error instanceof CoreInputError)) throw error;
        return refuse('SCENE_CAMERA_VIEW_INVALID', `${label} cannot be evaluated at ${time} s`, error);
      }
    };
  } catch (error) {
    if (!(error instanceof CoreInputError)) throw error;
    return refuse('SCENE_CAMERA_REPORT_INVALID', `${label} cannot be read as a Core timeline`, error);
  }
}

function validViewport(view: unknown): view is CanvasViewport {
  return isRecord(view) && finite(view.x) && finite(view.y) && positive(view.width) && positive(view.height)
    && finite(view.x + view.width) && view.x + view.width > view.x
    && finite(view.y + view.height) && view.y + view.height > view.y;
}

function cameraView(stage: CanvasViewport, { pan, zoom }: Sample, label: string, refuse: Refuse): CanvasViewport {
  const centerX = stage.x + stage.width / 2 + pan[0];
  const centerY = stage.y + (stage.height - (stage.height / 2 + pan[1]));
  const halfWidth = stage.width / zoom / 2;
  const halfHeight = stage.height / zoom / 2;
  const x = centerX - halfWidth;
  const y = centerY - halfHeight;
  const width = centerX + halfWidth - x;
  const height = centerY + halfHeight - y;
  const view = { x, y, width, height };
  if (!usableZoom(zoom) || !validViewport(view) || !positive(width * zoom) || !positive(height * zoom)) {
    refuse('SCENE_CAMERA_VIEW_INVALID', `${label} needs a finite, positive, noncollapsed camera view`);
  }
  return view;
}

function readTrack(raw: unknown, compiled: number, stage: CanvasViewport, label: string, refuse: Refuse): Track {
  if (!isRecord(raw) || !durationValue(raw.duration) || !durationValue(raw.compiled_duration)
    || typeof raw.loop !== 'boolean' || !Array.isArray(raw.keys) || raw.keys.length === 0 || !Array.isArray(raw.frames)) {
    return refuse('SCENE_CAMERA_REPORT_INVALID', `${label} needs keys, durations, a loop flag and a frames list`);
  }
  const { duration, loop } = raw;
  if (raw.compiled_duration !== compiled || (duration === 0) !== (compiled === 0)) {
    refuse('SCENE_CAMERA_CLIP_MISMATCH', `${label} cannot map ${duration} authored s and ${raw.compiled_duration} reported compiled s to ${compiled} model s`);
  }
  const keys: Key[] = [];
  for (const [i, key] of raw.keys.entries()) {
    const at = `${label} key ${i}`;
    if (!isRecord(key) || Object.keys(key).some(field => !['t', 'pan', 'zoom', 'curve'].includes(field))) {
      return refuse('SCENE_CAMERA_REPORT_INVALID', `${at} needs normalized t, pan, zoom and an optional outgoing curve`);
    }
    const { t, pan, zoom, curve } = key;
    if (!finite(t) || (i === 0 ? t !== 0 : t <= keys[i - 1].t)
      || !Array.isArray(pan) || pan.length !== 2 || !finite(pan[0]) || !finite(pan[1]) || !usableZoom(zoom)) {
      return refuse('SCENE_CAMERA_REPORT_INVALID', `${at} needs ordered finite seconds from zero, finite pan and positive zoom`);
    }
    if (curve !== undefined) {
      const validCurve = curve === 'stepped' || (Array.isArray(curve) && curve.length === 12 && [...curve].every(
        value => finite(value) && Number.isFinite(Math.fround(value)) && storedFloat32(value) === value,
      ));
      if (!validCurve || i === raw.keys.length - 1) {
        return refuse('SCENE_CAMERA_REPORT_INVALID', `${at} needs a nonterminal outgoing curve (stepped or twelve float32 decimals)`);
      }
    }
    const normalized: Key = { t, pan: [pan[0], pan[1]], zoom, curve: Array.isArray(curve) ? [...curve] : curve };
    cameraView(stage, normalized, at, refuse);
    keys.push(normalized);
  }
  const first = keys[0], last = keys[keys.length - 1];
  if (last.t !== duration || (loop && !matchesSample(first, last))) {
    refuse('SCENE_CAMERA_REPORT_INVALID', `${label} must end at its authored duration and close exactly when looped`);
  }

  const core = keys.some(key => key.curve !== undefined) ? coreSampler(keys, duration, label, refuse) : undefined;
  const start = core?.(0), end = core?.(Math.fround(storedTime(duration)));
  if (start && end && loop && !matchesSample(start, end)) {
    refuse('SCENE_CAMERA_REPORT_INVALID', `${label} must close exactly at the Core-evaluated loop endpoints`);
  }
  const easedStart = first.curve !== undefined;
  const easedEnd = keys.at(-2)?.curve !== undefined;
  const easedSeam = loop && (easedStart || easedEnd);
  if (start && (easedSeam || easedStart)) cameraView(stage, start, label, refuse);
  if (end && (easedSeam || easedEnd)) cameraView(stage, end, label, refuse);
  return {
    duration, compiledDuration: compiled, loop,
    sample(time) {
      // A mixed loop uses the same precision at both sides of its seam.
      if (time === 0 && (easedSeam || easedStart) && start) return start;
      if (time === duration && (easedSeam || easedEnd) && end) return end;
      let low = 0, high = keys.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (keys[mid].t <= time) low = mid;
        else high = mid - 1;
      }
      const from = keys[low], to = keys[low + 1];
      if (from.curve !== undefined && core) return core(time);
      if (time === from.t || to === undefined) return from;
      const phase = (time - from.t) / (to.t - from.t);
      const mix = (a: number, b: number): number => a + (b - a) * phase;
      return { pan: [mix(from.pan[0], to.pan[0]), mix(from.pan[1], to.pan[1])], zoom: 1 / mix(1 / from.zoom, 1 / to.zoom) };
    },
  };
}

function cameraTimes(track: Track, clock: SceneCameraClock, refuse: Refuse): { authoredSeconds: number; compiledSeconds: number } {
  const { duration, compiledDuration, loop } = track;
  if (isRecord(clock) && clock.endpoint === 'terminal' && !('basis' in clock) && !('seconds' in clock)) {
    return { authoredSeconds: duration, compiledSeconds: compiledDuration };
  }
  if (!isRecord(clock) || (clock.endpoint !== undefined && clock.endpoint !== 'phase')
    || (clock.basis !== 'authored' && clock.basis !== 'compiled') || !durationValue(clock.seconds)) {
    return refuse('SCENE_CAMERA_CLOCK_INVALID', 'expected terminal or finite nonnegative phase seconds on the authored or compiled clock');
  }
  const authored = clock.basis === 'authored';
  const limit = authored ? duration : compiledDuration;
  const otherLimit = authored ? compiledDuration : duration;
  const time = limit === 0 || clock.seconds === 0 ? 0 : loop ? clock.seconds % limit : Math.min(clock.seconds, limit);
  const otherTime = time === limit ? otherLimit : time / limit * otherLimit;
  return authored ? { authoredSeconds: time, compiledSeconds: otherTime } : { authoredSeconds: otherTime, compiledSeconds: time };
}

/** @internal The public wrapper provides the composed-take error constructor. */
export function bindSceneCameraReport(
  report: unknown,
  model: { sha256: string; stage: CanvasViewport | null; animations: readonly { name: string; duration: number }[] },
  refuse: Refuse,
): BoundSceneCamera | null {
  const document = isReportBytes(report) ? decodeSceneCameraReport(report, refuse) : report;
  const camera = readCameraHeader(document, refuse);
  if (camera === null) return null;
  if (!validViewport(model?.stage)) return refuse('SCENE_CAMERA_VIEW_INVALID', 'the model needs a finite, positive, noncollapsed stage');
  if (model.sha256 !== requireDigest(camera.digest, refuse)) {
    refuse('SCENE_CAMERA_MODEL_MISMATCH', 'the scene camera SHA-256 does not match the consumed model');
  }
  const { x, y, width, height } = model.stage;
  const stage = { x, y, width, height };
  if (camera.width !== stage.width || camera.height !== stage.height) {
    refuse('SCENE_CAMERA_MODEL_MISMATCH', 'the report canvas dimensions must match the model stage');
  }

  const durations = new Map<string, number>();
  if (!Array.isArray(model.animations)) refuse('SCENE_CAMERA_CLIP_MISMATCH', 'the model needs an animation list');
  for (const animation of model.animations) {
    if (!isRecord(animation) || typeof animation.name !== 'string' || !animation.name.length
      || durations.has(animation.name) || !durationValue(animation.duration)) {
      refuse('SCENE_CAMERA_CLIP_MISMATCH', 'the model needs unique animation names with finite nonnegative durations');
    }
    durations.set(animation.name, animation.duration);
  }
  const bound = new Map<string, Track>();
  for (const [animation, raw] of Object.entries(camera.tracks)) {
    const label = `scene camera track ${JSON.stringify(animation)}`;
    const duration = durations.get(animation);
    if (duration === undefined) return refuse('SCENE_CAMERA_CLIP_MISMATCH', `${label} is absent from the model`);
    bound.set(animation, readTrack(raw, duration, stage, label, refuse));
  }
  const output = Object.freeze({ width: stage.width, height: stage.height });
  return Object.freeze({
    sample(animation: string, clock: SceneCameraClock): SceneCameraFrame | null {
      if (!durations.has(animation)) refuse('SCENE_CAMERA_CLIP_MISMATCH', `unknown model animation ${JSON.stringify(animation)}`);
      const track = bound.get(animation);
      if (!track) return null;
      const times = cameraTimes(track, clock, refuse);
      const { pan, zoom } = track.sample(times.authoredSeconds);
      const viewWorld = cameraView(stage, { pan, zoom }, `scene camera track ${JSON.stringify(animation)} at ${times.authoredSeconds} s`, refuse);
      return Object.freeze({
        animation, ...times, pan: Object.freeze([pan[0], pan[1]] as const), zoom,
        viewWorld: Object.freeze(viewWorld), output, loop: track.loop,
      });
    },
  });
}

/** @internal Shared by the public projection and the pose-to-backing transform. */
export function sceneCameraTransform(frame: SceneCameraFrame, refuse: Refuse) {
  if (!frame || !validViewport(frame.viewWorld) || !usableZoom(frame.zoom)
    || !frame.output || !positive(frame.output.width) || !positive(frame.output.height)
    || !positive(frame.viewWorld.width * frame.zoom) || !positive(frame.viewWorld.height * frame.zoom)) {
    return refuse('SCENE_CAMERA_VIEW_INVALID', 'expected finite authored output dimensions and a positive, noncollapsed camera view');
  }
  const { viewWorld, zoom, output } = frame;
  return { origin: { x: viewWorld.x, y: viewWorld.y + viewWorld.height }, zoom, width: output.width, height: output.height };
}

/** @internal The public wrapper provides the composed-take error constructor. */
export function projectSceneCamera(frame: SceneCameraFrame, refuse: Refuse) {
  const { origin, zoom, width, height } = sceneCameraTransform(frame, refuse);
  return {
    worldToOutput: ({ x, y }: { x: number; y: number }) => ({ x: (x - origin.x) * zoom, y: (origin.y - y) * zoom }),
    outputToWorld: ({ x, y }: { x: number; y: number }) => ({ x: origin.x + x / zoom, y: origin.y - y / zoom }),
    outputClip: { x: 0, y: 0, width, height },
  };
}
