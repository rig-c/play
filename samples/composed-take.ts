import {
  CanvasRenderer, RigPlayer, loadModel, type CanvasBackend, type CanvasViewport,
  type ModelAssets, type PosedClip, type PosedFrame, type PosedSlot,
} from '../src/index.js';
import type { ReadDocument } from '../src/loadModel.js';
import { cameraLimits, easeCamera, planeOffsets, pointerTarget, type CameraMode } from './parallax-compositor.js';

type Point = { readonly x: number; readonly y: number };
type Offsets = ReturnType<typeof planeOffsets>;
type Plane = keyof Offsets;
type Bindings = { background: readonly string[]; figure: readonly string[]; foreground?: readonly string[] };

export interface ComposedTakeOptions {
  modelUrl: string;
  animation: string;
  loop: true;
  slots: Bindings;
  camera?: CameraMode;
  /** Maximum camera excursion in CSS pixels, before per-plane gains. */
  maxDisplacement?: Point;
  backend?: CanvasBackend;
  /** Disable the frame clock when driving advance and render explicitly. */
  autoStart?: boolean;
}

type Refusal = 'COMPOSED_STAGE_REQUIRED' | 'COMPOSED_LOOP_REQUIRED' | 'COMPOSED_SLOT_PARTITION'
  | 'COMPOSED_CROSS_PLANE_CLIP' | 'COMPOSED_BACKDROP_COVERAGE' | 'COMPOSED_INVALID_DISPLACEMENT'
  | 'COMPOSED_INVALID_CAMERA';

export class ComposedTakeError extends Error {
  constructor(readonly code: Refusal, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, { cause });
  }
}

const NEUTRAL = { x: 0, y: 0 };
const PLANES = ['background', 'figure', 'foreground'] as const;

function checkMode(mode: CameraMode): void {
  if (mode !== 'fixed' && mode !== 'pan' && mode !== 'parallax') {
    throw new ComposedTakeError('COMPOSED_INVALID_CAMERA', `unknown camera mode ${String(mode)}`);
  }
}

