import { mountComposedTake } from '../samples/composed-take.js';
import { CanvasRenderer, RigPlayer, loadModel, type CanvasViewport, type PosedFrame, type PosedSlot } from '../src/index.js';
import { renderFrameOf } from '../src/liveFrameSource.js';

export type MountOptions = Parameters<typeof mountComposedTake>[1];
type Take = Awaited<ReturnType<typeof mountComposedTake>>;
type Backend = NonNullable<MountOptions['backend']>;
type Point = { x: number; y: number };
type PointerKind = 'mouse' | 'pen' | 'touch';

const root = document.querySelector<HTMLElement>('#stage')!;
const reading = document.querySelector<HTMLElement>('#reading')!;
const referencePanel = document.querySelector<HTMLElement>('#reference')!;

let now = 0;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
performance.now = () => now;
window.requestAnimationFrame = callback => {
  frames.set(++nextFrame, callback);
  return nextFrame;
};
window.cancelAnimationFrame = id => { frames.delete(id); };

function tick(ms: number): void {
  if (!frames.size) throw new Error('No animation callback was scheduled');
  now += ms;
  const pending = [...frames];
  for (const [id, callback] of pending) {
    if (frames.delete(id)) callback(now);
  }
}

let active: Take | undefined;
let ordinary: Awaited<ReturnType<typeof makeOrdinary>> | undefined;

function take(): Take {
  if (!active) throw new Error('No composed take is mounted');
  return active;
}

async function mount(options: MountOptions): Promise<void> {
  dispose();
  active = await mountComposedTake(root, options);
}

function dispose(): void {
  ordinary?.dispose();
  ordinary = undefined;
  active?.dispose();
  active = undefined;
  reading.hidden = true;
  referencePanel.hidden = true;
}

function point(x: number, y: number, event: 'pointerenter' | 'pointermove' = 'pointermove', pointerType: PointerKind = 'mouse'): void {
  // Bubble from the public canvas so the real listener works on the viewport
  // or on the canvas. Coordinates can deliberately lie outside the box.
  const canvas = take().canvas;
  const box = canvas.getBoundingClientRect();
  const target = event === 'pointerenter' ? root : canvas;
  target.dispatchEvent(new PointerEvent(event, {
    bubbles: event === 'pointermove', isPrimary: true, pointerType,
    clientX: box.left + (1 + x) * box.width / 2,
    clientY: box.top + (1 - y) * box.height / 2,
  }));
}

function reset(event: 'pointerleave' | 'pointercancel', pointerType: PointerKind = 'mouse'): void {
  take().canvas.dispatchEvent(new PointerEvent(event, { bubbles: true, isPrimary: true, pointerType }));
}

function camera(mode: NonNullable<MountOptions['camera']>): void {
  take().setCamera(mode);
}

function layout(width: number, height: number): void {
  root.style.width = `${width}px`;
  root.style.height = `${height}px`;
}

function state() {
  const { mode, offsets, cameraExcursion, cameraTarget, refusal, canvas, player } = take();
  const { width, height } = canvas.getBoundingClientRect();
  return { mode, offsets, cameraExcursion, cameraTarget, refusal: refusal?.code, refusalMessage: refusal?.message, width, height, trackTime: player.time, animationTime: player.entry(0)?.animationTime };
}

function poseBytes(player = take().player): string {
  return JSON.stringify(player.posedFrame().order, (_key, value) => Object.is(value, -0) ? { number: '-0' } : value);
}

function freeze(time: number): void {
  take().player.seek(time);
  take().player.pause();
  tick(0);
}

function coords(slot: PosedSlot): number[] {
  return slot.kind === 'mesh' ? slot.vertices : slot.corners;
}

function geometry(frame: PosedFrame) {
  const clips = new Map<object, number>();
  return frame.order.map(slot => {
    const clip = slot.clip;
    if (clip && !clips.has(clip)) clips.set(clip, clips.size);
    return {
      slot: slot.slot, kind: slot.kind, z: slot.z, coords: [...coords(slot)],
      triangles: slot.kind === 'mesh' ? slot.triangles.length / 3 : 2,
      clip: clip ? { id: clips.get(clip), polygon: [...clip.polygon], inverse: clip.inverse } : null,
    };
  });
}

function sourceGeometry() {
  return geometry(take().player.posedFrame());
}

function pixels(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
}

function alpha({ data, width, height }: ImageData) {
  let nonOpaque = 0;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    nonOpaque += Number(data[i] < 255);
    transparent += Number(data[i] === 0);
  }
  const corners = [0, width - 1, width * (height - 1), width * height - 1].map(i => data[i * 4 + 3]);
  return { width, height, nonOpaque, transparent, corners };
}

function compare(actual: ImageData, expected: ImageData) {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(`Different backing sizes: ${actual.width}x${actual.height} vs ${expected.width}x${expected.height}`);
  }
  let changed = 0;
  let alphaChanged = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    const delta = Math.max(...[0, 1, 2, 3].map(c => Math.abs(actual.data[i + c] - expected.data[i + c])));
    changed += Number(delta > 0);
    alphaChanged += Number(actual.data[i + 3] !== expected.data[i + 3]);
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  return { changed, alphaChanged, maxChannelDelta };
}

