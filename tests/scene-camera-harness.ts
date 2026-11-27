import {
  bindSceneCamera, mountComposedTake, renderSceneCameraFrame, SCENE_CAMERA_REPORT_MAX_BYTES, sceneCameraProjection,
} from '../src/composed-take.js';
import { CanvasRenderer, loadModel, RigPlayer, type PosedClip, type PosedFrame, type PosedSlot } from '../src/index.js';
import { renderFrameOf } from '../src/liveFrameSource.js';

type Take = Awaited<ReturnType<typeof mountComposedTake>>;
type Frame = NonNullable<Parameters<typeof renderSceneCameraFrame>[2]>;
type Clock = Parameters<NonNullable<ReturnType<typeof bindSceneCamera>>['sample']>[1];
type Point = { x: number; y: number };
type Size = { width: number; height: number };
export type Backend = CanvasRenderer['backend'];

export interface Source {
  modelUrl: string;
  sceneReportUrl?: string;
}
export interface MountOptions extends Source {
  backend: Backend;
  animation: string;
  loop: boolean;
  movingBackdrop?: boolean;
  bakedForeground?: false;
  maxDisplacement?: Point;
}
export interface Move {
  play?: { animation: string; loop: boolean };
  seek?: number;
  pause?: boolean;
  advance?: number;
  aim?: boolean;
}
interface DirectOptions extends Source {
  backend: Backend;
  animation: string;
  clocks: Clock[];
  backing?: Size;
  backdropControlIndex?: number;
}
type Draw = ReturnType<typeof capture>['draw'];

const figure = ['actor:background', 'actor:torso', 'actor:lantern', 'actor:face', 'actor:eye_r', 'actor:eye_l'];
const stage = document.querySelector<HTMLElement>('#stage')!;

const vertices = (slot: PosedSlot) => slot.kind === 'region' ? slot.corners : slot.vertices;
const context = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Readback requires Canvas2D on the output canvas');
  return ctx;
};
const digest = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  byte => byte.toString(16).padStart(2, '0')).join('');

function capture(renderer: CanvasRenderer, action: () => void, output: Size) {
  const original = CanvasRenderer.prototype.render;
  const draws: Array<{
    slots: { name: string; kind: PosedSlot['kind']; points: number[]; clip: number[] | null }[];
    backend: Backend; triangles: number; clipCount: number; reused: number;
    viewport: NonNullable<CanvasRenderer['viewport']>; ratio: number;
  }> = [];
  CanvasRenderer.prototype.render = function (input) {
    if (this !== renderer) return original.call(this, input);
    const frame = renderFrameOf(input);
    original.call(this, input);
    const viewport = this.viewport;
    if (!viewport) throw new Error('Camera draw did not set a viewport');
    // Read the canvas renderer's public viewport and ratio at the draw call.
    // Undo the backing conversion to compare authored output pixels with Parts.
    const left = Math.floor(viewport.x);
    const top = Math.floor(-(viewport.y + viewport.height));
    const sx = this.pixelRatio * output.width / this.canvas.width;
    const sy = this.pixelRatio * output.height / this.canvas.height;
    const points = (values: readonly number[]) => values.map((value, i) => i % 2 === 0 ? (value - left) * sx : (-value - top) * sy);
    draws.push({
      slots: frame.order.map(slot => ({
        name: slot.slot, kind: slot.kind, points: points(vertices(slot)),
        clip: slot.clip ? points(slot.clip.polygon) : null,
      })),
      viewport: { ...viewport }, ratio: this.pixelRatio,
      backend: this.backendActive, triangles: this.trianglesDrawn,
      clipCount: this.clipCount, reused: this.framesReused,
    });
  };
  try { action(); }
  finally { CanvasRenderer.prototype.render = original; }
  if (draws.length !== 1) throw new Error(`Expected one output draw, got ${draws.length}`);
  const { width, height } = renderer.canvas;
  const image = context(renderer.canvas).getImageData(0, 0, width, height);
  const draw = { ...draws[0], width, height };
  return { draw, image };
}

async function readback({ data }: ImageData) {
  let visible = 0;
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) {
    visible += Number(data[i] > 0);
    opaque += Number(data[i] === 255);
  }
  return { visible, opaque, sha256: await digest(data) };
}

function diff(a: ImageData, b: ImageData) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Different backing sizes');
  let pixels = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(a.data[i + c] - b.data[i + c]));
    pixels += Number(delta !== 0);
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  return { pixels, maxChannelDelta };
}

