import { CanvasRenderer, type CanvasViewport } from '../src/CanvasRenderer';
import { DomRenderer } from '../src/DomRenderer';
import { getMeshGlBlitter } from '../src/MeshGlBlitter';
import type { PosedFrame } from '../src/posedFrame';
import { frameAt, loadRig } from './rigFrames';

/**
 * A zoomed-in stage asks the shared WebGL buffer for more pixels than the
 * browser will give it (#332 in rig-c/review).
 *
 * The mesh tier and the canvas mode draw through one offscreen WebGL canvas
 * that grows with the jobs it packs (MeshGlBlitter). A zoom raises the pixel
 * ratio, the jobs grow with it, and the buffer is asked for a size the browser
 * may not grant: the WebGL spec lets it hand back a smaller drawing buffer
 * than the canvas's width × height, and Chromium does — 5760 × 5760 for an
 * 8192 × 8192 request, an area cap, measured on the CI engine. Drawing and
 * blitting through the canvas's size rather than the buffer's copied the
 * wrong texels into the part canvases: axis-aligned rectangles of another
 * part's texture, and cloth cut along straight edges. #241 then declined such
 * a batch to canvas2d, whose seams show at screen scale; since #245 the
 * blitter keeps it on WebGL, in passes and tiles through the buffer it was
 * granted.
 *
 * Two comparisons, each exact where it is held:
 *
 * - **zoomed**: one mesh (the canvas mode: the frame, on a square stage box)
 *   drawn with its long side at `ZOOMED_LONG_SIDE` device px — past the area
 *   such an engine grants — must stay on WebGL, through a buffer granted in
 *   full, and must be the same pixels as the same frame drawn under a
 *   test-only cap a quarter of that buffer's area, which tiles it
 *   differently. A wrong texel depends on where its tile sat in which buffer,
 *   so two tilings cannot share one; that a tiling is the single-pass draw is
 *   `capIdentityProbe`'s claim, at a size every engine grants.
 * - **after**: the full frame at ratio 1 on a fresh renderer, drawn after the
 *   zoom, against the same frame at ratio 1 drawn before it: 0 pixels. The
 *   zoom grows the buffer, which moves every rect's window position (rects
 *   are placed from its top edge). Since #245 the blitter places every rect
 *   on a 32 px phase of the window, which is what headless WebKit on macOS
 *   needs to draw a mesh job the same after such a move (582 differing pixels
 *   here before). Both comparisons are held at 0 on Chromium; WebKit differs
 *   in both, by host and mode, and the spec reports it there rather than
 *   holding it (`identityHeld` in tests/zoom-buffer.spec.ts).
 */

const RIG = 'figure-packed';
const POSE = { animation: 'walk', time: 1.2 } as const;
/** The mesh the zoom is applied to: the rig's largest. */
const ZOOM_SLOT = 'cape';
/**
 * Device px on the zoomed drawing's long side: past a 5760² area cap once the
 * blitter quantizes the request (the cape: 5120 × 7168, 36.7 M px), and no
 * larger, because every pixel of it is rastered twice and read back on a
 * software rasterizer in CI.
 */
const ZOOMED_LONG_SIDE = 6900;
/** Rows read back per getImageData call, so a large canvas is never read whole. */
const STRIP_ROWS = 512;