function subset(frame: PosedFrame, slots: readonly string[]): PosedFrame {
  return { order: frame.order.filter(slot => slots.includes(slot.slot)) };
}

// Inspect the input at the actual renderer boundary. For a backdrop or figure
// isolation, filter that same input only on the production output canvas.
function rendered(ms = 0, isolate?: readonly string[]) {
  const canvas = take().canvas;
  const realRender = CanvasRenderer.prototype.render;
  const calls: { order: ReturnType<typeof geometry>; viewport: CanvasViewport | null; backend: Backend; clipCount: number }[] = [];
  CanvasRenderer.prototype.render = function (input) {
    if (this.canvas !== canvas) return realRender.call(this, input);
    const frame = renderFrameOf(input);
    realRender.call(this, isolate ? subset(frame, isolate) : input);
    calls.push({ order: geometry(frame), viewport: this.viewport && { ...this.viewport }, backend: this.backendActive, clipCount: this.clipCount });
  };
  try {
    tick(ms);
    if (calls.length !== 1) throw new Error(`Expected one draw on the output canvas, got ${calls.length}`);
    return { ...calls[0], pixels: pixels(canvas) };
  } finally {
    CanvasRenderer.prototype.render = realRender;
  }
}

function draw(ms = 0) {
  const { pixels: result, ...drawn } = rendered(ms);
  return { ...drawn, alpha: alpha(result) };
}

function backdrop(slots: readonly string[]) {
  const { pixels: result, backend, viewport } = rendered(0, slots);
  return { ...alpha(result), backend, viewport };
}

function layerPixels({ x, y }: Point, layers: readonly (readonly string[])[]) {
  const sample = (slots?: readonly string[]) => {
    const { pixels: image } = rendered(0, slots);
    const start = (y * image.width + x) * 4;
    return Array.from(image.data.subarray(start, start + 4));
  };
  try {
    return { full: sample(), layers: layers.map(slots => sample(slots)) };
  } finally {
    tick(0);
  }
}

function compareWithout(slot: string) {
  const full = rendered();
  try {
    return compare(full.pixels, rendered(0, full.order.filter(row => row.slot !== slot).map(row => row.slot)).pixels);
  } finally {
    tick(0);
  }
}

async function makeOrdinary(modelUrl: string, animation: string, backend: Backend) {
  const assets = await loadModel({ modelUrl, regions: 'none', setsUrl: null, crossOrigin: 'anonymous' });
  if (!assets.stage) throw new Error('Reference control has no stage');
  const stage = assets.stage;
  const player = new RigPlayer(document.createElement('div'), assets, { mode: 'canvas' });
  const renderer = player.renderer as CanvasRenderer;
  renderer.backend = backend;
  renderer.pixelRatio = 1;
  renderer.viewport = stage;
  player.play(animation, { loop: true });

  return {
    assets, player, renderer, stage,
    dispose() {
      player.dispose();
      assets.dispose();
    },
  };
}

async function openReference(modelUrl: string, animation: string, backend: Backend) {
  ordinary?.dispose();
  ordinary = await makeOrdinary(modelUrl, animation, backend);
}

function fixedReference(time: number) {
  if (!ordinary) throw new Error('Open the reference first');
  ordinary.player.seek(time);
  ordinary.player.draw();
  return {
    ...compare(pixels(take().canvas), pixels(ordinary.renderer.canvas)),
    backend: ordinary.renderer.backendActive,
  };
}

function livePose(bones: readonly string[], player = take().player) {
  return {
    trackTime: player.time, animationTime: player.entry(0)?.animationTime,
    bytes: poseBytes(player), bones: bones.map(name => player.bone(name)),
  };
}

function liveReference(frames: number, ms: number, bones: readonly string[]) {
  if (!ordinary) throw new Error('Open the reference first');
  const { player } = ordinary;
  for (let i = 0; i < frames; i++) player.advance(ms / 1000);
  return livePose(bones, player);
}

function planeReferences(time: number, planes: readonly { slots: readonly string[]; shift: Point }[]) {
  if (!ordinary) throw new Error('Open the reference first');
  const { player, renderer, stage } = ordinary;
  player.seek(time);
  const frame = player.posedFrame();
  try {
    return planes.map(({ slots, shift }) => {
      // Keep the stock geometry untouched and move its viewport. The test
      // supplies screen-space shifts independently of the compositor readout.
      renderer.viewport = { ...stage, x: stage.x - shift.x, y: stage.y + shift.y };
      renderer.render(subset(frame, slots));
      const actual = rendered(0, slots);
      return {
        slots, shift, actualBackend: actual.backend, referenceBackend: renderer.backendActive,
        ...compare(actual.pixels, pixels(renderer.canvas)),
        ...alpha(actual.pixels),
      };
    });
  } finally {
    renderer.viewport = stage;
    tick(0);
  }
}