async function openTake({ backend, animation, loop, movingBackdrop, bakedForeground, maxDisplacement, ...source }: MountOptions) {
  if (!source.sceneReportUrl && !loop) throw new Error('A one-shot mount requires a scene report');
  const bound = source.sceneReportUrl === undefined
    ? { modelUrl: source.modelUrl, loop: true as const }
    : { modelUrl: source.modelUrl, loop, sceneReportUrl: source.sceneReportUrl };
  return mountComposedTake(stage, {
    ...bound, animation, backend, autoStart: false,
    ...(maxDisplacement !== undefined && { maxDisplacement }),
    planes: {
      backdrop: {
        role: 'backdrop', slots: ['backdrop'],
        ...(movingBackdrop && { baked: { bone: 'backdrop' } }),
      },
      figure: { role: 'figure', slots: figure },
      foreground: {
        role: 'overlay', slots: ['foreground'], gain: 0.55,
        ...(animation === 'idle' && bakedForeground !== false && { baked: { bone: 'foreground' } }),
      },
    },
  });
}

function move(take: Take, action: Move) {
  if (action.play) take.player.play(action.play.animation, { loop: action.play.loop });
  if (action.pause === true) take.player.pause();
  if (action.pause === false) take.player.resume();
  if (action.seek !== undefined) take.player.seek(action.seek);
  if (action.advance !== undefined) take.advance(action.advance, 0);
  if (action.aim) {
    take.setCamera('pan');
    const { left, top, width, height } = take.canvas.getBoundingClientRect();
    stage.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, isPrimary: true, pointerType: 'mouse', pointerId: 1,
      clientX: left + 0.75 * width, clientY: top + 0.75 * height,
    }));
    take.advance(0, 120);
  }
}

const output = { width: 128, height: 128 };

async function mounted(options: MountOptions, actions: Move[]) {
  const take = await openTake(options);
  try {
    const readings = [];
    for (const action of actions) {
      move(take, action);
      const { draw, image } = capture(take.player.renderer as CanvasRenderer, () => take.render(), output);
      const entry = take.player.entry(0);
      readings.push({
        draw, pixel: await readback(image), animation: entry?.animation, trackTime: entry?.trackTime, animationTime: entry?.animationTime,
        mode: take.mode, offsets: take.offsets, cameraTarget: take.cameraTarget, refusal: take.refusal?.code ?? null,
      });
    }
    return readings;
  } finally { take.dispose(); }
}

async function response(url: string) {
  const result = await fetch(url);
  if (!result.ok) throw new Error(`Fetch failed for ${url}: ${result.status}`);
  return result;
}

async function readBinding({ modelUrl, sceneReportUrl }: Source) {
  if (!sceneReportUrl) throw new Error('A scene report URL is required for direct binding');
  const [reportRes, modelRes, assets] = await Promise.all([
    response(sceneReportUrl), response(modelUrl), loadModel({ modelUrl, regions: 'none', setsUrl: null }),
  ]);
  try {
    const [report, bytes] = await Promise.all([reportRes.json(), modelRes.arrayBuffer()]);
    const model = { sha256: await digest(bytes), stage: assets.stage, animations: assets.animations };
    return { model, report, assets };
  } catch (error) {
    assets.dispose();
    throw error;
  }
}

const required = <T>(value: T | null, label: string) => {
  if (value === null) throw new Error(`Missing ${label}`);
  return value;
};

function projection(frame: Frame) {
  const projected = sceneCameraProjection(frame);
  const point = { x: -11.25, y: 24.5 };
  const outside = { x: -17.25, y: 141.75 };
  const device = projected.worldToOutput(point);
  const outsideWorld = projected.outputToWorld(outside);
  return {
    animation: frame.animation, authoredSeconds: frame.authoredSeconds, compiledSeconds: frame.compiledSeconds,
    loop: frame.loop, zoom: frame.zoom, outputClip: projected.outputClip,
    point, device, roundTrip: projected.outputToWorld(device),
    outside, outsideWorld, outsideRoundTrip: projected.worldToOutput(outsideWorld),
  };
}