export interface ZoomBufferCase {
  /** The backend the renderer under test reported for the zoomed frame. */
  backend: string;
  /** Device px of the zoomed drawing: the mesh's raster rect, or the frame canvas. */
  width: number;
  height: number;
  /** Whether a throwaway WebGL canvas of that size plus the blitter's gutter got a drawing buffer that large. */
  granted: boolean;
  /** The drawing buffer that throwaway canvas got. */
  grantedWidth: number;
  grantedHeight: number;
  /** The blitter's buffer after the zoomed draw, and whether its drawing buffer is all of it. */
  bufferWidth: number;
  bufferHeight: number;
  bufferGranted: boolean;
  /** The zoomed draw's passes, pieces and tiled jobs. */
  passes: number;
  pieces: number;
  tiledJobs: number;
  /** The same frame under the test cap: its backend, cap, passes, pieces and tiled jobs. */
  cappedBackend: string;
  cappedArea: number;
  cappedPasses: number;
  cappedPieces: number;
  cappedTiledJobs: number;
  /** Pixels that differ between the two zoomed draws. */
  zoomedDiff: number;
  /** Pixels compared there, and the largest per-channel difference among them. */
  zoomedPixels: number;
  zoomedMaxDelta: number;
  /** Pixels of the ratio-1 frame after the zoom that differ from the same frame before it. */
  afterDiff: number;
  /** Pixels compared there, and canvases. */
  afterPixels: number;
  afterCanvases: number;
  afterMaxDelta: number;
  /** Non-transparent pixels of the ratio-1 reference: the comparison is not of empty canvases. */
  referenceInk: number;
}

function canvasesOf(root: HTMLElement): HTMLCanvasElement[] {
  return [...root.querySelectorAll('canvas')];
}

/** Differing pixels between two canvases of one size; a size mismatch differs everywhere. */
function diffCanvases(a: HTMLCanvasElement, b: HTMLCanvasElement): Diff {
  const pixels = Math.max(a.width * a.height, b.width * b.height);
  if (a.width !== b.width || a.height !== b.height) return { diff: pixels, pixels, maxDelta: 255 };
  const ca = a.getContext('2d');
  const cb = b.getContext('2d');
  if (!ca || !cb) return { diff: pixels, pixels, maxDelta: 255 };
  let diff = 0;
  let maxDelta = 0;
  for (let y = 0; y < a.height; y += STRIP_ROWS) {
    const rows = Math.min(STRIP_ROWS, a.height - y);
    const da = ca.getImageData(0, y, a.width, rows).data;
    const db = cb.getImageData(0, y, b.width, rows).data;
    for (let i = 0; i < da.length; i += 4) {
      let delta = 0;
      for (let k = 0; k < 4; k++) delta = Math.max(delta, Math.abs(da[i + k] - db[i + k]));
      if (delta > 0) diff++;
      if (delta > maxDelta) maxDelta = delta;
    }
  }
  return { diff, pixels, maxDelta };
}

interface Diff {
  diff: number;
  pixels: number;
  /** Largest per-channel difference over the compared pixels, 0–255. */
  maxDelta: number;
}

function diffRoots(a: HTMLElement, b: HTMLElement): Diff & { canvases: number } {
  const ca = canvasesOf(a);
  const cb = canvasesOf(b);
  let diff = 0;
  let pixels = 0;
  let maxDelta = 0;
  if (ca.length !== cb.length) return { diff: Number.POSITIVE_INFINITY, pixels: 0, maxDelta: 255, canvases: 0 };
  for (let i = 0; i < ca.length; i++) {
    const d = diffCanvases(ca[i], cb[i]);
    diff += d.diff;
    pixels += d.pixels;
    maxDelta = Math.max(maxDelta, d.maxDelta);
  }
  return { diff, pixels, maxDelta, canvases: ca.length };
}

function ink(root: HTMLElement): number {
  let count = 0;
  for (const canvas of canvasesOf(root)) {
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) continue;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) count++;
  }
  return count;
}

/** What a WebGL canvas of this size is actually given, read off a throwaway context. */
function grantedBuffer(width: number, height: number): { width: number; height: number } {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl');
  if (!gl) return { width: 0, height: 0 };
  canvas.width = width;
  canvas.height = height;
  const granted = { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return granted;
}

/**
 * The frame's slots' bounding box in root units (Y down), widened the way the
 * DOM mode sizes a mesh's raster: whole units, one unit of pad on each side.
 * Times the ratio, rounded up, it is that raster's size in device px — the
 * rect the shared buffer is asked to hold.
 */
function extent(frame: PosedFrame): { width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const slot of frame.order) {
    const v = slot.kind === 'region' ? slot.corners : slot.vertices;
    for (let k = 0; k + 1 < v.length; k += 2) {
      minX = Math.min(minX, v[k]);
      maxX = Math.max(maxX, v[k]);
      minY = Math.min(minY, -v[k + 1]);
      maxY = Math.max(maxY, -v[k + 1]);
    }
  }
  return { width: Math.ceil(maxX) - Math.floor(minX) + 2, height: Math.ceil(maxY) - Math.floor(minY) + 2 };
}