let fixedFigure: ImageData | undefined;

function storeFigure(slots: readonly string[]): void {
  fixedFigure = rendered(0, slots).pixels;
}

function compareFigure(slots: readonly string[]) {
  if (!fixedFigure) throw new Error('Missing fixed figure comparison');
  const current = rendered(0, slots).pixels;
  return { ...compare(current, fixedFigure), ...alpha(current) };
}

function cropComparison(actual: ReturnType<typeof rendered>, wide: ImageData, wideBackend: Backend, stage?: ImageData) {
  return {
    ...compare(actual.pixels, wide),
    stage: stage ? compare(actual.pixels, stage) : null,
    actualBackend: actual.backend,
    wideBackend,
  };
}

function cropReference(time: number, shift: Point, figure: readonly string[]) {
  if (!ordinary) throw new Error('Open the reference first');
  ordinary.player.seek(time);
  const original = ordinary.player.posedFrame();
  const { stage } = ordinary;
  const pad = 32;
  const wide = new CanvasRenderer(document.createElement('div'), ordinary.assets.pageImages);
  try {
    // Keep the source pose untouched. Move only the reference camera origin.
    const view = { ...stage, x: stage.x - shift.x, y: stage.y + shift.y };
    wide.viewport = {
      x: view.x - pad, y: view.y - pad,
      width: view.width + 2 * pad, height: view.height + 2 * pad,
    };
    wide.pixelRatio = 1;
    wide.backend = ordinary.renderer.backend;
    const slice = () => wide.canvas.getContext('2d')!.getImageData(pad, pad, stage.width, stage.height);
    const stageControl = (frame: PosedFrame) => {
      if (wide.backend !== 'canvas2d') return undefined;
      // Match the output backing size while moving the stock camera over the untouched pose.
      ordinary!.renderer.viewport = view;
      ordinary!.renderer.render(frame);
      return pixels(ordinary!.renderer.canvas);
    };
    wide.render(original);
    const full = slice();
    const actual = rendered();
    showCropReference(full);
    const scene = cropComparison(actual, full, wide.backendActive, stageControl(original));
    const isolated = rendered(0, figure);
    const sourceFigure = subset(original, figure);
    wide.render(sourceFigure);
    const fullFigure = slice();
    const actor = cropComparison(isolated, fullFigure, wide.backendActive, stageControl(sourceFigure));

    // The same source raster under a stage-space mask moved with the figure.
    // This represents clipping to the old stage before the new translation.
    const early = new ImageData(new Uint8ClampedArray(fullFigure.data), fullFigure.width, fullFigure.height);
    for (let y = 0; y < early.height; y++) {
      for (let x = 0; x < early.width; x++) {
        if (x >= shift.x && x < shift.x + early.width && y >= shift.y && y < shift.y + early.height) continue;
        const start = (y * early.width + x) * 4;
        early.data.fill(0, start, start + 4);
      }
    }
    const earlyCrop = compare(early, fullFigure);
    tick(0); // Restore the composited stage after observing isolated pixels.
    return { scene, actor, earlyCrop, source: geometry(original), alpha: alpha(fullFigure) };
  } finally {
    ordinary.renderer.viewport = stage;
    wide.dispose();
  }
}

function showCropReference(image: ImageData): void {
  const reference = referencePanel.querySelector('canvas') ?? referencePanel.appendChild(document.createElement('canvas'));
  reference.width = image.width;
  reference.height = image.height;
  reference.getContext('2d')!.putImageData(image, 0, 0);
}

function showReading(lines: string[], showReference = false): void {
  reading.hidden = false;
  reading.textContent = lines.join('\n');
  referencePanel.hidden = !showReference;
}

Object.assign(window, {
  composedTest: {
    mount, dispose, point, reset, tick, camera, layout, state, poseBytes, freeze,
    sourceGeometry, draw, backdrop, openReference, fixedReference, livePose, liveReference, storeFigure,
    compareFigure, cropReference, planeReferences, layerPixels, compareWithout, showReading,
  },
});

export type ComposedHarnessWindow = typeof window & {
  composedTest: {
    mount: typeof mount; dispose: typeof dispose; point: typeof point; reset: typeof reset;
    tick: typeof tick; camera: typeof camera; layout: typeof layout; state: typeof state;
    poseBytes: typeof poseBytes; freeze: typeof freeze; sourceGeometry: typeof sourceGeometry;
    draw: typeof draw; backdrop: typeof backdrop; openReference: typeof openReference;
    fixedReference: typeof fixedReference; livePose: typeof livePose; liveReference: typeof liveReference;
    storeFigure: typeof storeFigure; compareFigure: typeof compareFigure;
    cropReference: typeof cropReference; planeReferences: typeof planeReferences; layerPixels: typeof layerPixels;
    compareWithout: typeof compareWithout; showReading: typeof showReading;
  };
};
