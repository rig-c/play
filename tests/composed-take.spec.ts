import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { build } from 'vite';
import type { ComposedHarnessWindow, MountOptions, TranslationDial } from './composed-take-harness.js';

const FIXTURES = 'tests/fixtures/composed-direction';
const model = (name: string) => `/${FIXTURES}/${name}/skeleton.model.json`;
const SLOTS = {
  background: ['backdrop'],
  figure: ['actor:background', 'actor:torso', 'actor:lantern', 'actor:face', 'actor:eye_r', 'actor:eye_l'],
  foreground: ['foreground'],
} as const;
const PLANES = ['background', 'figure', 'foreground'] as const;
const ORDER = [...SLOTS.background, ...SLOTS.figure, ...SLOTS.foreground];
const STAGE = { x: -64, y: 0, width: 128, height: 128 };
const CORNERS = [[-2, -2], [-2, 2], [2, -2], [2, 2]] as const;
type Backend = NonNullable<MountOptions['backend']>;
type NamedMountOptions = Extract<MountOptions, { planes: object }>;
type Mode = NonNullable<MountOptions['camera']>;
type Point = { x: number; y: number };
const check = (row: number, name: string) => `C2-${row} ${name}`;

const bundledHarnesses = new Map<boolean, Promise<{ html: string; script: string }>>();
function harness(shortDialTravel: boolean) {
  const cached = bundledHarnesses.get(shortDialTravel);
  if (cached) return cached;
  const bundle = (async () => {
    const [html, bundle] = await Promise.all([
      readFile('tests/composed-take-harness.html', 'utf8'),
      build({
        configFile: false, logLevel: 'silent',
        plugins: shortDialTravel ? [{
          name: 'test-dial-travel', enforce: 'pre',
          transform(source, id) {
            if (id !== resolve('src/composed-take.ts')) return;
            const setting = 'TURN_FULL_RANGE_AT_STAGE_EDGE = 1;';
            if (!source.includes(setting)) throw new Error('Missing default dial travel setting');
            return source.replace(setting, 'TURN_FULL_RANGE_AT_STAGE_EDGE = 0.5;');
          },
        }] : [],
        build: { write: false, lib: { entry: resolve('tests/composed-take-harness.ts'), formats: ['es'] } },
      }),
    ]);
    const output = Array.isArray(bundle) ? bundle[0] : bundle;
    if (!('output' in output)) throw new Error('Expected composed harness bundle');
    const entry = output.output.find(item => item.type === 'chunk' && item.isEntry);
    if (entry?.type !== 'chunk') throw new Error('Missing composed harness entry');
    return { html: html.replace('./composed-take-harness.ts', '/composed-probe.js'), script: entry.code };
  })();
  bundledHarnesses.set(shortDialTravel, bundle);
  return bundle;
}