async function direct({ backend, animation, clocks, backing, backdropControlIndex, ...source }: DirectOptions) {
  const { model, report, assets } = await readBinding(source);
  const player = new RigPlayer(document.createElement('div'), assets, { mode: 'canvas' });
  const renderer = player.renderer as CanvasRenderer;
  renderer.backend = backend;
  try {
    const camera = required(bindSceneCamera(report, model), 'scene camera');
    const backdropSlot = (pose: PosedFrame) => required(pose.order.find(slot => slot.slot === 'backdrop') ?? null, 'backdrop');
    player.play(animation, { loop: false });
    const initialBackdrop = backdropControlIndex === undefined ? null : backdropSlot(player.posedFrame());
    const readings = [];
    for (const [index, clock] of clocks.entries()) {
      const frame = required(camera.sample(animation, clock), 'keyed sample');
      player.play(animation, { loop: false });
      player.seek(frame.compiledSeconds);
      const pose = player.posedFrame();
      const { draw, image } = capture(renderer, () => renderSceneCameraFrame(renderer, pose, frame, backing), output);
      let backdropControl: { actual: Awaited<ReturnType<typeof readback>>; difference: ReturnType<typeof diff> } | undefined;
      if (initialBackdrop && index === backdropControlIndex) {
        const paint = (slot: PosedSlot) => capture(renderer,
          () => renderSceneCameraFrame(renderer, { order: [slot] }, frame, backing), output).image;
        const actual = paint(backdropSlot(pose));
        const frozen = paint(initialBackdrop);
        backdropControl = { actual: await readback(actual), difference: diff(actual, frozen) };
      }
      readings.push({ ...projection(frame), draw, pixel: await readback(image), backdropControl });
    }
    return readings;
  } finally { player.dispose(); assets.dispose(); }
}

async function legacy(options: MountOptions, at: number, reports: string[], raw: boolean) {
  const paint = async (sceneReportUrl?: string) => {
    const take = await openTake({ ...options, sceneReportUrl });
    try {
      take.advance(at, 0);
      const { draw, image } = capture(take.player.renderer as CanvasRenderer, () => take.render(), output);
      return { draw, image };
    } finally { take.dispose(); }
  };
  const plain = await paint();
  const comparisons = [];
  for (const url of reports) {
    const other = await paint(url);
    comparisons.push({ url, backend: other.draw.backend, ...diff(plain.image, other.image) });
  }
  return {
    backend: plain.draw.backend, width: plain.image.width, height: plain.image.height, dpr: devicePixelRatio,
    pixel: await readback(plain.image), comparisons,
    raw: raw ? Array.from(plain.image.data) : undefined,
  };
}

function refusal(action: () => unknown) {
  try { action(); return null; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { code: 'code' in error ? error.code : undefined, message: error.message };
  }
}

async function refusals(source: Source, reserializedModel: string, v1Url: string) {
  const { model, report, assets } = await readBinding(source);
  try {
    const camera = required(bindSceneCamera(report, model), 'scene camera');
    const v1 = await (await response(v1Url)).json();
    const reserialized = await (await response(reserializedModel)).arrayBuffer();
    const reserializedSha = await digest(reserialized);
    if (reserializedSha === model.sha256) throw new Error('Reserialization did not change model bytes');
    const missingDigest = structuredClone(report);
    delete missingDigest.camera.model_sha256;
    const invalidCoverage = structuredClone(report);
    invalidCoverage.camera.coverage.nonopaque_output_pixels = 1;
    const clock = { basis: 'compiled', seconds: 2 } as const;
    let mountRefusal: ReturnType<typeof refusal>;
    try {
      const unexpected = await openTake({
        ...source, modelUrl: reserializedModel, backend: 'canvas2d', animation: 'idle', loop: true,
      });
      unexpected.dispose();
      mountRefusal = null;
    } catch (error) { mountRefusal = refusal(() => { throw error; }); }
    return {
      legacy: bindSceneCamera(v1, model) === null,
      unkeyed: camera.sample('actor:body_turn', clock) === null,
      positive: camera.sample('idle', clock) !== null,
      coverage: refusal(() => bindSceneCamera(invalidCoverage, model)),
      bytes: refusal(() => bindSceneCamera(report, { ...model, sha256: reserializedSha })),
      missingDigest: refusal(() => bindSceneCamera(missingDigest, model)),
      clip: refusal(() => camera.sample('unknown-animation', clock)),
      clock: refusal(() => camera.sample('idle', { ...clock, seconds: Number.NaN })),
      view: refusal(() => bindSceneCamera(report, { ...model, stage: { ...required(model.stage, 'stage'), width: 0 } })),
      mountRefusal,
    };
  } finally { assets.dispose(); }
}