function bindSlots(assets: ModelAssets, bindings: Bindings): Map<string, Plane> {
  // A player with no explicit skin resolves attachments from the default skin.
  // Count drawable attachment kinds even when the take hides a slot at t=0.
  const { doc } = assets.document as ReadDocument;
  const skin = doc.skins.find(skin => skin.name === 'default');
  const drawable = new Set(doc.slots.filter(({ name }) => {
    const entries = Object.values(skin?.attachments[name] ?? {});
    return entries.some(({ kind }) => kind === 'region' || kind === 'mesh' || kind === 'linkedmesh');
  }).map(slot => slot.name));
  const planes = new Map<string, Plane>();
  for (const plane of PLANES) {
    const slots = bindings?.[plane];
    if (plane === 'foreground' && slots === undefined) continue;
    if (!Array.isArray(slots) || (plane !== 'foreground' && slots.length === 0)) {
      throw new ComposedTakeError('COMPOSED_SLOT_PARTITION', `${plane} needs an explicit slot list`);
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

function checkFrame(frame: PosedFrame, planes: ReadonlyMap<string, Plane>): PosedSlot[] {
  const seen = new Set<string>();
  const clipPlanes = new Map<PosedClip, Plane>();
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
    if (plane === 'background') backdrop.push(slot);
  }
  return backdrop;
}

function transformFrame(
  frame: PosedFrame,
  shiftFor: (slot: PosedSlot) => Point,
  origin: Point = NEUTRAL,
  scale: Point = { x: 1, y: 1 },
): PosedFrame {
  const clips = new Map<PosedClip, PosedClip>();
  const native = origin.x === 0 && origin.y === 0 && scale.x === 1 && scale.y === 1;
  return { order: frame.order.map(slot => {
    const shift = shiftFor(slot);
    if (native && shift.x === 0 && shift.y === 0) return slot;
    const transform = (xy: number[]) => xy.map((value, i) => i % 2 === 0
      ? (value + shift.x - origin.x) * scale.x
      : (value - shift.y - origin.y) * scale.y);
    let clip = slot.clip;
    if (clip) {
      const transformed = clips.get(clip) ?? { ...clip, polygon: transform(clip.polygon) };
      clips.set(clip, transformed);
      clip = transformed;
    }
    return slot.kind === 'region'
      ? { ...slot, clip, corners: transform(slot.corners) }
      : { ...slot, clip, vertices: transform(slot.vertices) };
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

function requireStage(stage: ModelAssets['stage']): CanvasViewport {
  if (!stage || ![stage.x, stage.y, stage.width, stage.height, stage.x + stage.width, stageTop(stage)].every(Number.isFinite)
    || stage.x + stage.width <= stage.x || stageTop(stage) <= stage.y) {
    throw new ComposedTakeError('COMPOSED_STAGE_REQUIRED', 'the compiled model needs a positive stage with finite coordinates');
  }
  return stage;
}

function backdropGuard(renderer: CanvasRenderer, stage: CanvasViewport) {
  let lastNonOpaque: number | undefined;
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
    const edgeTolerance = (a: number, b: number) => Math.max(Math.abs(a), Math.abs(b), 1) * 2 ** -23;
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
    const width = Math.ceil(layout.width + 2 * x * layout.width / stage.width);
    const height = Math.ceil(layout.height + 2 * y * layout.height / stage.height);
    renderer.viewport = { x: 0, y: -height, width, height };
    const envelope = transformFrame({ order }, () => NEUTRAL, { x: bounds.left, y: bounds.top }, {
      x: width / (bounds.right - bounds.left), y: height / (bounds.top - bounds.bottom),
    });
    try {
      renderer.render(envelope);
      if (!renderer.framesReused || lastNonOpaque === undefined) {
        lastNonOpaque = undefined;
        const ctx = renderer.canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D readback is unavailable');
        const { data } = ctx.getImageData(0, 0, width, height);
        let count = 0;
        for (let i = 3; i < data.length; i += 4) count += Number(data[i] !== 255);
        lastNonOpaque = count;
      }
    } catch (error) {
      throw fail(`backdrop alpha cannot be read (${String(error)})`);
    }
    if (lastNonOpaque) throw fail(`${lastNonOpaque} envelope pixels have alpha below 255`);
  };
}

export async function mountComposedTake(root: HTMLElement, options: ComposedTakeOptions) {
  const initial = options.camera ?? 'fixed';
  checkMode(initial);
  if (options.loop !== true) throw new ComposedTakeError('COMPOSED_LOOP_REQUIRED', 'declare the existing take as loop: true');
  const override = options.maxDisplacement;
  if (override !== undefined && (!override || !Number.isFinite(override.x) || override.x < 0
    || !Number.isFinite(override.y) || override.y < 0)) {
    throw new ComposedTakeError('COMPOSED_INVALID_DISPLACEMENT', 'x and y must both be finite nonnegative CSS pixel excursions');
  }
  const explicit = override && { ...override };
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
    const planes = bindSlots(assets, options.slots);
    Object.assign(surface.style, {
      position: 'relative', overflow: 'hidden', width: '100%', height: '100%', aspectRatio: `${stage.width} / ${stage.height}`,
    });
    root.appendChild(surface);
    const poser = player = new RigPlayer(surface, assets, { mode: 'canvas' });
    const renderer = poser.renderer as CanvasRenderer;
    const coverage = audit = new CanvasRenderer(doc.createElement('div'), assets.pageImages);
    renderer.backend = coverage.backend = options.backend ?? 'webgl';
    coverage.pixelRatio = 1;
    const canvas = renderer.canvas;
    poser.play(take.name, { loop: true });

    let mode: CameraMode = initial;
    let offsets = planeOffsets(NEUTRAL, 'fixed');
    let camera = NEUTRAL;
    let target = NEUTRAL;
    let layout: Layout;
    let refusal: ComposedTakeError | null = null;
    let stopped = false;
    let disposed = false;
    let frameId: number | undefined;
    const window = doc.defaultView!;
    const requireCoverage = backdropGuard(coverage, stage);
    const origin = { x: stage.x, y: stageTop(stage) };

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
      layout = { cssWidth, cssHeight, width, height, dpr, native, excursion: explicit ?? cameraLimits(cssWidth, cssHeight) };
      renderer.viewport = native ? stage : { x: 0, y: -height, width, height };
      renderer.pixelRatio = native ? pixelRatio : 1;
    }

    function paint(frame: PosedFrame): void {
      const shifts = planeOffsets({ x: camera.x * layout.excursion.x, y: camera.y * layout.excursion.y }, mode);
      offsets = shifts;
      const shiftFor = (slot: PosedSlot) => {
        const { x, y } = shifts[planes.get(slot.slot)!];
        return { x: x * stage.width / layout.cssWidth, y: y * stage.height / layout.cssHeight };
      };
      if (layout.native) {
        renderer.render(PLANES.every(plane => shifts[plane].x === 0 && shifts[plane].y === 0)
          ? frame : transformFrame(frame, shiftFor));
      } else {
        // CanvasRenderer rounds world viewports outward. Project fractional
        // stage edges onto the exact integer backing rect before it draws.
        renderer.render(transformFrame(frame, shiftFor, origin, {
          x: layout.width / stage.width, y: layout.height / stage.height,
        }));
      }
      Object.assign(canvas.style, { width: '100%', height: '100%', transform: 'none', pointerEvents: 'auto' });
    }

    function currentFrame() {
      const frame = poser.posedFrame(null);
      return { frame, backdrop: checkFrame(frame, planes) };
    }

    function renderCurrent(): void {
      try {
        const { frame, backdrop } = currentFrame();
        try {
          requireCoverage(backdrop, layout, mode);
        } catch (error) {
          if (!(error instanceof ComposedTakeError) || error.code !== 'COMPOSED_BACKDROP_COVERAGE') throw error;
          // Relayout and animated backdrop changes can invalidate a mode
          // after selection. Draw fixed immediately and require a new opt-in.
          refusal = error;
          mode = 'fixed';
          camera = target = NEUTRAL;
        }
        paint(frame);
      } catch (error) {
        if (error instanceof ComposedTakeError) refusal = error;
        // Keep the last valid frame if the take changes to an invalid pose.
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
        const { frame, backdrop } = currentFrame();
        requireCoverage(backdrop, layout, next);
        mode = next;
        if (mode === 'fixed') camera = target = NEUTRAL;
        refusal = null;
        paint(frame);
      } catch (error) {
        if (error instanceof ComposedTakeError) refusal = error;
        throw error;
      }
    }

    function advance(rigElapsed: number, cameraElapsed = rigElapsed): void {
      if (disposed || stopped) return;
      poser.advance(rigElapsed);
      if (cameraElapsed > 0) camera = easeCamera(camera, target, cameraElapsed);
    }

    function render(): void {
      if (disposed || stopped) return;
      measure();
      renderCurrent();
    }

    setCamera(initial);
    const aim = (event: PointerEvent) => {
      if (!event.isPrimary || stopped) return;
      const box = surface.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) target = pointerTarget(event.clientX, event.clientY, box);
    };
    const recenter = (event: PointerEvent) => { if (event.isPrimary) target = NEUTRAL; };
    root.addEventListener('pointermove', aim, true);
    root.addEventListener('pointerleave', recenter, true);
    root.addEventListener('pointercancel', recenter, true);
    const observer = new ResizeObserver(() => {
      try { render(); } catch (error) { if (!(error instanceof ComposedTakeError)) throw error; }
    });
    observer.observe(surface);

    if (options.autoStart !== false) {
      let last = window.performance.now();
      frameId = window.requestAnimationFrame(function tick(now) {
        if (disposed || stopped) return;
        const elapsed = Math.max(0, (now - last) / 1000);
        last = now;
        advance(Math.min(elapsed, 1 / 15), elapsed);
        if (layout.dpr !== window.devicePixelRatio) measure();
        try { renderCurrent(); } catch (error) { if (!(error instanceof ComposedTakeError)) throw error; }
        if (!stopped) frameId = window.requestAnimationFrame(tick);
      });
    }

    return {
      canvas, player: poser,
      get mode() { return mode; },
      get offsets() { return offsets; },
      get cameraExcursion() { return layout.excursion; },
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