/**
 * A square world box (Y up) round the frame, for the canvas mode's zoomed
 * draw: the frame's own cover is tall and narrow, so at the blitter's 8192 px
 * axis limit it never asks for more than an area cap of 5760² would grant.
 * Pinning the canvas to a square stage box is what a zoomed-in stage does.
 */
function squareBox(frame: PosedFrame): CanvasViewport {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const slot of frame.order) {
    const v = slot.kind === 'region' ? slot.corners : slot.vertices;
    for (let k = 0; k + 1 < v.length; k += 2) {
      minX = Math.min(minX, v[k]);
      maxX = Math.max(maxX, v[k]);
      minY = Math.min(minY, v[k + 1]);
      maxY = Math.max(maxY, v[k + 1]);
    }
  }
  const side = Math.ceil(Math.max(maxX - minX, maxY - minY));
  return { x: Math.floor((minX + maxX - side) / 2), y: Math.floor((minY + maxY - side) / 2), width: side, height: side };
}

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  document.body.appendChild(root);
  return root;
}

/** The blitter packs a rect with a 1 px gutter on each side. */
const GUTTER = 1;

export async function zoomBufferProbe(mode: 'dom' | 'canvas'): Promise<ZoomBufferCase> {
  const gpu = getMeshGlBlitter();
  if (!gpu) throw new Error('zoomBufferProbe: WebGL unavailable');
  const blitter = gpu as unknown as { canvas: HTMLCanvasElement; gl: WebGLRenderingContext };
  const assets = await loadRig(RIG);
  const frame = frameAt(assets, POSE.animation, POSE.time);
  const roots: HTMLElement[] = [];
  const disposers: Array<() => void> = [];
  const root = (): HTMLElement => {
    const r = makeRoot();
    roots.push(r);
    return r;
  };

  type Draw = (r: HTMLElement, ratio: number, f: PosedFrame, box?: CanvasViewport) => string;
  const draw: Draw =
    mode === 'dom'
      ? (r, ratio, f) => {
          const renderer = new DomRenderer(r, assets.regionImages, assets.pageImages);
          disposers.push(() => renderer.dispose());
          renderer.pixelRatio = ratio;
          renderer.render(f);
          return renderer.meshBackendActive;
        }
      : (r, ratio, f, box) => {
          const renderer = new CanvasRenderer(r, assets.pageImages);
          disposers.push(() => renderer.dispose());
          if (box) renderer.viewport = box;
          renderer.pixelRatio = ratio;
          renderer.render(f);
          return renderer.backendActive;
        };

  try {
    // The DOM mode zooms one mesh, so the batch is that mesh alone; the canvas
    // mode draws the whole frame as one job.
    const zoomFrame: PosedFrame =
      mode === 'dom' ? { order: frame.order.filter((slot) => slot.kind === 'mesh' && slot.slot === ZOOM_SLOT) } : frame;
    if (zoomFrame.order.length === 0) throw new Error(`zoomBufferProbe: ${RIG} has no mesh ${ZOOM_SLOT}`);

    // Before: the full frame at ratio 1.
    const before = root();
    draw(before, 1, frame);
    const referenceInk = ink(before);

    // The zoom, through what this engine grants.
    const box = mode === 'canvas' ? squareBox(zoomFrame) : undefined;
    const size = box ?? extent(zoomFrame);
    const ratio = ZOOMED_LONG_SIDE / Math.max(size.width, size.height);
    const zoomed = root();
    const backend = draw(zoomed, ratio, zoomFrame, box);
    const stats = { ...gpu.stats };
    const buffer = {
      width: blitter.canvas.width,
      height: blitter.canvas.height,
      granted: blitter.gl.drawingBufferWidth === blitter.canvas.width && blitter.gl.drawingBufferHeight === blitter.canvas.height,
    };

    // The same zoom under a cap a quarter of that buffer's area: another tiling.
    const cappedArea = Math.floor((buffer.width * buffer.height) / 4);
    const capped = root();
    gpu.limitForTesting({ area: cappedArea });
    let cappedBackend: string;
    let cappedStats: typeof stats;
    try {
      cappedBackend = draw(capped, ratio, zoomFrame, box);
      cappedStats = { ...gpu.stats };
    } finally {
      gpu.limitForTesting(null);
    }
    const zoomedCompare = diffRoots(zoomed, capped);
    // The rect the blitter is asked for: the DOM mode's mesh raster (its canvas
    // carries 25% slack beyond it), the canvas mode's whole backing.
    const largest =
      mode === 'dom'
        ? { width: Math.ceil(size.width * ratio), height: Math.ceil(size.height * ratio) }
        : { width: canvasesOf(zoomed)[0].width, height: canvasesOf(zoomed)[0].height };
    const want = { width: largest.width + GUTTER * 2, height: largest.height + GUTTER * 2 };
    // Give the zoomed canvases' memory back before anything else is drawn:
    // two of them hold over 200 MB, and the next draws do not need them.
    for (const canvas of [...canvasesOf(zoomed), ...canvasesOf(capped)]) {
      canvas.width = 0;
      canvas.height = 0;
    }
    const got = grantedBuffer(want.width, want.height);

    // After: the same ratio-1 frame on a fresh renderer, so every part is rastered again.
    const after = root();
    draw(after, 1, frame);
    const afterCompare = diffRoots(before, after);

    return {
      backend,
      width: largest.width,
      height: largest.height,
      granted: got.width >= want.width && got.height >= want.height,
      grantedWidth: got.width,
      grantedHeight: got.height,
      bufferWidth: buffer.width,
      bufferHeight: buffer.height,
      bufferGranted: buffer.granted,
      passes: stats.passes,
      pieces: stats.pieces,
      tiledJobs: stats.tiledJobs,
      cappedBackend,
      cappedArea,
      cappedPasses: cappedStats.passes,
      cappedPieces: cappedStats.pieces,
      cappedTiledJobs: cappedStats.tiledJobs,
      zoomedDiff: zoomedCompare.diff,
      zoomedPixels: zoomedCompare.pixels,
      zoomedMaxDelta: zoomedCompare.maxDelta,
      afterDiff: afterCompare.diff,
      afterPixels: afterCompare.pixels,
      afterCanvases: afterCompare.canvases,
      afterMaxDelta: afterCompare.maxDelta,
      referenceInk,
    };
  } finally {
    for (const dispose of disposers) dispose();
    for (const r of roots) r.remove();
    assets.dispose();
  }
}