async function open(page: Page, shortDialTravel = false): Promise<void> {
  const { html, script } = await harness(shortDialTravel);
  await page.unroute('**/composed-probe.html');
  await page.unroute('**/composed-probe.js');
  await page.unroute(`**/${FIXTURES}/**`);
  await page.route('**/composed-probe.html', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/composed-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
  await page.route(`**/${FIXTURES}/**`, async route => {
    const filename = new URL(route.request().url()).pathname.slice(FIXTURES.length + 2);
    if (!/^[a-z0-9-]+\/skeleton\.(model\.json|png)$/.test(filename)) return route.fallback();
    return route.fulfill({ path: join(FIXTURES, filename) });
  });
  await page.goto('/composed-probe.html');
  await page.waitForFunction(() => Boolean((window as ComposedHarnessWindow).composedTest), undefined, { polling: 20 });
}

function mountOptions(backend: Backend, overrides: Partial<MountOptions> = {}): MountOptions {
  return {
    modelUrl: model('overscan'), animation: 'idle', loop: true, slots: SLOTS, backend, ...overrides,
  } as MountOptions;
}

function mount(page: Page, backend: Backend, overrides: Partial<MountOptions> = {}) {
  return page.evaluate(options => (window as ComposedHarnessWindow).composedTest.mount(options), mountOptions(backend, overrides));
}

function mountNamed(page: Page, backend: Backend, modelUrl: string, overrides: Partial<NamedMountOptions> = {}) {
  const options: NamedMountOptions = {
    modelUrl, animation: 'idle', loop: true, planes: NAMED_PLANES, backend,
    camera: 'parallax', maxDisplacement: { x: 64, y: 0 }, transitionMs: 120, pointerTurn: false,
    ...overrides,
  };
  return page.evaluate(options => (window as ComposedHarnessWindow).composedTest.mount(options), options);
}

function setCamera(page: Page, mode: Mode) {
  return page.evaluate(mode => (window as ComposedHarnessWindow).composedTest.camera(mode), mode);
}

function state(page: Page) {
  return page.evaluate(() => (window as ComposedHarnessWindow).composedTest.state());
}

function point(page: Page, x: number, y: number, event?: 'pointerenter' | 'pointermove', pointerType?: 'mouse' | 'pen' | 'touch') {
  return page.evaluate(args => (window as ComposedHarnessWindow).composedTest.point(...args), [x, y, event, pointerType] as const);
}

function tick(page: Page, ms: number) {
  return page.evaluate(dt => (window as ComposedHarnessWindow).composedTest.tick(dt), ms);
}

function reset(page: Page, event: 'pointercancel' | 'pointerleave', pointerType?: 'mouse' | 'pen' | 'touch') {
  return page.evaluate(args => (window as ComposedHarnessWindow).composedTest.reset(...args), [event, pointerType] as const);
}

function draw(page: Page, ms = 0) {
  return page.evaluate(ms => (window as ComposedHarnessWindow).composedTest.draw(ms), ms);
}

function backdrop(page: Page) {
  return page.evaluate(slots => (window as ComposedHarnessWindow).composedTest.backdrop(slots), SLOTS.background);
}

function freeze(page: Page, time: number) {
  return page.evaluate(time => (window as ComposedHarnessWindow).composedTest.freeze(time), time);
}

function ordinary(page: Page, backend: Backend, url: string) {
  return page.evaluate(([url, backend]) => (window as ComposedHarnessWindow).composedTest.openReference(url, 'idle', backend),
    [url, backend] as const);
}

function closePoint(actual: Point, expected: Point, label: string): void {
  expect(actual.x, `${label} x`).toBeCloseTo(expected.x, 8);
  expect(actual.y, `${label} y`).toBeCloseTo(expected.y, 8);
}

function offsets(camera: Point, mode: Mode) {
  const gains = mode === 'pan' ? [1, 1, 1] : mode === 'parallax' ? [-0.55, 0, 0.55] : [0, 0, 0];
  return Object.fromEntries(PLANES.map((plane, index) => [
    plane, { x: -camera.x * gains[index], y: camera.y * gains[index] },
  ])) as Record<(typeof PLANES)[number], Point>;
}

function poseDigest(bytes: string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertOpaque(result: Pick<Awaited<ReturnType<typeof backdrop>>, 'backend' | 'nonOpaque' | 'corners'>, backend: Backend): void {
  expect(result.backend, 'requested backend drew').toBe(backend);
  expect(result.nonOpaque, 'backdrop-only alpha < 255').toBe(0);
  expect(result.corners).toEqual([255, 255, 255, 255]);
}

async function alterModel(page: Page, name: string, change: (doc: CompiledControl) => void, alphaHole?: { region: string; offset: number }): Promise<string> {
  const [sourceDoc, sourcePng] = await Promise.all([
    readFile(join(FIXTURES, 'overscan/skeleton.model.json'), 'utf8'),
    readFile(join(FIXTURES, 'overscan/skeleton.png')),
  ]);
  const doc = JSON.parse(sourceDoc) as CompiledControl;
  change(doc);
  // Give every derived document its own in-memory inputs. Both the embed and
  // the ordinary player still go through loadModel and the browser image decoder.
  return page.evaluate(async ({ doc, source, name, alphaHole }) => {
    let pageUrl = source;
    if (alphaHole) {
      const plate = doc.pages[0].regions.find(region => region.name === alphaHole.region);
      if (!plate) throw new Error(`Missing atlas region ${alphaHole.region} for the alpha-hole control`);
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      context.clearRect(plate.x + alphaHole.offset, plate.y + alphaHole.offset, 8, 8);
      pageUrl = canvas.toDataURL();
    }
    doc.pages[0].name = pageUrl;
    return URL.createObjectURL(new File([JSON.stringify(doc)], `${name}.model.json`, { type: 'application/json' }));
  }, { doc, source: `data:image/png;base64,${sourcePng.toString('base64')}`, name, alphaHole });
}

interface CompiledControl {
  stage?: { x: number; y: number; width: number; height: number } | null;
  bones: { name: string; parent?: string; x: number; y: number }[];
  slots: { name: string; bone?: string; setup?: string }[];
  animations: { name: string; duration: number; bones: { name: string; timelines: object[] }[]; slots?: { name: string }[] }[];
  constraints: { kind: string; name: string; bone: string; [parameter: string]: string | number | boolean }[];
  skins: { attachments: Record<string, Record<string, CompiledRegion | CompiledClip>> }[];
  pages: { name: string; regions: { name: string; x: number; y: number; width: number; height: number }[] }[];
  editorOrder: { skins: { name: string; slots: string[] }[]; animations: string[] };
  rig?: { slotOrder: string[] };
}

interface CompiledRegion {
  kind: 'region';
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CompiledClip {
  kind: 'clipping';
  end: string;
  convex: true;
  vertexCount: number;
  vertices: { weighted: false; xy: number[] };
}

function attachmentClip(page: Page, crossPlane: boolean, stage?: typeof STAGE) {
  return alterModel(page, crossPlane ? 'cross-plane' : 'figure-clip', doc => {
    if (stage) doc.stage = stage;
    const name = 'test-attachment-clip';
    doc.slots.splice(crossPlane ? 0 : 1, 0, { name, bone: 'root', setup: name });
    doc.rig?.slotOrder.splice(crossPlane ? 0 : 1, 0, name);
    doc.editorOrder.skins.find(skin => skin.name === 'default')!.slots.push(name);
    doc.skins[0].attachments[name] = {
      [name]: {
        kind: 'clipping', end: 'actor:eye_l', convex: true, vertexCount: 4,
        vertices: { weighted: false, xy: [-40, 20, 30, 20, 30, 103, -40, 103] },
      },
    };
  });
}

async function withoutForeground(page: Page) {
  return alterModel(page, 'without-foreground', doc => {
    doc.slots = doc.slots.filter(slot => slot.name !== 'foreground');
    for (const skin of doc.skins) delete skin.attachments.foreground;
    for (const skin of doc.editorOrder.skins) skin.slots = skin.slots.filter(slot => slot !== 'foreground');
    for (const animation of doc.animations) {
      animation.bones = animation.bones.filter(row => row.name !== 'foreground');
      if (animation.slots) animation.slots = animation.slots.filter(row => row.name !== 'foreground');
    }
    if (doc.rig) doc.rig.slotOrder = doc.rig.slotOrder.filter(name => name !== 'foreground');
  });
}

async function shortPlate(page: Page, axis: 'x' | 'y') {
  return alterModel(page, `short-${axis}`, doc => {
    const plate = doc.skins[0].attachments.backdrop.backdrop as { width: number; height: number };
    if (axis === 'x') plate.width = 146;
    else plate.height = 146;
  });
}

function transparentPlate(page: Page) {
  return alterModel(page, 'transparent', () => {}, { region: 'scene-plate.0', offset: 25 });
}

const TABLES_SLOT = 'tables';
const NAMED_PLANES = {
  backdrop: { role: 'backdrop', slots: SLOTS.background, baked: { bone: 'backdrop' } },
  tables: { role: 'overlay', slots: [TABLES_SLOT], baked: { bone: 'tables' } },
  figure: { role: 'figure', slots: SLOTS.figure },
  foreground: { role: 'overlay', slots: SLOTS.foreground, gain: 0.55 },
} as const;
const NAMED_IDS = Object.keys(NAMED_PLANES) as (keyof typeof NAMED_PLANES)[];
const NAMED_ORDER = NAMED_IDS.flatMap<string>(plane => [...NAMED_PLANES[plane].slots]);
const STILL_PLANES = {
  ...NAMED_PLANES,
  backdrop: { role: 'backdrop', slots: SLOTS.background },
  tables: { role: 'overlay', slots: [TABLES_SLOT], gain: -0.55 * 28 / 24 },
} as const;
const COMPOSITE_PLANES = {
  ...STILL_PLANES,
  backdrop: { ...STILL_PLANES.backdrop, gain: -0.5 },
  tables: { ...STILL_PLANES.tables, gain: -0.5 },
} as const;
const COMPOSITE_SLOTS = [...SLOTS.background, TABLES_SLOT];
const NAMED_ALPHA_HOLE = /\b[1-9]\d* stage pixels have alpha below 255/;

type FourPlaneVariant = 'still' | 'live-physics' | 'left-edge' | 'alpha-hole' | 'tables-edge' | 'covered-hole' | 'visible-hole'
  | 'opposite-tables-track' | 'no-dials' | 'turn-dials';

const TRANSLATION_DIALS = [
  { bone: 'synthetic:yaw_dial', channel: 'x', range: 8, setup: 1.25, slot: 'actor:face', turn: 18, baked: 4 },
  { bone: 'synthetic:pitch_dial', channel: 'y', range: 16, setup: 3.25, slot: 'actor:lantern', turn: 24 },
  { bone: 'synthetic:body_yaw_dial', channel: 'x', range: 32, setup: -1.5, slot: 'actor:background', turn: 12, baked: -8 },
] as const satisfies readonly (TranslationDial & { range: number; setup: number; slot: string; turn: number; baked?: number })[];

function addTurnDials(doc: CompiledControl, idle: CompiledControl['animations'][number]): void {
  const template = doc.animations.find(animation => animation.name === 'actor:body_turn')!;
  for (const dial of TRANSLATION_DIALS) {
    const { bone, channel, range, setup, slot, turn } = dial;
    const target = `${bone}-target`;
    const animation = `${bone}-turn`;
    doc.bones.push({ name: bone, parent: 'root', x: 0, y: 0, [channel]: setup });
    doc.bones.push({ name: target, parent: 'actor:body', x: 0, y: 0 });
    doc.slots.find(row => row.name === slot)!.bone = target;
    doc.constraints.push({
      kind: 'slider', name: animation, animation, declaredIn: 'rig', bone, property: channel,
      local: true, from: -range, scale: 1 / range, max: 2 * range,
    });
    doc.animations.push({ ...template, name: animation, duration: 2, bones: [{ name: target, timelines: [{
      name: 'rotate', keys: [{ time: 0, value: -turn }, { time: 2, value: turn }],
    }] }] });
    doc.editorOrder.animations.push(animation);
    if ('baked' in dial) {
      idle.bones.push({ name: bone, timelines: [{ name: `translate${channel}`, keys: [
        { time: 0, value: 0 }, { time: 2, value: dial.baked }, { time: 4, value: 0 },
      ] }] });
    }
  }
}

function fourPlaneModel(page: Page, variant?: FourPlaneVariant) {
  const composite = variant === 'covered-hole' || variant === 'visible-hole';
  return alterModel(page, `four-plane${variant ? `-${variant}` : ''}`, doc => {
    const attachments = doc.skins[0].attachments;
    const backdrop = attachments.backdrop.backdrop as CompiledRegion;
    backdrop.width = variant === 'left-edge' ? 240 : 320;
    backdrop.x = variant === 'left-edge' ? 48 : 0;
    const foreground = attachments.foreground.foreground as CompiledRegion;
    attachments[TABLES_SLOT] = {
      [TABLES_SLOT]: composite
        // The center of the diamond is opaque. Moving it below the same
        // base hole leaves the composite geometry valid but exposes the hole.
        ? { ...foreground, x: 0, y: variant === 'covered-hole' ? 64 : 16, width: 112, height: 48 }
        : { ...foreground, width: variant === 'tables-edge' ? 0 : 12, height: 12 },
    };
    doc.bones.push({ name: 'tables', parent: 'root', x: 0, y: 0 });
    doc.slots.splice(1, 0, { name: TABLES_SLOT, bone: 'tables', setup: TABLES_SLOT });
    doc.rig?.slotOrder.splice(1, 0, TABLES_SLOT);
    doc.editorOrder.skins.find(skin => skin.name === 'default')!.slots.push(TABLES_SLOT);
    const idle = doc.animations.find(animation => animation.name === 'idle')!;
    if (variant !== 'still' && !composite) {
      for (const [name, amplitude] of [['backdrop', 24], ['tables', variant === 'opposite-tables-track' ? -28 : 28]] as const) {
        idle.bones.push({ name, timelines: [{
          name: 'translate', keys: [0, amplitude, 0, -amplitude, 0].map((x, time) => ({ time, x, y: 0 })),
        }] });
      }
    }
    if (variant === 'live-physics') {
      idle.bones.push({ name: 'actor:body_yaw_dial', timelines: [{
        name: 'rotate', keys: [{ time: 0, value: 0 }, { time: 1, value: -12 }, { time: 4, value: 0 }],
      }] });
      doc.constraints.push({
        kind: 'physics', name: 'actor:follow', declaredIn: 'rig', bone: 'actor:body', x: 1, wind: 30, strength: 35,
      });
    }
    if (variant === 'no-dials' || variant === 'turn-dials') doc.constraints = [];
    if (variant === 'turn-dials') addTurnDials(doc, idle);
  }, variant === 'alpha-hole' || composite ? { region: 'scene-plate.0', offset: 75 } : undefined);
}

type DrawnOrder = Awaited<ReturnType<typeof draw>>['order'];

function float32Geometry(order: DrawnOrder) {
  return order.map(slot => ({ ...slot, coords: slot.coords.map(Math.fround) }));
}

function figureGeometry(order: DrawnOrder) {
  return float32Geometry(order.filter(row => (SLOTS.figure as readonly string[]).includes(row.slot)));
}

function bakedDials(time: number) {
  return TRANSLATION_DIALS.map(dial => 'baked' in dial ? dial.setup + time / 2 * dial.baked : dial.setup);
}

async function expectDials(page: Page, frame: DrawnOrder, time: number, expected: readonly number[], label: string) {
  const reading = await page.evaluate(({ time, dials }) => {
    const rig = (window as ComposedHarnessWindow).composedTest;
    return { locals: rig.dialLocals(dials), stock: rig.dialReference(time, dials) };
  }, { time, dials: TRANSLATION_DIALS.map(({ bone, channel }, index) => ({ bone, channel, value: expected[index] })) });
  expect(reading.locals.map(Math.fround), `${label} stored locals`).toEqual(expected.map(Math.fround));
  expect(figureGeometry(frame), `${label} rendered figure against ordinary player`).toEqual(figureGeometry(reading.stock));
}

function turnReadouts(page: Page) {
  return page.evaluate(() => (window as ComposedHarnessWindow).composedTest.turnReadouts());
}

type CropReading = ReturnType<ComposedHarnessWindow['composedTest']['cropReference']>;

async function expectCropRaster(
  result: CropReading, backend: Backend, shift: Point, info: TestInfo, labels: Record<'scene' | 'actor', string>,
): Promise<void> {
  // Canvas2D affine/filtering quantization motivates the bounded comparison, and the frozen readings support exact WebGL parity.
  const limit = backend === 'webgl' ? 0 : 4;
  const views = (['actor', 'scene'] as const).map(view => {
    const reading = result[view];
    expect(reading.actualBackend, `${view} output backend`).toBe(backend);
    const control = backend === 'webgl' ? reading : reading.stage;
    if (backend === 'webgl') expect(reading.wideBackend, `${view} wide reference backend`).toBe(backend);
    if (!control) throw new Error('Canvas2D requires a same-sized stock viewport control');
    const { changed, alphaChanged, maxChannelDelta } = control;
    return { view, assertion: labels[view], changed, alphaChanged, maxChannelDelta };
  });
  const measurement = JSON.stringify({
    engine: info.project.name, backend, shift, limit, views,
    reference: backend === 'webgl' ? 'wide' : 'same-sized stock',
  });
  console.log(measurement);
  await info.attach('composed-crop-raster', { body: measurement, contentType: 'application/json' });
  for (const view of views) {
    expect(view.maxChannelDelta, view.assertion).toBeLessThanOrEqual(limit);
  }
}

test(check(1, 'canvas2d draws the first Pan frame in a fresh browser'), async ({ playwright, browserName, baseURL, viewport, deviceScaleFactor }) => {
  // The worker's browser fixture may have already rendered another test.
  const browser = await playwright[browserName].launch({ timeout: 15_000 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const page = await browser.newPage({ baseURL, viewport, deviceScaleFactor });
    await open(page);

    const first = await Promise.race([
      page.evaluate(async options => {
        const { composedTest } = window as ComposedHarnessWindow;
        await composedTest.mount(options);
        // Read the mounted canvas before driving the harness clock.
        return { mode: composedTest.state().mode, rgba: composedTest.renderedPixels() };
      }, mountOptions('canvas2d', { camera: 'pan' })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('COMPOSED_COLD_MOUNT_TIMEOUT: Pan mount and first frame readback exceeded 15000 ms')), 15_000);
      }),
    ]);

    const rgba = Buffer.from(first.rgba, 'base64');
    let opaque = 0;
    let colorVariation = false;
    for (let i = 0; i < rgba.length; i += 4) {
      opaque += Number(rgba[i + 3] === 255);
      colorVariation ||= rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] || rgba[i + 2] !== rgba[2];
    }
    expect(first.mode).toBe('pan');
    expect(rgba).toHaveLength(STAGE.width * STAGE.height * 4);
    expect(opaque, 'opaque first-frame pixels').toBe(STAGE.width * STAGE.height);
    expect(colorVariation, 'first frame has more than one color').toBe(true);
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
});

for (const backend of ['canvas2d', 'webgl'] as const) {
  test.describe(backend, () => {
    test.beforeEach(async ({ page }) => open(page));

    test(check(1, 'clamps Y-up pointer and smooths by elapsed time'), async ({ page }) => {
      const maximum = 12.8;
      const measurements = [];
      for (const schedule of [[40, 40, 40, 40, 40, 40], [17, 223]]) {
        await mount(page, backend, { camera: 'pan' });
        await point(page, 2, 2);
        for (const ms of schedule) await tick(page, ms);
        const { offsets, cameraExcursion } = await state(page);
        expect(cameraExcursion).toEqual({ x: maximum, y: maximum });
        const response = maximum * (1 - Math.exp(-2));
        closePoint(offsets.figure, { x: -response, y: response }, 'clamp Y-up elapsed');
        measurements.push({ schedule, offsets });
      }
      closePoint(measurements[0].offsets.figure, measurements[1].offsets.figure, 'equal elapsed');
      await point(page, 0.5, -0.5);
      await tick(page, 4000);
      closePoint((await state(page)).offsets.figure, { x: -6.4, y: -6.4 }, 'fractional pointer');
      console.log(JSON.stringify({ measurements }));
    });

    for (const event of ['pointerleave', 'pointercancel'] as const) {
      test(check(1, `${event} eases back to exact neutral`), async ({ page }) => {
        await mount(page, backend, { camera: 'pan' });
        await point(page, 1, -1);
        await tick(page, 4000);
        closePoint((await state(page)).offsets.figure, { x: -12.8, y: -12.8 }, 'extreme before reset');
        await reset(page, event);
        await tick(page, 120);
        closePoint((await state(page)).offsets.figure, { x: -12.8 / Math.E, y: -12.8 / Math.E }, event);
        await tick(page, 4000);
        const settled = (await state(page)).offsets;
        for (const plane of PLANES) {
          expect(settled[plane].x === 0 && settled[plane].y === 0, `${event} settled ${plane}`).toBe(true);
        }
      });
    }

    test(check(2, 'applies landed signed gains and anchors figure pixels'), async ({ page }) => {
      await mount(page, backend);
      await freeze(page, 2);
      await page.evaluate(slots => (window as ComposedHarnessWindow).composedTest.storeFigure(slots), SLOTS.figure);
      const base = (await draw(page)).order;
      const results = [];
      for (const mode of ['parallax', 'pan'] as const) {
        await setCamera(page, mode);
        for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          await point(page, x, y);
          const frame = await draw(page, 4000);
          const applied = (await state(page)).offsets;
          const expected = offsets({ x: x * 12.8, y: y * 12.8 }, mode);
          expect(frame.backend).toBe(backend);
          for (const plane of PLANES) closePoint(applied[plane], expected[plane], `${mode} gains ${plane}`);
          for (const [i, slot] of frame.order.entries()) {
            const plane = PLANES.find(plane => (SLOTS[plane] as readonly string[]).includes(slot.slot))!;
            for (const [j, coordinate] of slot.coords.entries()) {
              expect(coordinate - base[i].coords[j], `${mode} posed geometry ${slot.slot} coordinate ${j}`)
                .toBeCloseTo(j % 2 ? -expected[plane].y : expected[plane].x, 7);
            }
          }
          const figure = await page.evaluate(slots => (window as ComposedHarnessWindow).composedTest.compareFigure(slots), SLOTS.figure);
          expect(figure.nonOpaque).toBeLessThan(128 * 128);
          if (mode === 'parallax') expect(figure.changed, 'anchored figure RGBA').toBe(0);
          else expect(figure.changed, 'Pan moves actor pixels').toBeGreaterThan(0);
          results.push({ mode, excursion: { x: x * 12.8, y: y * 12.8 }, applied, figure: figure.changed });
        }
      }
      console.log(JSON.stringify({ results }));
    });

    test(check(3, 'Fixed and settled neutral match ordinary RGBA at equal take times'), async ({ page }) => {
      await mount(page, backend);
      expect((await state(page)).mode).toBe('fixed');
      await ordinary(page, backend, model('overscan'));
      const readings = [];
      const positions: number[][] = [];
      for (const time of [0, 2]) {
        await setCamera(page, 'fixed');
        await freeze(page, time);
        const fixedDraw = await draw(page);
        expect(fixedDraw.backend).toBe(backend);
        positions.push(fixedDraw.order.find(slot => slot.slot === 'foreground')!.coords);
        for (const mode of ['fixed', 'parallax', 'pan'] as const) {
          await setCamera(page, mode);
          await point(page, 1, 1);
          await tick(page, 4000);
          if (mode !== 'fixed') {
            await reset(page, 'pointercancel');
            await tick(page, 4000);
          }
          const result = await page.evaluate(time => (window as ComposedHarnessWindow).composedTest.fixedReference(time), time);
          expect(result.backend).toBe(backend);
          expect(result.changed, `${mode} ordinary RGBA at ${time}s`).toBe(0);
          readings.push({ time, mode, ...result });
        }
      }
      const foregroundX = positions[1].filter((_, i) => i % 2 === 0).map((value, i) => value - positions[0][i * 2]);
      for (const dx of foregroundX) expect(dx, 'authored foreground travels +3 px').toBeCloseTo(3, 7);
      console.log(JSON.stringify({ readings, foregroundX }));
    });

    test(check(4, 'identical source time and pose bytes across a loop wrap'), async ({ page }) => {
      async function run(moving: boolean) {
        await mount(page, backend, { camera: 'parallax' });
        const rows = [];
        // 62.5 ms is exactly representable, below Card 1's rig cap and divides
        // the four-second fixture loop exactly. Inspect one sample on each side.
        for (let i = 1; i <= 66; i++) {
          if (moving) await point(page, i % 4 < 2 ? -1 : 1, i % 3 ? 1 : -1);
          await tick(page, 62.5);
          if (i < 63) continue;
          const current = await state(page);
          const bytes = await page.evaluate(() => (window as ComposedHarnessWindow).composedTest.poseBytes());
          rows.push({ trackTime: current.trackTime, animationTime: current.animationTime, offsets: current.offsets, bytes });
        }
        return rows;
      }
      const still = await run(false);
      const moving = await run(true);
      expect(still.map(row => row.trackTime)).toEqual([3.9375, 4, 4.0625, 4.125]);
      expect(still.map(row => row.animationTime)).toEqual([3.9375, 0, 0.0625, 0.125]);
      const rows = still.map((row, i) => ({
        trackTime: row.trackTime, animationTime: row.animationTime, bytes: Buffer.byteLength(row.bytes),
        still: poseDigest(row.bytes), moving: poseDigest(moving[i].bytes), offsets: moving[i].offsets,
      }));
      console.log(JSON.stringify({ rows }));
      expect(moving.some(row => Math.abs(row.offsets.background.x) > 1), 'pointer advances the camera').toBe(true);
      for (const [i, row] of moving.entries()) {
        expect(row.trackTime, 'pointer-independent source clock').toBe(still[i].trackTime);
        expect(row.animationTime, 'pointer-independent wrapped clock').toBe(still[i].animationTime);
        expect(poseDigest(row.bytes), 'pointer-independent pose bytes').toBe(poseDigest(still[i].bytes));
      }
    });

    test(check(5, 'preserves complete model order, one mesh and optional foreground'), async ({ page }) => {
      await mount(page, backend, { camera: 'parallax' });
      await point(page, 1, 1);
      const full = await draw(page, 4000);
      const original = await page.evaluate(() => (window as ComposedHarnessWindow).composedTest.sourceGeometry());
      expect(original.map(row => row.slot)).toEqual(ORDER);
      expect(full.order.map(row => row.slot), 'exact draw order and one draw per slot').toEqual(ORDER);
      const actorBackdrop = full.order.find(row => row.slot === 'actor:background');
      expect(actorBackdrop, 'actor:background stays on the figure').toEqual(original[1]);
      expect(full.order.find(row => row.slot === 'actor:torso'), 'authored mesh retained').toMatchObject({
        kind: 'mesh', triangles: 40,
      });
      expect(full.order.find(row => row.slot === 'actor:torso')?.coords).toHaveLength(60);
      expect(full.backend).toBe(backend);
      await mount(page, backend, {
        modelUrl: await withoutForeground(page), slots: { background: SLOTS.background, figure: SLOTS.figure },
      });
      const without = await draw(page);
      expect(without.order.map(row => row.slot), 'foreground may be absent in the model').toEqual(ORDER.slice(0, -1));
      console.log(JSON.stringify({ backend, full: full.order.map(({ slot, kind, triangles }) => ({ slot, kind, triangles })), without: without.order.map(row => row.slot) }));
    });

    test(check(6, 'backdrop remains opaque at all envelope corners after relayout'), async ({ page }) => {
      await mount(page, backend);
      const results = [];
      for (const [width, height] of [[128, 128], [112, 96]]) {
        await page.evaluate(([w, h]) => (window as ComposedHarnessWindow).composedTest.layout(w, h), [width, height]);
        for (const mode of ['parallax', 'pan'] as const) {
          await setCamera(page, mode);
          for (const [x, y] of CORNERS) {
            await point(page, x, y);
            await tick(page, 4000);
            const current = await state(page);
            expect({ width: current.width, height: current.height }, 'actual resized viewport').toEqual({ width, height });
            const excursion = { x: x / 2 * width * 0.1, y: y / 2 * height * 0.1 };
            const applied = current.offsets.background;
            closePoint(applied, offsets(excursion, mode).background, 'relayout CSS envelope');
            const result = await backdrop(page);
            assertOpaque(result, backend);
            results.push({ cssWidth: width, cssHeight: height, mode, excursion, applied, ...result });
          }
        }
      }
      console.log(JSON.stringify({ results }));
    });

    test(check(6, 'allows horizontal-only movement with zero bottom overscan'), async ({ page }) => {
      const modelUrl = await alterModel(page, 'zero-bottom', doc => {
        const plate = doc.skins[0].attachments.backdrop.backdrop as { height: number; y: number };
        plate.height = 143;
        plate.y = 71.5;
      });
      await mount(page, backend, { modelUrl });
      const posed = (await draw(page)).order.find(slot => slot.slot === 'backdrop')!;
      expect(Math.min(...posed.coords.filter((_, i) => i % 2 === 1)), 'authored plate meets the stage bottom').toBe(STAGE.y);
      for (const mode of ['parallax', 'pan'] as const) {
        const refusal = await setCamera(page, mode).then(() => '', error => String(error));
        expect(refusal).toContain('COMPOSED_BACKDROP_COVERAGE:');
        expect(refusal).toContain('camera excursion 12.8 × 12.8 CSS px');
        expect(refusal).toContain('available geometric overscan left=15, right=15, top=15, bottom=0 CSS px');
        expect(refusal).toContain('uncovered geometric edges bottom');
        expect((await state(page)).mode).toBe('fixed');
        console.log(JSON.stringify({ backend, mode, refusal }));
      }

      const excursion = { x: 14, y: 0 };
      await mount(page, backend, { modelUrl, maxDisplacement: excursion });
      const results = [];
      for (const mode of ['parallax', 'pan'] as const) {
        await setCamera(page, mode);
        for (const [x, y] of CORNERS) {
          await point(page, x, y);
          await tick(page, 4000);
          const current = await state(page);
          expect(current.mode).toBe(mode);
          expect(current.refusal).toBeUndefined();
          expect(current.cameraExcursion).toEqual(excursion);
          const expected = offsets({ x: Math.sign(x) * excursion.x, y: 0 }, mode);
          for (const plane of PLANES) {
            closePoint(current.offsets[plane], expected[plane], `${mode} horizontal ${plane} shift`);
            expect(current.offsets[plane].y === 0, `${mode} keeps ${plane} vertical shift at zero`).toBe(true);
          }
          const plate = await backdrop(page);
          assertOpaque(plate, backend);
          results.push({ mode, pointer: { x, y }, excursion, applied: current.offsets, backdrop: plate });
        }
      }
      console.log(JSON.stringify({ backend, results }));
    });

    test(check(6, 'explicit CSS excursion bypasses the default cap and applies plane gain after'), async ({ page }) => {
      // Non-unit layout converts the same world plate to CSS overscan. Stretch
      // x only, so the figure's y and the stage crop remain easy to read.
      await page.evaluate(() => (window as ComposedHarnessWindow).composedTest.layout(768, 480));
      await mount(page, backend, { camera: 'parallax' });
      for (const mode of ['parallax', 'pan'] as const) {
        await setCamera(page, mode);
        await point(page, 2, 2);
        await tick(page, 4000);
        const current = await state(page);
        const capped = { x: 64, y: 40 };
        expect(current.cameraExcursion, 'landed CSS excursion cap').toEqual(capped);
        closePoint(current.offsets.background, offsets(capped, mode).background, 'capped plane shift');
        assertOpaque(await backdrop(page), backend);
        console.log(JSON.stringify({ mode, width: current.width, height: current.height, excursion: capped, offsets: current.offsets }));
      }
      await mount(page, backend, { camera: 'parallax', maxDisplacement: { x: 160, y: 0 } });
      await point(page, 2, 2);
      await tick(page, 4000);
      const current = await state(page);
      const excursion = { x: 160, y: 0 };
      expect(current.cameraExcursion, 'explicit CSS excursion preserved').toEqual(excursion);
      closePoint(current.offsets.background, offsets(excursion, 'parallax').background, 'explicit CSS excursion');
      assertOpaque(await backdrop(page), backend);
      console.log(JSON.stringify({ mode: 'parallax', width: current.width, height: current.height, excursion, offsets: current.offsets }));
      await mount(page, backend, { camera: 'pan', maxDisplacement: { x: 88, y: 0 } });
      await point(page, 2, 2);
      await tick(page, 4000);
      const pan = await state(page);
      expect(pan.cameraExcursion).toEqual({ x: 88, y: 0 });
      closePoint(pan.offsets.background, { x: -88, y: 0 }, 'explicit Pan shift');
      assertOpaque(await backdrop(page), backend);
      console.log(JSON.stringify({ mode: 'pan', width: pan.width, height: pan.height, excursion: pan.cameraExcursion, offsets: pan.offsets }));
    });

    test(check(7, 'crops full authored geometry only after Pan at both horizontal extremes'), async ({ page }, info) => {
      const url = model('clip');
      await mount(page, backend, { modelUrl: url, camera: 'pan', maxDisplacement: { x: 12, y: 12 } });
      await ordinary(page, backend, url);
      await freeze(page, 2);
      const results = [];
      for (const x of [-1, 1]) {
        await point(page, x, 0);
        const drawn = await draw(page, 4000);
        expect(drawn.viewport, 'viewport is original stage').toEqual(STAGE);
        const shift = { x: -x * 12, y: 0 };
        const result = await page.evaluate(({ shift, figure }) =>
          (window as ComposedHarnessWindow).composedTest.cropReference(2, shift, figure), { shift, figure: SLOTS.figure });
        await expectCropRaster(result, backend, shift, info, {
          scene: 'stage crop RGBA', actor: 'isolated full-geometry crop RGBA',
        });
        const input = result.source.find(row => row.slot === 'actor:background')!;
        expect(Math.min(...input.coords.filter((_, i) => i % 2 === 0)), 'authored left spill reaches outside stage').toBeLessThan(-64);
        expect(drawn.order.map(row => row.slot)).toEqual(result.source.map(row => row.slot));
        for (const [i, row] of drawn.order.entries()) {
          const source = result.source[i].coords;
          expect(row.coords).toHaveLength(source.length);
          for (const [j, value] of row.coords.entries()) {
            expect(value - source[j], `stage crop keeps full ${row.slot} geometry`)
              .toBeCloseTo(j % 2 ? -shift.y : shift.x, 7);
          }
        }
        if (x === -1) expect(result.earlyCrop.alphaChanged, 'early crop must erase a visible strip').toBeGreaterThan(500);
        results.push({ pointerX: x, excursion: { x: x * 12, y: 0 }, shift, earlyCrop: result.earlyCrop });
      }
      console.log(JSON.stringify({ results }));
    });

    test(check(7, 'moves an authored attachment polygon with its plane'), async ({ page }) => {
      test.setTimeout(15_000);
      const url = await attachmentClip(page, false);
      await mount(page, backend, { modelUrl: url, maxDisplacement: { x: 12, y: 12 } });
      await freeze(page, 2);
      const base = await draw(page);
      await setCamera(page, 'pan');
      const baselineClips = base.order.filter(slot => slot.clip);
      expect(baselineClips.map(slot => slot.slot), 'only the six figure draw slots share the clip').toEqual(SLOTS.figure);
      expect(new Set(baselineClips.map(slot => slot.clip?.id)).size).toBe(1);
      expect(base.clipCount).toBe(1);
      await point(page, -1, 1);
      const moved = await draw(page, 4000);
      expect(moved.clipCount).toBe(1);
      const shift = { x: 12, y: 12 };
      const drawn = moved.order.filter(slot => slot.clip);
      expect(drawn.map(slot => slot.slot)).toEqual(SLOTS.figure);
      expect(new Set(drawn.map(slot => slot.clip?.id)).size, 'single shared clip after displacement').toBe(1);
      for (const [i, slot] of drawn.entries()) {
        for (const [j, value] of slot.clip!.polygon.entries()) {
          expect(value - baselineClips[i].clip!.polygon[j], 'polygon and figure move together').toBeCloseTo(j % 2 ? -shift.y : shift.x, 7);
        }
      }
    });

    test(check(7, 'renders the displaced attachment clip against stock'), async ({ page }, info) => {
      const url = await attachmentClip(page, false);
      await mount(page, backend, { modelUrl: url, maxDisplacement: { x: 12, y: 12 } });
      await ordinary(page, backend, url);
      await freeze(page, 2);
      await setCamera(page, 'pan');
      await point(page, -1, 1);
      await tick(page, 4000);
      const shift = { x: 12, y: 12 };
      const result = await page.evaluate(({ shift, figure }) =>
        (window as ComposedHarnessWindow).composedTest.cropReference(2, shift, figure), { shift, figure: SLOTS.figure });
      await expectCropRaster(result, backend, shift, info, {
        scene: 'attachment clip scene RGBA', actor: 'attachment clip isolated figure RGBA',
      });
      expect(result.alpha.transparent).toBeGreaterThan(0);
    });

    if (backend === 'canvas2d') {
      test(check(7, 'preserves stock Canvas2D attachment clip RGBA at zero displacement'), async ({ page }, info) => {
        // Use the stock camera from the displaced clip comparison, baked into
        // the model's stage so both renderers draw untranslated geometry.
        const viewport = { ...STAGE, x: STAGE.x - 12, y: STAGE.y + 12 };
        const url = await attachmentClip(page, false, viewport);
        const zero = { x: 0, y: 0 };
        await mount(page, backend, { modelUrl: url, maxDisplacement: zero });
        await ordinary(page, backend, url);
        await freeze(page, 2);
        await setCamera(page, 'pan');
        const current = await state(page);
        expect(current.mode).toBe('pan');
        expect(current.offsets).toEqual({ background: zero, figure: zero, foreground: zero });

        const views = await page.evaluate(figure =>
          (window as ComposedHarnessWindow).composedTest.stockClipReference(2, figure), SLOTS.figure);
        const measurement = JSON.stringify({ engine: info.project.name, backend, shift: zero, limit: 0, views });
        console.log(measurement);
        await info.attach('composed-stock-clip-raster', { body: measurement, contentType: 'application/json' });

        for (const view of views) {
          expect(view.viewport, `${view.view} viewport`).toEqual(viewport);
          expect([view.width, view.height], `${view.view} backing size`).toEqual([viewport.width, viewport.height]);
          expect(view.backends, `${view.view} backends`).toEqual([backend, backend]);
          expect(view.clipCounts, `${view.view} applied clips`).toEqual([1, 1]);
          expect(view.reused, `${view.view} freshly drawn`).toEqual([0, 0]);
          if (view.view === 'figure') {
            expect(view.transparent, 'figure has a transparent surround').toBeGreaterThan(0);
            expect(view.transparent, 'figure has visible pixels').toBeLessThan(view.width * view.height);
          } else {
            expect(view.nonOpaque, 'scene has opaque backdrop coverage').toBe(0);
          }
          expect.soft(view.changed, `stock Canvas2D ${view.view} RGBA`).toBe(0);
        }
      });
    }

    const refusals: {
      name: string;
      code: string;
      options: (page: Page) => Partial<MountOptions> | Promise<Partial<MountOptions>>;
    }[] = [
      { name: 'missing stage', code: 'COMPOSED_STAGE_REQUIRED',
        options: async page => ({ modelUrl: await alterModel(page, 'without-stage', doc => { doc.stage = null; }) }) },
      { name: 'absent stage section', code: 'COMPOSED_STAGE_REQUIRED',
        options: async page => ({ modelUrl: await alterModel(page, 'missing-stage-section', doc => { delete doc.stage; }) }) },
      { name: 'loop disabled', code: 'COMPOSED_LOOP_REQUIRED', options: () => ({ loop: false as true }) },
      { name: 'named animation missing', code: 'COMPOSED_LOOP_REQUIRED', options: () => ({ animation: 'absent-loop' }) },
      { name: 'missing actor slot', code: 'COMPOSED_SLOT_PARTITION',
        options: () => ({ slots: { ...SLOTS, figure: SLOTS.figure.slice(1) } }) },
      { name: 'unknown slot', code: 'COMPOSED_SLOT_PARTITION',
        options: () => ({ slots: { ...SLOTS, figure: [...SLOTS.figure, 'actor:unknown'] } }) },
      { name: 'duplicate slot', code: 'COMPOSED_SLOT_PARTITION',
        options: () => ({ slots: { ...SLOTS, foreground: ['foreground', 'actor:torso'] } }) },
      { name: 'unbound existing foreground', code: 'COMPOSED_SLOT_PARTITION',
        options: () => ({ slots: { background: SLOTS.background, figure: SLOTS.figure } }) },
      { name: 'shared cross-plane clip', code: 'COMPOSED_CROSS_PLANE_CLIP',
        options: async page => ({ modelUrl: await attachmentClip(page, true) }) },
      { name: 'transparent backdrop', code: 'COMPOSED_BACKDROP_COVERAGE',
        options: async page => ({ camera: 'pan', modelUrl: await transparentPlate(page) }) },
      { name: 'original zero-padding backdrop', code: 'COMPOSED_BACKDROP_COVERAGE',
        options: () => ({ camera: 'parallax', modelUrl: model('original') }) },
      { name: 'short backdrop X axis', code: 'COMPOSED_BACKDROP_COVERAGE',
        options: async page => ({ camera: 'pan', modelUrl: await shortPlate(page, 'x') }) },
      { name: 'short backdrop Y axis', code: 'COMPOSED_BACKDROP_COVERAGE',
        options: async page => ({ camera: 'pan', modelUrl: await shortPlate(page, 'y') }) },
      { name: 'negative explicit excursion', code: 'COMPOSED_INVALID_DISPLACEMENT',
        options: () => ({ maxDisplacement: { x: -1, y: 0 } }) },
      { name: 'unknown camera mode', code: 'COMPOSED_INVALID_CAMERA',
        options: () => ({ camera: 'absent' as Mode }) },
    ];

    for (const { name, code, options } of refusals) {
      test(check(8, `refuses ${name}`), async ({ page }) => {
        test.setTimeout(15_000);
        const overrides = await options(page);
        const refusal = await mount(page, backend, overrides).then(() => '', error => String(error));
        console.log(JSON.stringify({ backend, name, refusal }));
        expect(refusal, `named refusal for ${name}`).toContain(`${code}:`);
        if (name === 'transparent backdrop') {
          expect(refusal).toContain('available geometric overscan left=15, right=15, top=15, bottom=15 CSS px');
          expect(refusal).toMatch(/\b[1-9]\d* envelope pixels have alpha below 255/);
        }
        if (name === 'short backdrop X axis' || name === 'short backdrop Y axis') {
          const shortX = name.includes('X axis');
          expect(refusal).toContain('requested shift per edge X=12.8, Y=12.8 CSS px');
          expect(refusal).toContain(shortX
            ? 'available geometric overscan left=9, right=9, top=15, bottom=15 CSS px'
            : 'available geometric overscan left=15, right=15, top=9, bottom=9 CSS px');
          expect(refusal).toContain(shortX ? 'uncovered geometric edges left, right' : 'uncovered geometric edges top, bottom');
        }
        await expect(page.locator('#stage canvas')).toHaveCount(0);
      });
    }

    test(check(8, 'refuses non-finite explicit excursion on either axis'), async ({ page }) => {
      const controls = [
        { name: 'Infinity on X', maxDisplacement: { x: Infinity, y: 0 } },
        { name: 'NaN on Y', maxDisplacement: { x: 0, y: NaN } },
      ];
      for (const { name, maxDisplacement } of controls) {
        const refusal = await mount(page, backend, { maxDisplacement }).then(() => '', error => String(error));
        console.log(JSON.stringify({ backend, name, refusal }));
        expect(refusal, name).toContain('COMPOSED_INVALID_DISPLACEMENT:');
        await expect(page.locator('#stage canvas')).toHaveCount(0);
      }
    });

    test(check(8, 'original stays available in Fixed and refuses both camera modes'), async ({ page }) => {
      await mount(page, backend, { modelUrl: model('original') });
      await ordinary(page, backend, model('original'));
      await freeze(page, 2);
      const fixed = await page.evaluate(() => (window as ComposedHarnessWindow).composedTest.fixedReference(2));
      expect(fixed.changed).toBe(0);
      for (const [width, height, x, y] of [[128, 128, 12.8, 12.8], [1744, 480, 64, 40]]) {
        await page.evaluate(([width, height]) => (window as ComposedHarnessWindow).composedTest.layout(width, height), [width, height]);
        for (const mode of ['parallax', 'pan'] as const) {
          const refusal = await setCamera(page, mode).then(() => '', error => String(error));
          expect(refusal, `named refusal when selecting ${mode}`).toContain('COMPOSED_BACKDROP_COVERAGE:');
          expect(refusal).toContain(`${mode} at ${width} × ${height} CSS px`);
          expect(refusal).toContain(`camera excursion ${x} × ${y} CSS px`);
          const requested = mode === 'pan' ? { x, y } : { x: Number((x * 0.55).toPrecision(6)), y: Number((y * 0.55).toPrecision(6)) };
          expect(refusal).toContain(`requested shift per edge X=${requested.x}, Y=${requested.y} CSS px`);
          expect(refusal).toContain('available geometric overscan left=0, right=0, top=0, bottom=0 CSS px');
          expect((await state(page)).mode).toBe('fixed');
          console.log(JSON.stringify({ backend, mode, refusal, fixed }));
        }
      }
    });

    test(check(8, 'revalidates an explicit envelope after destructive relayout'), async ({ page }) => {
      await page.evaluate(() => (window as ComposedHarnessWindow).composedTest.layout(768, 480));
      await mount(page, backend, { camera: 'parallax', maxDisplacement: { x: 120, y: 0 } });
      await point(page, 2, 0);
      await tick(page, 4000);
      expect((await state(page)).mode).toBe('parallax');
      await page.evaluate(() => (window as ComposedHarnessWindow).composedTest.layout(128, 128));
      await expect.poll(async () => (await state(page)).refusal).toBe('COMPOSED_BACKDROP_COVERAGE');
      const result = await state(page);
      expect(result.cameraExcursion).toEqual({ x: 120, y: 0 });
      expect(result.mode).toBe('fixed');
      expect(result.refusalMessage).toContain('requested shift per edge X=66, Y=0 CSS px');
      expect(result.refusalMessage).toContain('available geometric overscan left=15, right=15, top=15, bottom=15 CSS px');
      expect(result.offsets.background).toEqual({ x: 0, y: 0 });
      console.log(JSON.stringify({ backend, result }));
    });

    test(check(9, 'accepts a small tables overlay and preserves four named planes'), async ({ page }) => {
      const modelUrl = await fourPlaneModel(page);
      // A half-width pointer step gives integer raster translations with all
      // three gains, including the inferred 28/24 ratio.
      const rasterCap = { x: 480 / 11, y: 0 };
      await mountNamed(page, backend, modelUrl, { maxDisplacement: rasterCap });
      await ordinary(page, backend, modelUrl);
      await freeze(page, 0);
      const base = await draw(page);
      expect(base.order.map(row => row.slot), 'exact named draw order and one draw per slot').toEqual(NAMED_ORDER);
      expect(Object.keys((await state(page)).offsets).sort(), 'exact named plane IDs').toEqual([...NAMED_IDS].sort());
      const table = base.order[1];
      const reference = await page.evaluate(() => (window as ComposedHarnessWindow).composedTest.referenceGeometry(0));
      const authoredTable = reference.find(row => row.slot === TABLES_SLOT);
      expect(authoredTable?.kind, 'ordinary tables slot is a region').toBe('region');
      expect(table.kind, 'displayed tables slot is a region').toBe('region');
      // Compare absolute positions at Float32 precision before and after camera translation.
      const authored = authoredTable!.coords.map(Math.fround);
      expect(authored, 'authored tables quad has four corners').toHaveLength(8);
      expect(authored.every(Number.isFinite), 'authored tables corners are finite').toBe(true);
      const [blX, blY, ulX, ulY, , , brX, brY] = authored;
      const area = (ulX - blX) * (brY - blY) - (ulY - blY) * (brX - blX);
      expect(Math.abs(area), 'authored tables quad is nondegenerate').toBeGreaterThan(0);
      expect(table.coords, 'displayed tables quad has four corners').toHaveLength(8);
      for (const [i, expected] of authored.entries()) {
        expect(Math.fround(table.coords[i]), `tables authored coordinate ${i} without auto-fit`).toBe(expected);
      }
      await point(page, 1, 1, 'pointerenter');
      await tick(page, 120);

      for (const direction of [-1, 1]) {
        await point(page, direction / 2, direction * 2);
        const current = await draw(page, 4000);
        const reading = await state(page);
        expect(reading.mode).toBe('parallax');
        expect(reading.refusal).toBeUndefined();
        expect(reading.cameraExcursion).toEqual(rasterCap);
        expect(current.viewport, 'original stage with no auto-fit').toEqual(STAGE);
        expect(current.order.map(row => row.slot), 'exact named draw order and one draw per slot').toEqual(NAMED_ORDER);
        const shifts = { backdrop: 12 * direction, tables: 14 * direction, figure: 0, foreground: -12 * direction };
        const controls = NAMED_IDS.map(id => ({ slots: NAMED_PLANES[id].slots, shift: { x: shifts[id], y: 0 } }));
        for (const [i, id] of NAMED_IDS.entries()) {
          closePoint(reading.offsets[id], controls[i].shift, `named ${id} gain`);
          for (const [slotIndex, slot] of current.order.entries()) {
            if (!(controls[i].slots as readonly string[]).includes(slot.slot)) continue;
            expect(slot.z).toBe(base.order[slotIndex].z);
            for (const [coordinate, value] of slot.coords.entries()) {
              const expected = base.order[slotIndex].coords[coordinate] + (coordinate % 2 ? 0 : shifts[id]);
              expect(Math.fround(value), `${id} ${slot.slot} coordinate ${coordinate}`).toBe(Math.fround(expected));
            }
          }
        }

        const rasters = await page.evaluate(controls =>
          (window as ComposedHarnessWindow).composedTest.planeReferences(0, controls), controls);
        for (const [i, raster] of rasters.entries()) {
          const id = NAMED_IDS[i];
          expect([raster.actualBackend, raster.referenceBackend], `${id} backends`).toEqual([backend, backend]);
          expect(raster.maxChannelDelta, `named ${id} stock RGBA`).toBeLessThanOrEqual(backend === 'webgl' ? 0 : 4);
        }
        assertOpaque({ ...rasters[0], backend: rasters[0].actualBackend }, backend);
        const size = 128 * 128;
        expect(rasters[1].transparent, 'small tables leave most of the isolated stage empty').toBeGreaterThan(size - 13 * 13);
        expect(rasters[1].transparent, 'small tables have visible pixels').toBeLessThan(size);
        expect(rasters[3].transparent, 'true foreground has visible pixels').toBeLessThan(size);
        expect(current.alpha.nonOpaque, 'opaque backdrop fills uncovered overlay pixels').toBe(0);
        const foreground = await page.evaluate(slot => (window as ComposedHarnessWindow).composedTest.compareWithout(slot), 'foreground');
        expect(foreground.changed, 'true foreground contributes to composed pixels').toBeGreaterThan(0);
      }
    });

    test(check(9, 'scales inherited tables gain with an explicit backdrop gain'), async ({ page }) => {
      const modelUrl = await fourPlaneModel(page);
      const planes = { ...NAMED_PLANES, backdrop: { ...NAMED_PLANES.backdrop, gain: -0.375 } };
      await mountNamed(page, backend, modelUrl, { planes });
      await freeze(page, 0);
      await point(page, 0, 0, 'pointerenter');
      const base = await draw(page, 120);
      for (const direction of [-1, 1]) {
        await point(page, direction, 0);
        const current = await draw(page, 4000);
        const reading = await state(page);
        expect(reading.mode).toBe('parallax');
        expect(reading.refusal).toBeUndefined();
        closePoint(reading.cameraTarget, { x: 64 * direction, y: 0 }, 'explicit backdrop gain camera target');
        for (const [id, distance, label] of [
          ['backdrop', 24, 'explicit backdrop gain'], ['tables', 28, 'inherited tables gain with backdrop override'],
        ] as const) {
          const shift = distance * direction;
          closePoint(reading.offsets[id], { x: shift, y: 0 }, label);
          const before = base.order.find(row => row.slot === id)!;
          const after = current.order.find(row => row.slot === id)!;
          for (const [i, value] of after.coords.entries()) {
            expect(value - before.coords[i], `${label} rendered coordinate ${i}`).toBeCloseTo(i % 2 ? 0 : shift, 6);
          }
        }
      }
    });

    test(check(9, 'refuses to infer gain for an opposite tables X track'), async ({ page }) => {
      const modelUrl = await fourPlaneModel(page, 'opposite-tables-track');
      const refusal = await mountNamed(page, backend, modelUrl).then(() => '', error => String(error));
      expect(refusal).toContain('COMPOSED_PLATE_TRACK:');
      expect(refusal).toContain('plane "tables" needs an explicit gain');
      expect(refusal).toContain('backdrop plane "backdrop"');
      await expect(page.locator('#stage canvas')).toHaveCount(0);
    });

    test(check(9, 'accepts a covered base hole behind the figure'), async ({ page }) => {
      const modelUrl = await fourPlaneModel(page, 'covered-hole');
      await mountNamed(page, backend, modelUrl, { planes: COMPOSITE_PLANES, maxDisplacement: { x: 16, y: 0 } });
      await point(page, 0, 0, 'pointerenter');
      await tick(page, 120);

      for (const direction of [0, -1, 1]) {
        await point(page, direction, 0);
        const current = await draw(page, 4000);
        const reading = await state(page);
        expect(reading.mode, 'covered base hole keeps Parallax active').toBe('parallax');
        expect(reading.refusal).toBeUndefined();
        expect(current.order.map(row => row.slot), 'covering overlay draws behind the figure').toEqual(NAMED_ORDER);
        const shift = { x: 8 * direction, y: 0 };
        closePoint(reading.offsets.backdrop, shift, 'base hole translation');
        closePoint(reading.offsets.tables, shift, 'covering overlay translation');
        const result = await page.evaluate(({ x, layers }) =>
          (window as ComposedHarnessWindow).composedTest.layerPixels({ x, y: 64 }, layers), {
          x: 64 + shift.x,
          layers: [SLOTS.background, [TABLES_SLOT], COMPOSITE_SLOTS, SLOTS.figure],
        });
        const [base, overlay, composite, figure] = result.layers;
        expect(base[3], 'base has a real alpha hole').toBe(0);
        expect(overlay[3], 'overlay is opaque at the hole').toBe(255);
        expect(composite, 'overlay fills the hole without figure pixels').toEqual(overlay);
        expect(figure[3], 'figure is opaque at the overlap').toBe(255);
        expect(figure, 'figure and overlay have distinct pixels').not.toEqual(overlay);
        expect(result.full, 'figure occludes the overlay').toEqual(figure);
        const isolated = await page.evaluate(slots =>
          (window as ComposedHarnessWindow).composedTest.backdrop(slots), COMPOSITE_SLOTS);
        assertOpaque(isolated, backend);
      }
    });

    test(check(9, 'refuses a visible hole in the composited backdrop'), async ({ page }) => {
      const modelUrl = await fourPlaneModel(page, 'visible-hole');
      const refusal = await mountNamed(page, backend, modelUrl, {
        planes: COMPOSITE_PLANES, maxDisplacement: { x: 16, y: 0 },
      }).then(() => '', error => String(error));
      expect(refusal, 'visible composited backdrop hole refusal').toContain('COMPOSED_BACKDROP_COVERAGE:');
      expect(refusal, 'refusal identifies the backdrop').toContain('plane "backdrop"');
      expect(refusal, 'composited backdrop has non-opaque pixels').toMatch(NAMED_ALPHA_HOLE);
      await expect(page.locator('#stage canvas')).toHaveCount(0);
    });

    for (const [defect, plate, detail] of [
      ['alpha-hole', 'backdrop', NAMED_ALPHA_HOLE],
      ['left-edge', 'backdrop', /uncovered geometric edges left\b/],
      ['tables-edge', 'tables', /invalid quad at (left|top|right|bottom) edge/],
    ] as const) {
      const label = `named ${plate} ${defect}`;
      test(check(9, `refuses the ${label}`), async ({ page }) => {
        const modelUrl = await fourPlaneModel(page, defect);
        const refusal = await mountNamed(page, backend, modelUrl).then(() => '', error => String(error));
        expect(refusal, `${label} refusal`).toContain('COMPOSED_BACKDROP_COVERAGE:');
        expect(refusal, 'refusal identifies the plate').toContain(`plane "${plate}"`);
        expect(refusal, `${label} detail`).toMatch(detail);
        await expect(page.locator('#stage canvas')).toHaveCount(0);
      });
    }

    test(check(9, 'refuses an invalid named slot partition'), async ({ page }) => {
      const modelUrl = await fourPlaneModel(page);
      const { foreground, ...withoutForeground } = NAMED_PLANES;
      for (const [planes, label] of [
        [withoutForeground, 'unbound drawable slots foreground'],
        [{ ...NAMED_PLANES, tables: { ...NAMED_PLANES.tables, slots: foreground.slots } }, 'duplicate slot "foreground"'],
      ] as const) {
        const refusal = await mountNamed(page, backend, modelUrl, { planes }).then(() => '', error => String(error));
        expect(refusal, 'named slot partition refusal').toContain('COMPOSED_SLOT_PARTITION:');
        expect(refusal).toContain(label);
        await expect(page.locator('#stage canvas')).toHaveCount(0);
      }
    });

    test(check(10, 'centers on enter and returns to the live baked phase'), async ({ page }) => {
      const modelUrl = await fourPlaneModel(page, 'live-physics');
      await mountNamed(page, backend, modelUrl, { transitionMs: 125 });
      await ordinary(page, backend, modelUrl);
      const bones = ['actor:body_ctl', 'actor:body_yaw_dial', 'actor:body'];
      const reference = async (frames: number) => {
        const check = await page.evaluate(({ frames, bones }) => {
          const rig = (window as ComposedHarnessWindow).composedTest;
          for (let i = 0; i < frames; i++) rig.tick(31.25);
          return { current: rig.livePose(bones), stock: rig.liveReference(frames, 31.25, bones) };
        }, { frames, bones });
        expect(check.current.trackTime, 'live source clock').toBe(check.stock.trackTime);
        expect(check.current.animationTime, 'live wrapped source clock').toBe(check.stock.animationTime);
        expect(poseDigest(check.current.bytes), 'live stock pose bytes through camera handoff').toBe(poseDigest(check.stock.bytes));
        expect(check.current.bones).toEqual(check.stock.bones);
        return check.current;
      };
      const source = () => page.evaluate(() => (window as ComposedHarnessWindow).composedTest.sourceGeometry());
      const setupAtStart = (await draw(page)).order;
      const start = await reference(0);
      const automatic = await reference(16);
      expect(automatic.trackTime).toBe(0.5);
      expect(automatic.bones[0].y).not.toBe(start.bones[0].y);
      expect(automatic.bones[1].rotationX).not.toBe(start.bones[1].rotationX);
      expect(Math.abs(automatic.bones[2].x - automatic.bones[0].x), 'physics moves the body off the controller origin').toBeGreaterThan(0.01);
      expect((await draw(page)).order, 'automatic preserves authored plate and figure geometry').toEqual(await source());

      await point(page, 2, -2, 'pointerenter');
      await point(page, 2, -2);
      await reference(2);
      const acquiring = await state(page);
      closePoint(acquiring.offsets.backdrop, { x: 0.5625 * 24 / 2, y: 0 }, 'enter blends the live backdrop toward center');
      closePoint(acquiring.offsets.tables, { x: 0.5625 * 28 / 2, y: 0 }, 'enter blends the live tables toward center');
      await reference(2);
      const centered = await draw(page);
      const centeredSource = await source();
      for (const index of [0, 1]) {
        expect(centered.order[index], 'center rendered before applying the pointer').toEqual(setupAtStart[index]);
        expect(centeredSource[index], 'baked source keeps running behind the center').not.toEqual(setupAtStart[index]);
      }
      expect(centered.order.slice(2), 'live figure and foreground remain in the composed frame').toEqual(centeredSource.slice(2));

      await reference(8);
      const tracking = await state(page);
      expect(tracking.trackTime).toBe(0.875);
      expect(tracking.cameraExcursion).toEqual({ x: 64, y: 0 });
      closePoint(tracking.cameraTarget, { x: 64, y: 0 }, 'positive horizontal pointer cap');
      const cameraX = 64 * (1 - Math.exp(-0.25 / 0.12));
      closePoint(tracking.offsets.backdrop, { x: 0.55 * cameraX, y: 0 }, 'pointer-only backdrop');
      closePoint(tracking.offsets.tables, { x: 0.55 * cameraX * 28 / 24, y: 0 }, 'pointer-only tables');
      closePoint(tracking.offsets.figure, { x: 0, y: 0 }, 'focal figure');

      await point(page, -2, 2);
      closePoint((await state(page)).cameraTarget, { x: -64, y: 0 }, 'negative horizontal pointer cap');

      await reset(page, 'pointerleave');
      await reference(2);
      const releasing = await state(page);
      closePoint(releasing.offsets.backdrop, { x: (tracking.offsets.backdrop.x + 0.9375 * 24) / 2, y: 0 }, 'leave blends toward the advancing backdrop');
      closePoint(releasing.offsets.tables, { x: (tracking.offsets.tables.x + 0.9375 * 28) / 2, y: 0 }, 'leave blends toward the advancing tables');
      const released = await reference(2);
      expect(released.trackTime).toBe(1);
      expect((await draw(page)).order, 'leave reaches the current baked phase').toEqual(await source());
      await reference(8);
      expect((await draw(page)).order, 'automatic keeps following the live baked phase').toEqual(await source());
    });

    test('#282 no-dial opt-in preserves the #278 handoff and pixels', async ({ page }) => {
      const modelUrl = await fourPlaneModel(page, 'no-dials');
      const run = async (pointerTurn?: false) => {
        await mountNamed(page, backend, modelUrl, { pointerTurn, maxDisplacement: undefined, transitionMs: 125 });
        return page.evaluate(() => {
          const rig = (window as ComposedHarnessWindow).composedTest;
          const sample = (ms = 0) => ({ draw: rig.draw(ms), state: rig.state(), rgba: rig.renderedPixels() });
          for (let i = 0; i < 8; i++) rig.tick(62.5);
          const outside = sample();
          rig.point(1, 1, 'pointerenter');
          const entering = sample(62.5);
          const centered = sample(62.5);
          const hover = sample(62.5);
          rig.reset('pointerleave');
          const leaving = sample(62.5);
          const released = sample(62.5);
          return { outside, entering, centered, hover, leaving, released, reads: rig.turnReadouts() };
        });
      };
      const stock = await run(false);
      const actual = await run();
      expect(actual.reads).toEqual([]);
      for (const phase of ['outside', 'entering', 'centered', 'hover', 'leaving', 'released'] as const) {
        expect(actual[phase].state, phase).toEqual(stock[phase].state);
        expect(actual[phase].draw.backend, phase).toBe(backend);
        expect(float32Geometry(actual[phase].draw.order), phase).toEqual(float32Geometry(stock[phase].draw.order));
        expect(actual[phase].rgba === stock[phase].rgba, `${phase} exact RGBA`).toBe(true);
      }
      closePoint(stock.outside.state.offsets.backdrop, { x: 12, y: 0 }, '#278 baked plate');
      closePoint(stock.entering.state.offsets.backdrop, { x: 6.75, y: 0 }, '#278 acquisition midpoint');
      closePoint(stock.centered.state.offsets.backdrop, { x: 0, y: 0 }, '#278 acquisition endpoint');
      expect(stock.hover.state.cameraExcursion).toEqual({ x: 12.8, y: 12.8 });
      const hoverX = 0.55 * 12.8 * (1 - Math.exp(-0.0625 / 0.12));
      closePoint(stock.hover.state.offsets.backdrop, { x: hoverX, y: -hoverX }, '#278 tracking');
      closePoint(stock.leaving.state.offsets.backdrop, { x: (hoverX + 24 * 0.75) / 2, y: -hoverX / 2 }, '#278 release midpoint');
      closePoint(stock.released.state.offsets.backdrop, { x: 24 * 0.8125, y: 0 }, '#278 live release');
    });

    test('#282 reaches both ends of yaw, body and pitch without vertical camera motion', async ({ page }) => {
      const modelUrl = await fourPlaneModel(page, 'turn-dials');
      await mountNamed(page, backend, modelUrl, { pointerTurn: undefined, transitionMs: 125, maxDisplacement: { x: 64, y: 8 } });
      await ordinary(page, backend, modelUrl);
      await freeze(page, 0.5);
      await point(page, 0, 0, 'pointerenter');
      const centered = await draw(page, 125);
      await expectDials(page, centered.order, 0.5, [0, 0, 0], 'stage center');

      for (const sign of [-1, 1]) {
        await point(page, sign, 0);
        const horizontal = await draw(page, 6000);
        await expectDials(page, horizontal.order, 0.5, [sign * 8, 0, sign * 32], 'horizontal edge');
        expect(await turnReadouts(page)).toHaveLength(3);
        expect(figureGeometry(horizontal.order)).not.toEqual(figureGeometry(centered.order));
        const camera = (await state(page)).offsets;
        closePoint(camera.backdrop, { x: sign * 0.55 * 64, y: 0 }, 'horizontal camera at edge');

        await point(page, sign, sign);
        const diagonal = await draw(page, 6000);
        await expectDials(page, diagonal.order, 0.5, [sign * 8, sign * 16, sign * 32], 'vertical edge at fixed X');
        expect(figureGeometry(diagonal.order)).not.toEqual(figureGeometry(horizontal.order));
        expect((await state(page)).offsets, 'vertical pointer leaves all camera offsets unchanged').toEqual(camera);
        const plates = (order: DrawnOrder) => float32Geometry(order.filter(row => !(SLOTS.figure as readonly string[]).includes(row.slot)));
        expect(plates(diagonal.order), 'vertical pointer leaves the drawn plates unchanged').toEqual(plates(horizontal.order));
      }
    });

    test('#282 clamps a dial mapping that exceeds its compiled range inside the stage', async ({ page }) => {
      await open(page, true);
      const modelUrl = await fourPlaneModel(page, 'turn-dials');
      await mountNamed(page, backend, modelUrl, { pointerTurn: undefined, transitionMs: 125 });
      await ordinary(page, backend, modelUrl);
      await freeze(page, 0.5);
      await point(page, 0, 0, 'pointerenter');
      await tick(page, 125);
      for (const [input, factor, clamped] of [[0.25, 0.5, false], [0.75, 1, true], [-0.75, -1, true]] as const) {
        await point(page, input, input);
        const expected = TRANSLATION_DIALS.map(dial => dial.range * factor);
        await expectDials(page, (await draw(page, 6000)).order, 0.5, expected, `mapping at ${input}`);
        const readouts = await turnReadouts(page);
        expect(readouts.map(row => row.clamped)).toEqual([clamped, clamped, clamped]);
        expect(readouts.map(row => Math.fround(row.pointer))).toEqual(expected.map(Math.fround));
      }
    });

    test('#282 blends the unkeyed setup local and returns to the advancing baked pose', async ({ page }) => {
      const modelUrl = await fourPlaneModel(page, 'turn-dials');
      await mountNamed(page, backend, modelUrl, { pointerTurn: true, transitionMs: 125 });
      await ordinary(page, backend, modelUrl);
      for (let i = 0; i < 8; i++) await tick(page, 62.5);
      await expectDials(page, (await draw(page)).order, 0.5, bakedDials(0.5), 'automatic before enter');

      await point(page, 1, -1, 'pointerenter');
      const entering = await draw(page, 62.5);
      await expectDials(page, entering.order, 0.5625, bakedDials(0.5625).map(value => value / 2), 'halfway into hover');
      const enteringReadouts = await turnReadouts(page);
      expect(Math.fround(enteringReadouts.find(row => row.axis === 'pitch')!.baked), 'unkeyed baked pitch uses setup')
        .toBe(Math.fround(TRANSLATION_DIALS[1].setup));
      const centered = await draw(page, 62.5);
      await expectDials(page, centered.order, 0.625, [0, 0, 0], 'centered before tracking');
      const tracking = await draw(page, 62.5);
      const response = 1 - Math.exp(-0.0625 / 0.12);
      const target = [8 * response, -16 * response, 32 * response];
      await expectDials(page, tracking.order, 0.6875, target, 'tracking');

      await reset(page, 'pointerleave');
      const leaving = await draw(page, 62.5);
      await expectDials(page, leaving.order, 0.75, bakedDials(0.75).map((value, i) => (value + target[i]) / 2), 'halfway out of hover');
      const released = await draw(page, 62.5);
      expect((await state(page)).trackTime).toBe(0.8125);
      expect((await state(page)).refusal).toBeUndefined();
      await expectDials(page, released.order, 0.8125, bakedDials(0.8125), 'live release endpoint');
      await expectDials(page, (await draw(page, 62.5)).order, 0.875, bakedDials(0.875), 'automatic after release');
    });

    test(check(11, 'runs the 12-second horizontal still sweep even with touch input'), async ({ page }) => {
      const modelUrl = await fourPlaneModel(page, 'still');
      const run = async (touch: boolean) => {
        await mountNamed(page, backend, modelUrl, {
          planes: STILL_PLANES, autoSweep: { periodSeconds: 12, maxDisplacement: { x: 24, y: 0 } },
        });
        return page.evaluate(touch => {
          const rig = (window as ComposedHarnessWindow).composedTest;
          const ms = touch ? 31.25 : 62.5;
          const steps = 3000 / ms;
          const rows = [rig.state()];
          for (let i = 0; i < 4; i++) {
            if (touch) {
              rig.point(2, 2, 'pointerenter', 'touch');
              rig.point(-2, 2, 'pointermove', 'touch');
            }
            for (let step = 0; step < steps; step++) {
              if (touch && step === steps / 2) rig.reset(i % 2 ? 'pointercancel' : 'pointerleave', 'touch');
              rig.tick(ms);
            }
            rows.push(rig.state());
          }
          return rows;
        }, touch);
      };
      const plain = await run(false);
      const touch = await run(true);
      for (const [i, cameraX] of [0, 24, 0, -24, 0].entries()) {
        expect(plain[i].trackTime, 'still plates leave the figure clock running').toBe(i * 3);
        expect(touch[i].trackTime).toBe(i * 3);
        const shifts = { backdrop: 0.55 * cameraX, tables: 0.55 * cameraX * 28 / 24, figure: 0, foreground: -0.55 * cameraX };
        for (const id of NAMED_IDS) {
          closePoint(plain[i].offsets[id], { x: shifts[id], y: 0 }, `automatic sweep ${id} at ${i * 3}s`);
          closePoint(touch[i].offsets[id], plain[i].offsets[id], `touch stays automatic for ${id} at ${i * 3}s`);
        }
      }
    });
  });
}

