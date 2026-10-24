import { CanvasRenderer } from '../src/CanvasRenderer';
import { DomRenderer } from '../src/DomRenderer';
import { getMeshGlBlitter, type MeshBlitJob } from '../src/MeshGlBlitter';
import type { PosedFrame } from '../src/posedFrame';
import { frameAt, loadRig } from './rigFrames';

// Derived before the #187 measurements from glow's boundary vertex29:
// localY=181.65724182128906; (181.65625 ± 1/65536) / localY.
export const BATCH_CONTEXT_RATIOS = [0.9999944561523227, 0.9999946241477069] as const;

type BlitterProbe = {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  packX: number[];
  packY: number[];
};
type Draw = { pixels: Uint8ClampedArray; drawn: number; reused: number; visible: string[] };

function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (!a.length || a.length !== b.length || a.length % 4) throw new Error('RGBA shape/empty');
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) count++;
  }
  return count;
}

/** Loader/pose preflight without rendering, also used for staged remote runs. */
export async function batchContextInputProbe() {
  const assets = await loadRig('batch-context');
  let reference: Awaited<ReturnType<typeof loadRig>> | undefined;
  try {
    reference = await loadRig('glow');
    const frame = frameAt(assets, 'burn', 0.35);
    const common = frame.order.find((slot) => slot.slot === 'core');
    const pads = frame.order.filter((slot) => slot.slot === 'pad_a' || slot.slot === 'pad_b');
    if (common?.kind !== 'mesh' || pads.length !== 2 || pads.some((slot) => slot.kind !== 'mesh') || common.clip) throw new Error('batch-context source meshes required');
    const page = assets.pageImages.get(common.page);
    if (!page) throw new Error('common page missing');
    const original = frameAt(reference, 'burn', 0.35).order.find((slot) => slot.slot === 'core');
    if (original?.kind !== 'mesh') throw new Error('reference core missing');
    const sourceFields = (mesh: typeof common) => JSON.stringify([mesh.vertices, mesh.uvs, mesh.triangles, mesh.page, mesh.pma, mesh.tint, mesh.blend, mesh.clip]);
    const referenceCommonEqual = sourceFields(common) === sourceFields(original);
    if (!referenceCommonEqual) throw new Error('fixture changed the source-derived common mesh');
    return { referenceCommonEqual, sourceSlots: frame.order.map((slot) => slot.slot), common: common.slot, surrounding: pads.map((slot) => slot.slot), vertices: common.vertices.length / 2, triangles: common.triangles.length / 3, page: [page.width, page.height] };
  } finally {
    reference?.dispose();
    assets.dispose();
  }
}