/**
 * Past the grant, the blitter draws in passes and tiles instead of falling to
 * canvas2d (#245) — and a pixel must not depend on either (#187's rule: each
 * job is rastered in its own rect). This draws the same frames twice, on two
 * renderers of one kind: once with the blitter's real limits, which hold every
 * frame in one pass, and once under a test-only cap on the granted buffer
 * (`limitForTesting`) far below the fixture's size. The capped renderer must
 * stay on WebGL on every frame and its canvases must be the uncapped ones,
 * exactly.
 *
 * The caps are derived from a dry run's jobs, never written as numbers:
 *
 * - **passes**: the buffer's width and height just hold the largest job with
 *   its gutter (on the blitter's 32 px placement grid), so every job fits
 *   whole and the batch cannot fit one buffer.
 * - **tile**: the buffer's area is that of a square half the largest job's
 *   long side, so that job is tiled; the blitter finds the buffer itself, as
 *   it does under a browser's area cap. The batch is that job alone (the DOM
 *   mode), or the whole frame, which the canvas mode draws as one job.
 * - **mixed**: the DOM mode's whole frame in a buffer that just holds the
 *   second-largest job (on the same grid) and not the largest, so a tiled job
 *   and a whole one share the passes.
 *
 * `plant: 'no-tiling'` is the planted control: the blitter declines a job
 * larger than the buffer instead of tiling it, which is what it did before
 * #245, so the checks must fail by name.
 */