async function reportByteBudget(modelUrl: string) {
  const cap = SCENE_CAMERA_REPORT_MAX_BYTES;
  const encoder = new TextEncoder();
  const prefix = encoder.encode('{"spec":"spine-parts-scene-report/1","note":"');
  const suffix = encoder.encode('"}');
  const multibyte = encoder.encode('é');
  const padEnd = cap - suffix.length;
  if (!Number.isSafeInteger(cap) || padEnd - prefix.length < multibyte.length) {
    throw new Error(`Unexpected scene camera report cap: ${cap}`);
  }
  // The cap-sized view is valid UTF-8 JSON. Its next byte is legal JSON whitespace.
  const bytes = new Uint8Array(cap + 1);
  bytes.set(prefix);
  let i = prefix.length;
  for (; i + multibyte.length <= padEnd; i += multibyte.length) bytes.set(multibyte, i);
  bytes.fill(0x20, i, padEnd);
  bytes.set(suffix, padEnd);
  bytes[cap] = 0x20;
  const exact = bytes.subarray(0, cap);
  const malformed = encoder.encode('{"spec":');
  const model = { sha256: '', stage: null, animations: [] };
  const direct = {
    atCap: bindSceneCamera(exact, model) === null,
    oversized: refusal(() => bindSceneCamera(bytes, model)),
    malformed: refusal(() => bindSceneCamera(malformed, model)),
  };

  const sceneReportUrl = new URL('budget.report.json', document.baseURI).href;
  const fetch = window.fetch;
  const chunkSize = Math.min(64 * 1024 - 1, Math.floor(cap / 2));
  async function mount(body: Uint8Array, contentLength?: number) {
    let delivered = 0;
    let chunks = 0;
    let pulledPastLimit = false;
    const requests: string[] = [];
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), document.baseURI);
      requests.push(url.pathname);
      if (url.href !== sceneReportUrl) return fetch.call(window, input, init);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (delivered === body.length) {
            if (delivered > cap) {
              pulledPastLimit = true;
              controller.error(new Error('Read past the first byte over the scene camera cap'));
            } else controller.close();
            return;
          }
          const end = delivered === cap ? cap + 1 : Math.min(delivered + chunkSize, cap, body.length);
          controller.enqueue(body.subarray(delivered, end));
          delivered = end;
          chunks++;
        },
        // Only a consumer read advances the fixture across the cutoff.
      }, { highWaterMark: 0 });
      const headers = new Headers({ 'content-type': 'application/json' });
      if (contentLength !== undefined) headers.set('content-length', String(contentLength));
      return Promise.resolve(new Response(stream, { headers }));
    };
    try {
      const take = await openTake({ modelUrl, sceneReportUrl, backend: 'canvas2d', animation: 'idle', loop: true });
      take.dispose();
      return { error: null, delivered, chunks, requests, pulledPastLimit };
    } catch (error) {
      return { error: refusal(() => { throw error; }), delivered, chunks, requests, pulledPastLimit };
    } finally { window.fetch = fetch; }
  }

  const atCap = await mount(exact, cap + 1);
  const oversized = await mount(bytes);
  // An invalid first token must still be subject to the observed-byte limit.
  bytes[0] = 0x21;
  const directOversizedMalformed = refusal(() => bindSceneCamera(bytes, model));
  const oversizedMalformed = await mount(bytes, malformed.length);
  const invalid = await mount(malformed);
  return {
    cap, direct: { ...direct, oversizedMalformed: directOversizedMalformed },
    reportPath: new URL(sceneReportUrl).pathname, atCap, oversized, oversizedMalformed, invalid,
  };
}

// Put the existing figure rig's posed geometry in the public example's world units.
// This is caller-supplied render geometry. The figure rig still poses its authored clip.
function fitFigure(pose: PosedFrame): PosedFrame {
  const clips = new Map<PosedClip, PosedClip>();
  const fit = (points: number[]) => points.map((value, i) => value / 5 + (i % 2 === 0 ? 12 : 0));
  return { order: pose.order.flatMap(slot => {
    if (!slot.clip) return [];
    const source = slot.clip;
    if (!clips.has(source)) clips.set(source, { ...source, polygon: fit(source.polygon) });
    const clip = clips.get(source)!;
    return [slot.kind === 'region'
      ? { ...slot, clip, corners: fit(slot.corners) }
      : { ...slot, clip, vertices: fit(slot.vertices) }];
  }) };
}

