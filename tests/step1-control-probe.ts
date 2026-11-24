import { CanvasRenderer } from '../src/CanvasRenderer';
import { DomRenderer } from '../src/DomRenderer';
import type { PosedFrame } from '../src/posedFrame';
import { frameAt, loadRig } from './rigFrames';

export type Mount = 'A' | 'B' | 'C';
type Rect = [x: number, y: number, width: number, height: number];
type Target = [width: number, height: number];
type Upload = { bytes: number; offset: number | null; payload: number[] | null; arrayBuffer: boolean };
type Draw = { triangles: boolean; first: number; count: number };
type Scissor = { rect: Rect; target: Target };
type Copy = {
  canvas: HTMLCanvasElement;
  sharedSource: boolean;
  rects: number[];
};

const TIMES = { A: [0, 0.25], B: [0.5, 0.75], C: [0.5, 0.75] } as const;
const RESOURCES = [
  'createBuffer', 'createTexture', 'createProgram', 'createShader',
  'createFramebuffer', 'createRenderbuffer', 'deleteBuffer', 'deleteTexture',
  'deleteProgram', 'deleteShader', 'deleteFramebuffer', 'deleteRenderbuffer',
  'linkProgram', 'texImage2D', 'texSubImage2D',
] as const;
const GL_STATE = [
  'bindBuffer', 'bindTexture', 'useProgram', 'vertexAttribPointer',
  'enableVertexAttribArray', 'disableVertexAttribArray', 'viewport',
  'clear', 'uniform2f',
] as const;

function capture() {
  return {
    bufferData: [] as Upload[],
    bufferSubData: [] as Upload[],
    draws: [] as Draw[],
    scissors: [] as Scissor[],
    copies: [] as Copy[],
    resources: {} as Record<string, number>,
    glStateCalls: 0,
    clears: 0,
    source: null as HTMLCanvasElement | OffscreenCanvas | null,
  };
}

function upload(args: unknown[], gl: WebGLRenderingContext, sourceIndex: number): Upload {
  const source = args[sourceIndex];
  const arrayBuffer = args[0] === gl.ARRAY_BUFFER;
  const offset = sourceIndex === 2 ? Number(args[1]) : null;
  if (typeof source === 'number') return { bytes: source, offset, payload: null, arrayBuffer };
  if (ArrayBuffer.isView(source)) {
    const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    return { bytes: bytes.length, offset, payload: Array.from(bytes), arrayBuffer };
  }
  throw new Error('Expected a sized or typed-array WebGL buffer upload');
}

async function pixels(canvas: HTMLCanvasElement) {
  const { width, height } = canvas;
  const rgba = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  let ink = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) ink++;
  // Keep transport small while letting the spec compare the original RGBA bytes.
  const stream = new Blob([new Uint8Array(rgba)]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < compressed.length; i += 16384) {
    binary += String.fromCharCode(...compressed.subarray(i, i + 16384));
  }
  return { width, height, ink, deflated: btoa(binary) };
}

/**
 * Each call starts on a fresh harness document. Both paired roots share the
 * loaded page images. The only inputs to render() are frames posed from the
 * public rigc build. Observe the native calls so the test also detects an
 * extra upload, draw or copy that leaves the resulting pixels unchanged.
 */