export type CapCase = 'passes' | 'tile' | 'mixed';

export interface CapCheck {
  name: string;
  pass: boolean;
  detail: string;
}

interface Size {
  width: number;
  height: number;
}

export interface CapIdentityResult {
  mode: 'dom' | 'canvas';
  cap: CapCase;
  plant: 'none' | 'no-tiling';
  /** The cap applied to the capped renderer's buffer. */
  limits: { area?: number; width?: number; height?: number };
  /** The largest job of the dry run, and the largest smaller than it, device px. */
  largest: Size;
  second: Size;
  /** Per frame: the capped draw's backend, jobs, passes, pieces and tiled jobs, the reference's passes, and the comparison. */
  perFrame: {
    time: number;
    backend: string;
    jobs: number;
    passes: number;
    pieces: number;
    tiledJobs: number;
    referencePasses: number;
    diff: number;
    pixels: number;
    maxDelta: number;
  }[];
  checks: CapCheck[];
}

const CAP_TIMES = [0, 0.3, 0.6, 0.9, 1.2];
/** A fractional ratio, so that the vertices sit off the pixel grid. */
const CAP_RATIO = 1.75;
const GUTTERS = 2;
/** The blitter's placement grid (ALIGN in MeshGlBlitter.ts): a side cap below it is floored to it. */
const GRID = 32;

const longOf = (s: Size): number => Math.max(s.width, s.height);