type ReviewWindow = typeof window & { tickReview: (ms: number) => void };

test('captures the composed review page and independent stage crop', async ({ page }, info) => {
  const directory = process.env.COMPOSED_TAKE_EVIDENCE;
  test.skip(!directory, 'Set COMPOSED_TAKE_EVIDENCE to an evidence directory');
  test.setTimeout(120_000);
  const root = resolve(directory!);
  await mkdir(root, { recursive: true });
  const output = join(root, info.project.name);
  await mkdir(output);
  await open(page);

  const positions = [['center', 0, 0], ['left', -1, 0], ['right', 1, 0], ['up', 0, 1], ['down', 0, -1]] as const;
  const isolated = new Map();
  await mount(page, 'webgl');
  await freeze(page, 2);
  for (const mode of ['parallax', 'pan'] as const) {
    await setCamera(page, mode);
    for (const [position, x, y] of positions) {
      await point(page, x, y);
      await tick(page, 4000);
      const result = await backdrop(page);
      assertOpaque(result, 'webgl');
      isolated.set(`${mode}-${position}`, { ...await state(page), backdrop: result });
    }
  }

  // The comparison panels use a controlled integer translation and, separately,
  // the actual review-page snapshots below use the normal 12.8 px limit.
  const clipUrl = model('clip');
  await mount(page, 'webgl', { modelUrl: clipUrl, camera: 'pan', maxDisplacement: { x: 12, y: 12 } });
  await ordinary(page, 'webgl', clipUrl);
  await freeze(page, 2);
  const clip = [];
  for (const [position, x] of [['left', -1], ['right', 1]] as const) {
    await point(page, x, 0);
    await tick(page, 4000);
    const shift = { x: -x * 12, y: 0 };
    const result = await page.evaluate(({ shift, figure }) =>
      (window as ComposedHarnessWindow).composedTest.cropReference(2, shift, figure), { shift, figure: SLOTS.figure });
    const current = await state(page);
    clip.push({ position, ...current, ...result });
    await page.evaluate(lines => (window as ComposedHarnessWindow).composedTest.showReading(lines, true), [
      `Pan ${position} at 2 s`, `Camera X ${x * 12} px`, `All planes X ${shift.x} px`,
      `Crop RGBA differences ${result.scene.changed}`, `Early crop actor alpha differences ${result.earlyCrop.alphaChanged}`,
    ]);
    await page.locator('#evidence').screenshot({ path: join(output, `clip-reference-${position}.png`) });
  }
  await writeFile(join(output, 'clip-readings.json'), JSON.stringify(clip, null, 2), { flag: 'wx' });

  await page.addInitScript(() => {
    let now = 0;
    let id = 0;
    const pending = new Map<number, FrameRequestCallback>();
    performance.now = () => now;
    window.requestAnimationFrame = callback => { pending.set(++id, callback); return id; };
    window.cancelAnimationFrame = id => { pending.delete(id); };
    (window as ReviewWindow).tickReview = (elapsed: number) => {
      now += elapsed;
      for (const [id, callback] of [...pending]) {
        if (pending.delete(id)) callback(now);
      }
    };
  });

  const captures = [];
  for (const mode of ['parallax', 'pan'] as const) {
    for (const [position, x, y] of positions) {
      await page.goto(`/composed-parallax.html?fixture=overscan&camera=${mode}&time=2`);
      await expect(page.locator('#status')).toContainText('Pose held at 2 s');
      await page.locator('#stage canvas').evaluate((canvas, [x, y]) => {
        const box = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, isPrimary: true,
          clientX: box.left + (1 + x) * box.width / 2, clientY: box.top + (1 - y) * box.height / 2,
        }));
        (window as ReviewWindow).tickReview(4000);
      }, [x, y]);
      const pageReading = await page.evaluate(() => {
        const read = (id: string) => document.getElementById(id)!.textContent!;
        const canvas = document.querySelector<HTMLCanvasElement>('#stage canvas')!;
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let nonOpaque = 0;
        for (let i = 3; i < data.length; i += 4) nonOpaque += Number(data[i] !== 255);
        return {
          camera: read('camera-position'), excursion: read('camera-limit'),
          background: read('background-shift'), figure: read('figure-shift'), foreground: read('foreground-shift'),
          nonOpaque, width: canvas.width, height: canvas.height,
        };
      });
      const key = `${mode}-${position}`;
      const raw = isolated.get(key);
      const expected = (p: Point) => `${(p.x || 0).toFixed(2)}, ${(p.y || 0).toFixed(2)}`;
      expect(pageReading.camera).toBe(expected({ x: x * 12.8, y: y * 12.8 }));
      for (const plane of PLANES) expect(pageReading[plane]).toBe(expected(raw.offsets[plane]));
      expect(pageReading.nonOpaque).toBe(0);
      captures.push({ mode, position, page: pageReading, raw });
      await page.locator('main').screenshot({ path: join(output, `${key}.png`) });
    }
  }
  await writeFile(join(output, 'review-readings.json'), JSON.stringify(captures, null, 2), { flag: 'wx' });
});
