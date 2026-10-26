import { loadModel } from '../src/loadModel';
import type { ReadDocument } from '../src/loadModel';
import { openTrack, underNoSkin } from 'rig-c/core';
import { loadModel as loadBase, RigPlayer as BasePlayer } from './load-base.generated';
import { RigPlayer } from '../src/player';
import { Container, ImageSource, WebGLRenderer, AtlasAttachmentLoader, Physics, SkeletonJson, Spine, SpineTexture, TextureAtlas } from './oracle/bridge';

type Span = { name: string; start: number; end: number };
const state = globalThis as typeof globalThis & { __loadTrace?: Span[]; loadBench?: unknown };
let officialRenderer: WebGLRenderer | undefined;
let pendingCleanup: (() => void) | undefined;
const contexts = new Set<WebGLRenderingContext | WebGL2RenderingContext>();
const getContext = HTMLCanvasElement.prototype.getContext;
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  ...Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext'),
  value(this: HTMLCanvasElement, ...args: unknown[]) {
    const result = Reflect.apply(getContext, this, args);
    if (result instanceof WebGLRenderingContext || result instanceof WebGL2RenderingContext) contexts.add(result);
    return result;
  },
});
for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
  const upload = prototype.texImage2D;
  Object.defineProperty(prototype, 'texImage2D', {
    ...Object.getOwnPropertyDescriptor(prototype, 'texImage2D'),
    value(this: WebGLRenderingContext | WebGL2RenderingContext, ...args: unknown[]) {
      return sync('texture-upload-submit', () => Reflect.apply(upload, this, args));
    },
  });
  for (const method of ['compileShader', 'getShaderParameter', 'linkProgram', 'getProgramParameter'] as const) {
    const original = prototype[method];
    Object.defineProperty(prototype, method, {
      ...Object.getOwnPropertyDescriptor(prototype, method),
      value(this: WebGLRenderingContext | WebGL2RenderingContext, ...args: unknown[]) {
        return sync(`gl-${method}`, () => Reflect.apply(original, this, args));
      },
    });
  }
}
function sync<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try { return fn(); } finally { state.__loadTrace?.push({ name, start, end: performance.now() }); }
}
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await fn(); } finally { state.__loadTrace?.push({ name, start, end: performance.now() }); }
}
async function text(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}
async function image(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

state.loadBench = {
  cleanup() { pendingCleanup?.(); pendingCleanup = undefined; },
  async run(arm: 'base' | 'candidate' | 'official', rig: { model: string; json: string; atlas: string; animation: string }, regions: 'blob' | 'none' = 'none', verifyRaw = false) {
    pendingCleanup?.(); pendingCleanup = undefined;
    const root = document.getElementById('stage')!;
    state.__loadTrace = [];
    const start = performance.now();
    let cleanup: () => void;
    let snapshot = '';
    let snapshotFrame: unknown;
    let regionPixels: (() => Promise<unknown>) | undefined;
    let rawCheck: (() => unknown) | undefined;
    if (arm !== 'official') {
      const assets = await (arm === 'base' ? loadBase : loadModel)({ modelUrl: rig.model, regions });
      const playerRoot = document.createElement('div');
      playerRoot.style.cssText = 'position:absolute;transform-origin:0 0;transform:translate(256px,480px) scale(.4)';
      root.appendChild(playerRoot);
      const Player = arm === 'base' ? BasePlayer : RigPlayer;
      const player = sync('player-view-renderer', () => new Player(playerRoot, assets, { mode: regions === 'none' ? 'canvas' : 'dom' }));
      player.renderer.pixelRatio = .4;
      sync('first-pose', () => player.play(rig.animation));
      const frame = sync('first-frame-assembly', () => player.posedFrame());
      snapshotFrame = frame;
      if (verifyRaw) rawCheck = () => {
        const track = openTrack(underNoSkin((assets.document as ReadDocument).doc), rig.animation, { loop: true, reset: 'animation' });
        return [track.first, track.step(0), track.step(1 / 60)];
      };
      if (verifyRaw) regionPixels = async () => Promise.all([...assets.regionImages].map(async ([name, region]) => {
        const img = await image(region.url);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return [name, region.width, region.height, canvas.width, canvas.height, Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data)];
      }));
      sync('first-draw-submit-including-upload', () => player.renderer.render(frame));
      cleanup = () => { player.dispose(); assets.dispose(); playerRoot.remove(); };
    } else {
      const [json, atlasText] = await timed('model-atlas-fetch-body', () => Promise.all([text(rig.json), text(rig.atlas)]));
      const parsed = sync('json-parse', () => JSON.parse(json));
      const atlas = sync('atlas-parse', () => new TextureAtlas(atlasText));
      const sources: ImageSource[] = [];
      await timed('pages-fetch-decode', () => Promise.all(atlas.pages.map(async (page) => {
        const img = await image(new URL(page.name, new URL(rig.atlas, location.href)).href);
        const source = new ImageSource({ resource: img, alphaMode: page.pma ? 'premultiplied-alpha' : 'premultiply-alpha-on-upload', scaleMode: 'linear', addressMode: 'clamp-to-edge', autoGenerateMipmaps: false });
        sources.push(source);
        page.setTexture(SpineTexture.from(source));
      })));
      const data = sync('view-compile', () => new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(parsed));
      if (!officialRenderer) {
        officialRenderer = new WebGLRenderer();
        await timed('renderer-init', () => officialRenderer!.init({ width: 512, height: 512, resolution: 1, antialias: false, backgroundAlpha: 0 }));
      }
      const renderer = officialRenderer;
      root.appendChild(renderer.canvas);
      const spine = sync('instance-create', () => new Spine({ skeletonData: data, autoUpdate: false }));
      spine.position.set(256, 480);
      spine.scale.set(.4);
      const container = new Container();
      container.addChild(spine);
      sync('first-pose', () => {
        spine.skeleton.setupPose();
        spine.state.setAnimation(0, rig.animation, true);
        spine.update(0);
        spine.skeleton.updateWorldTransform(Physics.reset);
      });
      sync('first-draw-submit-including-upload', () => renderer.render({ container }));
      cleanup = () => { container.destroy({ children: true }); renderer.canvas.remove(); atlas.dispose(); sources.forEach(s => s.destroy()); };
    }
    const submitted = performance.now();
    sync('gl-queue-drain', () => {
      for (const gl of contexts) if (!gl.isContextLost()) gl.finish();
    });
    const glCompleted = performance.now();
    // This is a paint opportunity, not a display/GPU completion timestamp.
    await timed('paint-opportunity', () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const end = performance.now();
    const spans = state.__loadTrace;
    state.__loadTrace = undefined;
    // Correctness serialization is deliberately outside the measured interval.
    if (snapshotFrame) snapshot = JSON.stringify({ frame: snapshotFrame, raw: rawCheck?.(), regionPixels: await regionPixels?.() }, (_key, value) => {
      if (typeof value !== 'number') return value;
      if (Object.is(value, -0)) return { number: '-0' };
      if (!Number.isFinite(value)) throw new Error('LOAD_NONFINITE_FRAME');
      return value;
    });
    if (verifyRaw) pendingCleanup = cleanup;
    else cleanup();
    state.__loadTrace = undefined;
    const glRenderers = [...contexts].filter(gl => !gl.isContextLost()).map(gl => {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    });
    return { arm, spans, submitMs: submitted - start, glCompletedMs: glCompleted - start, glRenderers, paintOpportunityMs: end - start, snapshot };
  },
};