export async function capIdentityProbe(mode: 'dom' | 'canvas', cap: CapCase, plant: 'none' | 'no-tiling' = 'none'): Promise<CapIdentityResult> {
  const gpu = getMeshGlBlitter();
  if (!gpu) throw new Error('capIdentityProbe: WebGL unavailable');
  if (mode === 'canvas' && cap !== 'tile') throw new Error(`capIdentityProbe: the canvas mode draws one job; no ${cap} case`);
  const assets = await loadRig(RIG);
  const roots: HTMLElement[] = [];
  const disposers: Array<() => void> = [];
  const originalFlush = gpu.flush;
  const originalFlushFrame = gpu.flushFrame;
  try {
    const frames = CAP_TIMES.map((time) => frameAt(assets, POSE.animation, time));
    const select = (f: PosedFrame): PosedFrame =>
      mode === 'dom' && cap === 'tile' ? { order: f.order.filter((slot) => slot.kind === 'mesh' && slot.slot === ZOOM_SLOT) } : f;

    const make = () => {
      const r = makeRoot();
      roots.push(r);
      if (mode === 'dom') {
        const renderer = new DomRenderer(r, assets.regionImages, assets.pageImages);
        disposers.push(() => renderer.dispose());
        renderer.pixelRatio = CAP_RATIO;
        return { root: r, draw: (f: PosedFrame) => (renderer.render(f), renderer.meshBackendActive as string) };
      }
      const renderer = new CanvasRenderer(r, assets.pageImages);
      disposers.push(() => renderer.dispose());
      renderer.pixelRatio = CAP_RATIO;
      // One stage box, so the canvas is one size on every frame.
      renderer.viewport = squareBox(frames[frames.length - 1]);
      return { root: r, draw: (f: PosedFrame) => (renderer.render(f), renderer.backendActive as string) };
    };

    // A dry run on a throwaway renderer measures the jobs the caps are derived from.
    const sizes: Size[] = [];
    gpu.flush = function (jobs) {
      for (const job of jobs) sizes.push({ width: job.width, height: job.height });
      return originalFlush.call(this, jobs);
    };
    gpu.flushFrame = function (job) {
      sizes.push({ width: job.width, height: job.height });
      return originalFlushFrame.call(this, job);
    };
    gpu.limitForTesting(null);
    const dry = make();
    for (const f of frames) dry.draw(select(f));
    gpu.flush = originalFlush;
    gpu.flushFrame = originalFlushFrame;

    const empty: Size = { width: 0, height: 0 };
    const largest = sizes.reduce((a, b) => (longOf(b) > longOf(a) ? b : a), empty);
    const long = longOf(largest);
    const second = sizes.filter((s) => longOf(s) < long).reduce((a, b) => (longOf(b) > longOf(a) ? b : a), empty);
    const grid = (v: number) => Math.ceil(v / GRID) * GRID;
    const limits: CapIdentityResult['limits'] =
      cap === 'passes'
        ? { width: grid(largest.width + GUTTERS), height: grid(largest.height + GUTTERS) }
        : cap === 'tile'
          ? { area: (Math.ceil(long / 2) + GUTTERS) ** 2 }
          : { width: grid(second.width + GUTTERS), height: grid(second.height + GUTTERS) };

    const reference = make();
    const capped = make();
    const perFrame: CapIdentityResult['perFrame'] = [];
    for (let i = 0; i < frames.length; i++) {
      const f = select(frames[i]);
      gpu.limitForTesting(null);
      gpu.stats = { jobs: 0, passes: 0, pieces: 0, tiledJobs: 0 };
      reference.draw(f);
      const referencePasses = gpu.stats.passes;
      gpu.limitForTesting({ ...limits, tiling: plant !== 'no-tiling' });
      gpu.stats = { jobs: 0, passes: 0, pieces: 0, tiledJobs: 0 };
      const backend = capped.draw(f);
      const stats = { ...gpu.stats };
      gpu.limitForTesting(null);
      const d = diffRoots(reference.root, capped.root);
      perFrame.push({ time: CAP_TIMES[i], backend, ...stats, referencePasses, diff: d.diff, pixels: d.pixels, maxDelta: d.maxDelta });
    }

    const checks: CapCheck[] = [];
    const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
    const first = perFrame[0];
    check('reference: one pass on every frame that drew', perFrame.every((p) => p.referencePasses <= 1), perFrame.map((p) => p.referencePasses).join(','));
    check(
      'cap: below what the uncapped draw used',
      (limits.area ?? Infinity) < (largest.width + GUTTERS) * (largest.height + GUTTERS) || (limits.width ?? Infinity) < 512 || (limits.height ?? Infinity) < largest.height + GUTTERS,
      JSON.stringify({ limits, largest, second }),
    );
    check('webgl on every frame', perFrame.every((p) => p.backend === 'webgl'), perFrame.map((p) => p.backend).join(','));
    if (cap === 'passes') {
      check('passes: the first frame is drawn in several passes', first.passes > 1, `passes ${first.passes}`);
      check('passes: no job is tiled', perFrame.every((p) => p.tiledJobs === 0), perFrame.map((p) => p.tiledJobs).join(','));
    } else {
      check(`${cap}: the first frame tiles a job`, first.tiledJobs >= 1 && first.pieces >= 4, `tiled ${first.tiledJobs}, pieces ${first.pieces}, passes ${first.passes}`);
    }
    if (cap === 'mixed') {
      check('mixed: tiles and whole jobs share the passes', second.width > 0 && first.tiledJobs < first.jobs && first.passes > 1, `jobs ${first.jobs}, tiled ${first.tiledJobs}, passes ${first.passes}`);
    }
    check('identical: part canvases', perFrame.every((p) => p.diff === 0 && p.pixels > 0), perFrame.map((p) => `${p.diff}/${p.pixels}`).join(','));
    return { mode, cap, plant, limits, largest, second, perFrame, checks };
  } finally {
    gpu.flush = originalFlush;
    gpu.flushFrame = originalFlushFrame;
    gpu.limitForTesting(null);
    for (const dispose of disposers) dispose();
    for (const r of roots) r.remove();
    assets.dispose();
  }
}