export async function step1ControlProbe(order: Mount[], readPixels: boolean) {
  const assets = await loadRig('step1-control');
  const views: { name: Mount; root: HTMLElement; renderer: DomRenderer | CanvasRenderer; cold: PosedFrame; warm: PosedFrame }[] = [];
  const restore: (() => void)[] = [];
  const contexts = new Set<WebGLRenderingContext>();
  const vaoExtensions = new WeakSet<object>();
  let vaoObservation: 'not-requested' | 'unavailable' | 'observed' | 'unobservable' = 'not-requested';
  let active: ReturnType<typeof capture> | undefined;

  function observe<T extends object>(
    target: T,
    method: keyof T,
    record: (trace: ReturnType<typeof capture>, receiver: T, args: unknown[], result: unknown) => void,
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(target, method);
    const original = target[method];
    if (typeof original !== 'function') throw new Error(`Cannot observe ${String(method)}`);
    Object.defineProperty(target, method, {
      configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false,
      value(this: T, ...args: unknown[]) {
        const result: unknown = Reflect.apply(original, this, args);
        if (active) record(active, this, args, result);
        return result;
      },
    });
    restore.push(() => {
      if (descriptor) Object.defineProperty(target, method, descriptor);
      else Reflect.deleteProperty(target, method);
    });
  }

  function observeVao(ext: OES_vertex_array_object) {
    if (vaoExtensions.has(ext)) return;
    vaoExtensions.add(ext);
    const methods = ['createVertexArrayOES', 'deleteVertexArrayOES', 'bindVertexArrayOES'] as const;
    const canWrap = methods.every(method => {
      const own = Object.getOwnPropertyDescriptor(ext, method);
      return typeof ext[method] === 'function' && (own ? own.configurable : Object.isExtensible(ext));
    });
    if (!canWrap) {
      vaoObservation = 'unobservable';
      return;
    }
    vaoObservation = 'observed';
    for (const method of methods) {
      observe(ext, method, trace => {
        if (method === 'bindVertexArrayOES') trace.glStateCalls++;
        else trace.resources[method] = (trace.resources[method] ?? 0) + 1;
      });
    }
  }

  function render(view: typeof views[number], frame: PosedFrame) {
    const { renderer } = view;
    const isCanvas = renderer instanceof CanvasRenderer;
    const trace = capture();
    active = trace;
    try {
      renderer.render(frame);
    } finally {
      active = undefined;
    }
    const canvases = Array.from(view.root.querySelectorAll('canvas'));
    const { source, copies, ...work } = trace;
    return {
      name: view.name,
      mode: isCanvas ? 'canvas' as const : 'dom' as const,
      backend: isCanvas ? renderer.backendActive : renderer.meshBackendActive,
      fallback: isCanvas ? renderer.backendFallbackReason : renderer.meshBackendFallbackReason,
      drawn: isCanvas ? renderer.blits : renderer.meshCount,
      reused: isCanvas ? renderer.framesReused : renderer.meshReuseCount,
      reallocations: renderer.canvasReallocCount,
      canvases: canvases.length,
      ...work,
      copies: copies.map(({ canvas, sharedSource, rects }) => ({
        destination: canvases.indexOf(canvas),
        sharedSource,
        rects,
      })),
    };
  }

  try {
    const gl = WebGLRenderingContext.prototype;
    // Observe the extension only if production requests it. Keep the same
    // native extension object and leave extension activation to the renderer.
    observe(gl, 'getExtension', (_trace, _context, [name], result) => {
      if (typeof name !== 'string' || name.toLowerCase() !== 'oes_vertex_array_object') return;
      if (result) observeVao(result as OES_vertex_array_object);
      else vaoObservation = 'unavailable';
    });
    observe(gl, 'bufferData', (trace, context, args) => trace.bufferData.push(upload(args, context, 1)));
    observe(gl, 'bufferSubData', (trace, context, args) => trace.bufferSubData.push(upload(args, context, 2)));
    observe(gl, 'drawArrays', (trace, context, [mode, first, count]) => {
      contexts.add(context);
      trace.source = context.canvas;
      trace.draws.push({ triangles: mode === context.TRIANGLES, first: Number(first), count: Number(count) });
    });
    observe(gl, 'scissor', (trace, context, args) => {
      trace.scissors.push({
        rect: [Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3])],
        target: [context.drawingBufferWidth, context.drawingBufferHeight],
      });
    });
    for (const method of RESOURCES) {
      observe(gl, method, trace => { trace.resources[method] = (trace.resources[method] ?? 0) + 1; });
    }
    for (const method of GL_STATE) observe(gl, method, trace => { trace.glStateCalls++; });
    const ctx = CanvasRenderingContext2D.prototype;
    observe(ctx, 'drawImage', (trace, context, [source, ...rects]) => {
      trace.copies.push({ canvas: context.canvas, sharedSource: source === trace.source, rects: rects.map(Number) });
    });
    observe(ctx, 'clearRect', trace => { trace.clears++; });

    for (const name of order) {
      const cold = frameAt(assets, 'pulse', TIMES[name][0]);
      const warm = frameAt(assets, 'pulse', TIMES[name][1]);
      const root = document.body.appendChild(document.createElement('div'));
      const renderer = name === 'C'
        ? new CanvasRenderer(root, assets.pageImages)
        : new DomRenderer(root, assets.regionImages, assets.pageImages);
      if (renderer instanceof CanvasRenderer) {
        renderer.backend = 'webgl';
        renderer.viewport = { x: 0, y: 0, width: 440, height: 360 };
      } else {
        renderer.meshBackend = 'webgl';
      }
      renderer.pixelRatio = 1;
      views.push({ name, root, renderer, cold, warm });
    }
    const cold = views.map(view => render(view, view.cold));
    const warm = views.map(view => render(view, view.warm));
    const frozen = views.map(view => render(view, view.warm));
    const rgba = readPixels ? await Promise.all(views.map(async ({ name, root }) => ({
      name,
      canvases: await Promise.all(Array.from(root.querySelectorAll('canvas'), pixels)),
    }))) : [];
    return { cold, warm, frozen, rgba, rasterContexts: contexts.size, vaoObservation };
  } finally {
    for (const undo of restore.reverse()) undo();
    for (const { renderer, root } of views) {
      renderer.dispose();
      root.remove();
    }
    assets.dispose();
  }
}
