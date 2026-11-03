import { CanvasRenderer, type CanvasViewport } from '../src/CanvasRenderer';
import { DomRenderer } from '../src/DomRenderer';
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
 * blitting through the canvas's size rather than the buffer's then copies the
 * wrong texels into the part canvases: axis-aligned rectangles of another
 * part's texture, and cloth cut along straight edges.
 *
 * Two comparisons, both exact, both against a draw that cannot share the
 * defect:
 *
 * - **zoomed**: one mesh (the canvas mode: the frame, on a square stage box)
 *   drawn with its long side at `ZOOMED_LONG_SIDE` device px — inside the blitter's 8192 px axis limit, so the GL path is attempted,
 *   and over the area such an engine grants — against the same frame at the
 *   same ratio on a renderer forced onto canvas2d. When the GL path declines
 *   the batch (the buffer it was granted cannot hold it) the renderer draws it
 *   on canvas2d, so the pixels are those of the forced renderer exactly. When
 *   the GL path draws it, that is only correct if the browser granted the
 *   buffer it needed, which the probe measures on a throwaway context.
 * - **after**: the full frame at ratio 1 on a fresh renderer, drawn after the
 *   zoom, against the same frame at ratio 1 drawn before it. A zoom the
 *   browser refused must leave the buffer as it was, so the two draws are the
 *   same draw — 0 pixels. A zoom the browser granted grows the buffer, and a
 *   rect's window position moves with the buffer's height (rects are placed
 *   from its top edge); some rasterizers are not invariant under that move
 *   (headless WebKit on macOS: 582 px, up to 42 levels, measured), so the
 *   granted case is reported, not held to 0 — it is not the defect here.
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
  /** Pixels that differ from the canvas2d renderer's draw of the same frame and ratio. */
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
  const assets = await loadRig(RIG);
  const frame = frameAt(assets, POSE.animation, POSE.time);
  const roots: HTMLElement[] = [];
  const disposers: Array<() => void> = [];
  const root = (): HTMLElement => {
    const r = makeRoot();
    roots.push(r);
    return r;
  };

  type Draw = (r: HTMLElement, ratio: number, f: PosedFrame, forced2d?: boolean, box?: CanvasViewport) => string;
  const draw: Draw =
    mode === 'dom'
      ? (r, ratio, f, forced2d = false) => {
          const renderer = new DomRenderer(r, assets.regionImages, assets.pageImages);
          disposers.push(() => renderer.dispose());
          if (forced2d) renderer.meshBackend = 'canvas2d';
          renderer.pixelRatio = ratio;
          renderer.render(f);
          return renderer.meshBackendActive;
        }
      : (r, ratio, f, forced2d = false, box) => {
          const renderer = new CanvasRenderer(r, assets.pageImages);
          disposers.push(() => renderer.dispose());
          if (forced2d) renderer.backend = 'canvas2d';
          if (box) renderer.viewport = box;
          renderer.pixelRatio = ratio;
          renderer.render(f);
          return renderer.backendActive;
        };

  // The DOM mode zooms one mesh, so the batch is that mesh alone; the canvas
  // mode draws the whole frame as one job.
  const zoomFrame: PosedFrame =
    mode === 'dom' ? { order: frame.order.filter((slot) => slot.kind === 'mesh' && slot.slot === ZOOM_SLOT) } : frame;
  if (zoomFrame.order.length === 0) throw new Error(`zoomBufferProbe: ${RIG} has no mesh ${ZOOM_SLOT}`);

  // Before: the full frame at ratio 1, on a blitter that has never grown.
  const before = root();
  draw(before, 1, frame);
  const referenceInk = ink(before);

  // The zoom.
  const box = mode === 'canvas' ? squareBox(zoomFrame) : undefined;
  const size = box ?? extent(zoomFrame);
  const ratio = ZOOMED_LONG_SIDE / Math.max(size.width, size.height);
  const zoomed = root();
  const backend = draw(zoomed, ratio, zoomFrame, false, box);
  const forced = root();
  draw(forced, ratio, zoomFrame, true, box);
  const zoomedCompare = diffRoots(zoomed, forced);
  // The rect the blitter is asked for: the DOM mode's mesh raster (its canvas
  // carries 25% slack beyond it), the canvas mode's whole backing.
  const largest =
    mode === 'dom'
      ? { width: Math.ceil(size.width * ratio), height: Math.ceil(size.height * ratio) }
      : { width: canvasesOf(zoomed)[0].width, height: canvasesOf(zoomed)[0].height };
  const want = { width: largest.width + GUTTER * 2, height: largest.height + GUTTER * 2 };
  // Give the zoomed canvases' memory back before anything else is drawn:
  // two of them hold over 200 MB, and the next draws do not need them.
  for (const canvas of [...canvasesOf(zoomed), ...canvasesOf(forced)]) {
    canvas.width = 0;
    canvas.height = 0;
  }
  const got = grantedBuffer(want.width, want.height);

  // After: the same ratio-1 frame on a fresh renderer, so every part is rastered again.
  const after = root();
  draw(after, 1, frame);
  const afterCompare = diffRoots(before, after);

  const result: ZoomBufferCase = {
    backend,
    width: largest.width,
    height: largest.height,
    granted: got.width >= want.width && got.height >= want.height,
    grantedWidth: got.width,
    grantedHeight: got.height,
    zoomedDiff: zoomedCompare.diff,
    zoomedPixels: zoomedCompare.pixels,
    zoomedMaxDelta: zoomedCompare.maxDelta,
    afterDiff: afterCompare.diff,
    afterPixels: afterCompare.pixels,
    afterCanvases: afterCompare.canvases,
    afterMaxDelta: afterCompare.maxDelta,
    referenceInk,
  };
  for (const dispose of disposers) dispose();
  for (const r of roots) r.remove();
  assets.dispose();
  return result;
}