/** Only selects real frameOf slots from the rigc-built packing fixture. */
export async function batchContextProbe(ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('positive finite pixelRatio required');
  const gpu = getMeshGlBlitter();
  if (!gpu) return { webglAvailable: false as const };
  const probe = gpu as unknown as BlitterProbe;
  const gl = probe.gl;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) as string;
  const assets = await loadRig('batch-context');
  const roots: HTMLElement[] = [];
  const renderers: (DomRenderer | CanvasRenderer)[] = [];
  const originalFlush = gpu.flush;
  const packs: { common: number[]; target: number[] }[] = [];
  const commonCanvases = new Set<HTMLCanvasElement>();
  try {
    const frame = frameAt(assets, 'burn', 0.35);
    const common = frame.order.find((slot) => slot.slot === 'core');
    const pads = frame.order.filter((slot) => slot.slot === 'pad_a' || slot.slot === 'pad_b');
    if (common?.kind !== 'mesh' || pads.length !== 2 || pads.some((slot) => slot.kind !== 'mesh') || common.clip) throw new Error('batch-context source meshes required');
    const sourceBefore = JSON.stringify(common);
    const alone: PosedFrame = { order: [common] };
    const crowded: PosedFrame = { order: frame.order.filter((slot) => slot === common || pads.includes(slot)) };
    const root = () => {
      const element = document.body.appendChild(document.createElement('div'));
      roots.push(element);
      return element;
    };
    const make = () => {
      const element = root();
      const dom = new DomRenderer(element, assets.regionImages, assets.pageImages);
      dom.pixelRatio = ratio;
      dom.meshBackend = 'webgl';
      renderers.push(dom);
      return { element, dom };
    };
    const draw = (view: ReturnType<typeof make>, posed: PosedFrame): Draw => {
      // The canvas is created on the first render; the source slot order is
      // also the order in which a new renderer creates its canvas elements.
      view.dom.render(posed);
      const views = view.dom as unknown as { views: Map<string, { el: HTMLElement; meshVertexCount: number }> };
      const canvas = views.views.get(common.slot)?.el as HTMLCanvasElement | undefined;
      if (!canvas) throw new Error('common canvas missing');
      commonCanvases.add(canvas);
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels.some((value, i) => i % 4 === 3 && value > 0)) throw new Error('empty common content');
      return {
        pixels,
        drawn: view.dom.meshCount,
        reused: view.dom.meshReuseCount,
        visible: [...views.views].filter(([, v]) => v.el.style.display !== 'none').map(([slot]) => slot),
      };
    };
    // Record common packing even on a renderer's first render, without
    // depending on the renderer's view allocation order.
    gpu.flush = function (jobs: MeshBlitJob[]) {
      for (const job of jobs) if (job.uvs === common.uvs) commonCanvases.add(job.canvas);
      probe.canvas.width = 512;
      probe.canvas.height = 3328;
      const ok = originalFlush.call(this, jobs);
      if (!ok) throw new Error('batch-context probe fell back from WebGL');
      const i = jobs.findIndex((job) => commonCanvases.has(job.canvas));
      if (i >= 0) packs.push({ common: [probe.packX[i], probe.packY[i]], target: [probe.canvas.width, probe.canvas.height] });
      return ok;
    };
    const cold = make();
    const a = draw(cold, alone);
    const warm = make();
    const b = draw(warm, crowded);
    const highPack = packs.at(-1)!;
    // This is the identical final drawset, with the common raster reused
    // from the crowded frame. No dirty-flag or pose changes precede it.
    const afterRemoval = draw(warm, alone);
    const warmViews = warm.dom as unknown as { views: Map<string, { meshVertexCount: number }> };
    warmViews.views.get(common.slot)!.meshVertexCount = -1;
    const redrawn = draw(warm, alone);

    const canvasRoot = root();
    const whole = new CanvasRenderer(canvasRoot, assets.pageImages);
    whole.pixelRatio = ratio;
    renderers.push(whole);
    whole.render(frame);
    const wholeCanvas = canvasRoot.querySelector('canvas')!;
    const frameBefore = wholeCanvas.getContext('2d')!.getImageData(0, 0, wholeCanvas.width, wholeCanvas.height).data;
    const afterFrame = draw(make(), alone);
    // Force the whole-frame path after the mesh program, preserving its
    // frame record and output dimensions.
    (whole as unknown as { sigLength: number }).sigLength = -1;
    whole.render(frame);
    const frameAfter = wholeCanvas.getContext('2d')!.getImageData(0, 0, wholeCanvas.width, wholeCanvas.height).data;

    const control = new Uint8ClampedArray([0, 0, 0, 255]);
    const defect = control.slice(); defect[0] = 1;
    let emptyRefused = false;
    try { difference(new Uint8ClampedArray(), new Uint8ClampedArray()); } catch { emptyRefused = true; }
    return {
      webglAvailable: true as const, renderer, ratio,
      backend: warm.dom.meshBackendActive,
      commonUnchanged: sourceBefore === JSON.stringify(common),
      commonSlots: alone.order.map((slot) => slot.slot), sourceSlots: frame.order.map((slot) => slot.slot), highPack, packs,
      contentPixels: a.pixels.filter((value, i) => i % 4 === 3 && value > 0).length,
      coldDiff: difference(a.pixels, b.pixels),
      warmDiff: difference(a.pixels, afterRemoval.pixels),
      cachedDiff: difference(b.pixels, afterRemoval.pixels),
      warmDrawn: afterRemoval.drawn, warmReused: afterRemoval.reused, warmVisible: afterRemoval.visible,
      redrawDiff: difference(a.pixels, redrawn.pixels), redrawDrawn: redrawn.drawn,
      afterFrameDiff: difference(a.pixels, afterFrame.pixels), frameRoundTripDiff: difference(frameBefore, frameAfter),
      controls: { normal: difference(control, control), defect: difference(control, defect), emptyRefused },
    };
  } finally {
    gpu.flush = originalFlush;
    for (const item of renderers) item.dispose();
    for (const element of roots) element.remove();
    assets.dispose();
  }
}