function clipPixels(cut: ImageData, full: ImageData, polygon: number[]) {
  const { width, height } = full;
  let removed = 0;
  let retained = 0;
  let leaked = 0;
  let missing = 0;
  // The authored window is an axis-aligned quad. Exclude a four-backing-pixel
  // rim from texel and edge AA comparisons.
  const xs = polygon.filter((_, i) => i % 2 === 0).map(x => x * width / output.width);
  const ys = polygon.filter((_, i) => i % 2 !== 0).map(y => y * height / output.height);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = 4 * (y * width + x) + 3;
      const wasOpaque = full.data[offset] >= 240;
      const shows = cut.data[offset] > 64;
      if (x < left - 4 || x > right + 4 || y < top - 4 || y > bottom + 4) {
        if (wasOpaque && !shows) removed++;
        if (shows) leaked++;
      } else if (x > left + 4 && x < right - 4 && y > top + 4 && y < bottom - 4 && wasOpaque) {
        if (shows) retained++;
        else missing++;
      }
    }
  }
  return { removed, retained, leaked, missing };
}

async function clipping(cameraSource: Source, figureUrl: string, backend: Backend, bounds: { view: number[]; zoom: number }) {
  const { report, model, assets } = await readBinding(cameraSource);
  const figureAssets = await loadModel({ modelUrl: figureUrl, regions: 'none', setsUrl: null });
  const player = new RigPlayer(document.createElement('div'), figureAssets, { mode: 'canvas' });
  const renderer = player.renderer as CanvasRenderer;
  renderer.backend = backend;
  try {
    player.play('window', { loop: true });
    const pose = fitFigure(player.posedFrame());
    if (!pose.order.some(slot => slot.kind === 'mesh') || !pose.order.some(slot => slot.kind === 'region')) {
      throw new Error('The clip must cover actual region and mesh slots');
    }
    const clip = pose.order[0].clip!;
    if (pose.order.some(slot => slot.clip !== clip)) throw new Error('The figure window must be shared');
    // Parts expresses view in stage pixels, Y-down, with this fixture's stage
    // origin at world (-64, 0). This oracle does not call the camera projection.
    const expected = (values: number[]) => values.map((value, i) => i % 2 === 0
      ? (value + 64 - bounds.view[0]) * bounds.zoom : (128 - value - bounds.view[1]) * bounds.zoom);
    const camera = required(bindSceneCamera(report, model), 'scene camera');
    const frame = required(camera.sample('idle', { basis: 'authored', seconds: 2 }), 'keyed sample');
    const backing = { width: 256, height: 192 };
    const callerViewport = { x: -31, y: 9, width: 41, height: 57 };
    const callerRatio = 1.75;
    renderer.viewport = callerViewport;
    renderer.pixelRatio = callerRatio;
    const restoration: { sameViewport: boolean; viewport: CanvasRenderer['viewport']; ratio: number }[] = [];
    const paint = (input: PosedFrame) => {
      const result = capture(renderer, () => renderSceneCameraFrame(renderer, input, frame, backing), output);
      restoration.push({ sameViewport: renderer.viewport === callerViewport,
        viewport: renderer.viewport, ratio: renderer.pixelRatio });
      return result;
    };
    const real = paint(pose);
    const unclipped = paint({ order: pose.order.map(({ clip: _clip, ...slot }) => slot) });
    // Move only the clip by 24 authored pixels relative to the posed figure.
    const moved = { ...clip, polygon: clip.polygon.map((value, i) => value + (i % 2 === 0 ? 24 : 0)) };
    const mutant = paint({ order: pose.order.map(slot => ({ ...slot, clip: moved })) });
    const polygon = expected(clip.polygon);
    return {
      draw: real.draw, renderPixel: await readback(real.image), expectedPolygon: polygon, restoration,
      expectedSlots: pose.order.map(slot => ({ name: slot.slot, points: expected(vertices(slot)) })),
      correct: clipPixels(real.image, unclipped.image, polygon),
      mutant: clipPixels(mutant.image, unclipped.image, polygon),
      mutantDiff: diff(real.image, mutant.image),
    };
  } finally { player.dispose(); figureAssets.dispose(); assets.dispose(); }
}

export const sceneCameraTest = { mounted, direct, legacy, refusals, clipping, reportByteBudget };
Object.assign(window, { sceneCameraTest });
export type SceneCameraWindow = typeof window & { sceneCameraTest: typeof sceneCameraTest };
export type { Clock, Draw, Point };
