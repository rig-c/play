import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'vite';
import { easeCamera } from '../samples/parallax-compositor.js';

type SamplePlayer = Awaited<ReturnType<typeof import('../samples/parallax.js').mountParallax>>;
type SampleWindow = typeof window & { stepSample: (ms: number) => void; parallaxPlayer?: SamplePlayer };
type ScreenState = { camera: number[]; background: number[]; figure: number[]; foreground: number[] };

const neutral = { camera: [0, 0], background: [0, 0], figure: [0, 0], foreground: [0, 0] };

// Step the actual sample's only animation callback at explicit timestamps.
async function installFrameClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let now = 0;
    let frame: FrameRequestCallback | undefined;
    performance.now = () => now;
    window.requestAnimationFrame = (callback) => { frame = callback; return 1; };
    (window as SampleWindow).stepSample = (ms) => {
      if (!frame) throw new Error('The sample did not schedule a frame');
      now += ms;
      const next = frame;
      frame = undefined;
      next(now);
    };
  });
}

async function open(page: Page, url = '/parallax.html?time=0'): Promise<void> {
  await page.goto(url);
  await expect(page.locator('#status')).toContainText('Move the pointer over the scene');
}

async function point(page: Page, x: number, y: number): Promise<void> {
  await page.locator('#stage').evaluate((stage, [x, y]) => {
    const box = stage.getBoundingClientRect();
    stage.dispatchEvent(new PointerEvent('pointermove', {
      isPrimary: true, clientX: box.left + (1 + x) * box.width / 2, clientY: box.top + (1 - y) * box.height / 2,
    }));
  }, [x, y]);
}

async function tick(page: Page, ms: number): Promise<void> {
  await page.evaluate(ms => (window as SampleWindow).stepSample(ms), ms);
}

async function state(page: Page): Promise<ScreenState> {
  return page.evaluate(() => {
    const read = (id: string) => document.querySelector(`#${id}`)!.textContent!.replace(' px', '').split(', ').map(Number);
    return {
      camera: read('camera-position'), background: read('background-shift'),
      figure: read('figure-shift'), foreground: read('foreground-shift'),
    };
  });
}

async function drawBoxes(page: Page): Promise<number[][]> {
  return page.locator('#stage').evaluate((stage: HTMLCanvasElement) => {
    const ctx = stage.getContext('2d')!;
    const draw = ctx.drawImage;
    const boxes: number[][] = [];
    ctx.drawImage = function (source, ...args: number[]) {
      boxes.push(args);
      Reflect.apply(draw, this, [source, ...args]);
    };
    try { (window as SampleWindow).stepSample(4000); } finally { ctx.drawImage = draw; }
    return boxes;
  });
}

test('parallax converges by elapsed time across two schedules', () => {
  const goal = { x: 1, y: -0.5 };
  const sample = (intervals: number[]) => intervals.reduce((p, dt) => easeCamera(p, goal, dt), { x: 0, y: 0 });
  const short = sample([0.02, 0.02, 0.02, 0.02, 0.02, 0.02]);
  const mixed = sample([0.025, 0.055, 0.04]);
  const response = 1 - Math.exp(-1);
  console.log('[parallax] 120 ms convergence', JSON.stringify({ short, mixed }));
  expect(short.x).toBeCloseTo(mixed.x, 14);
  expect(short.y).toBeCloseTo(mixed.y, 14);
  expect(short.x).toBeCloseTo(response, 14);
  expect(short.y).toBeCloseTo(-response / 2, 14);
});

test('parallax clamps the viewport, applies directional gains and pans at equal gains', async ({ page }) => {
  await installFrameClock(page);
  await open(page);
  const baseline = await drawBoxes(page);
  expect(baseline).toHaveLength(3);

  async function check(expected: ScreenState): Promise<void> {
    const drawn = await drawBoxes(page);
    const actual = await state(page);
    console.log('[parallax] camera and drawn planes', JSON.stringify({ ...actual, drawn }));
    expect(actual).toEqual(expected);
    expect(drawn).toHaveLength(3);
    for (const [index, shift] of [expected.background, expected.figure, expected.foreground].entries()) {
      expect(drawn[index][0] - baseline[index][0]).toBeCloseTo(shift[0], 9);
      expect(drawn[index][1] - baseline[index][1]).toBeCloseTo(shift[1], 9);
      expect(drawn[index].slice(2)).toEqual(baseline[index].slice(2));
    }
  }

  await point(page, 2, 2);
  await check({ camera: [64, 40], background: [35.2, -22], figure: [0, 0], foreground: [-35.2, 22] });
  await point(page, -2, -2);
  await check({ camera: [-64, -40], background: [-35.2, 22], figure: [0, 0], foreground: [35.2, -22] });
  await point(page, 0.5, -0.5);
  await check({ camera: [32, -20], background: [17.6, 11], figure: [0, 0], foreground: [-17.6, -11] });
  await page.locator('#camera-mode').selectOption('pan');
  await check({ camera: [32, -20], background: [-32, -20], figure: [-32, -20], foreground: [-32, -20] });
});

for (const event of ['pointerleave', 'pointercancel']) {
  test(`parallax ${event} returns to neutral`, async ({ page }) => {
    await installFrameClock(page);
    await open(page);
    await point(page, 1, -1);
    await tick(page, 4000);
    expect((await state(page)).camera).toEqual([64, -40]);
    await page.locator('#stage').dispatchEvent(event, { isPrimary: true });
    await tick(page, 120);
    const returning = await state(page);
    expect(returning.camera).toEqual([23.5, -14.7]);
    await tick(page, 4000);
    const settled = await state(page);
    console.log(`[parallax] ${event}`, JSON.stringify({ after120ms: returning.camera, settled }));
    expect(settled).toEqual(neutral);
  });
}

test('parallax matches the fixed take pixel for pixel at time zero', async ({ page }) => {
  await installFrameClock(page);
  await open(page);
  await page.locator('#camera-mode').selectOption('fixed');

  const measures = await page.locator('#stage').evaluate((stage: HTMLCanvasElement) => {
    const ctx = stage.getContext('2d')!;
    const select = document.querySelector<HTMLSelectElement>('#camera-mode')!;
    const step = () => (window as SampleWindow).stepSample(4000);
    const pixels = () => new Uint32Array(ctx.getImageData(0, 0, stage.width, stage.height).data.buffer);
    const move = (x: number, y: number) => stage.dispatchEvent(new PointerEvent('pointermove', { isPrimary: true, clientX: x, clientY: y }));
    const box = stage.getBoundingClientRect();
    step();
    const fixed = pixels();
    const changed = () => pixels().reduce((count, rgba, i) => count + Number(rgba !== fixed[i]), 0);
    move(box.right, box.top);
    step();
    const disabledMoving = changed();
    select.value = 'parallax';
    step();
    const enabledMoving = changed();
    stage.dispatchEvent(new PointerEvent('pointercancel', { isPrimary: true }));
    step();
    return { width: stage.width, height: stage.height, disabledMoving, enabledMoving, enabledNeutral: changed() };
  });
  console.log('[parallax] fixed pixel comparison', JSON.stringify(measures));
  expect(measures.width * measures.height).toBeGreaterThan(100_000);
  expect(measures.disabledMoving).toBe(0);
  expect(measures.enabledMoving).toBeGreaterThan(0);
  expect(measures.enabledNeutral).toBe(0);
});

test('parallax keeps isolated figure pixels fixed at both horizontal extremes', async ({ page }) => {
  await installFrameClock(page);
  await open(page);

  const measures = await page.locator('#stage').evaluate((stage: HTMLCanvasElement) => {
    const ctx = stage.getContext('2d')!;
    const select = document.querySelector<HTMLSelectElement>('#camera-mode')!;
    const box = stage.getBoundingClientRect();
    const draw = ctx.drawImage;
    const planeCounts: number[] = [];
    let planes = 0;
    // The figure is composited between the background and foreground. Keep its
    // real draw on the stage and suppress the other draws to expose alpha.
    ctx.drawImage = function (source, ...args: number[]) {
      if (++planes === 2) Reflect.apply(draw, this, [source, ...args]);
    };
    const sample = (mode: string, x: number) => {
      select.value = mode;
      stage.dispatchEvent(new PointerEvent('pointermove', {
        isPrimary: true, clientX: x, clientY: box.top + box.height / 2,
      }));
      planes = 0;
      (window as SampleWindow).stepSample(4000);
      planeCounts.push(planes);
      return new Uint32Array(ctx.getImageData(0, 0, stage.width, stage.height).data.buffer);
    };
    try {
      const fixed = sample('fixed', box.left + box.width / 2);
      const changed = (pixels: Uint32Array) => pixels.reduce((count, rgba, i) => count + Number(rgba !== fixed[i]), 0);
      const left = changed(sample('parallax', box.left));
      const right = changed(sample('parallax', box.right));
      const panRight = changed(sample('pan', box.right));
      const alpha = new Uint8Array(fixed.buffer);
      let figurePixels = 0;
      for (let i = 3; i < alpha.length; i += 4) if (alpha[i] !== 0) figurePixels++;
      return { planeCounts, figurePixels, transparentPixels: fixed.length - figurePixels, left, right, panRight };
    } finally {
      ctx.drawImage = draw;
    }
  });
  console.log('[parallax] isolated figure pixel comparison', JSON.stringify(measures));
  expect(measures.planeCounts).toEqual([3, 3, 3, 3]);
  expect(measures.figurePixels).toBeGreaterThan(0);
  expect(measures.transparentPixels).toBeGreaterThan(0);
  expect(measures.panRight).toBeGreaterThan(0);
  expect({ left: measures.left, right: measures.right }, 'figure pixels at both extremes match Fixed').toEqual({ left: 0, right: 0 });
});

test('parallax keeps the backdrop opaque across the full camera envelope', async ({ page }) => {
  await installFrameClock(page);
  await open(page);
  const corners = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
  const readings: Record<string, number[]> = {};
  for (const mode of ['parallax', 'pan']) {
    await page.locator('#camera-mode').selectOption(mode);
    readings[mode] = [];
    for (const [x, y] of corners) {
      await point(page, x, y);
      await tick(page, 4000);
      readings[mode].push(await page.locator('#stage').evaluate((stage: HTMLCanvasElement) => {
        const pixels = stage.getContext('2d')!.getImageData(0, 0, stage.width, stage.height).data;
        let uncovered = 0;
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 255) uncovered++;
        return uncovered;
      }));
    }
  }
  console.log('[parallax] non-opaque pixels at four corners per mode', JSON.stringify(readings));
  expect(readings).toEqual({ parallax: [0, 0, 0, 0], pan: [0, 0, 0, 0] });
});

test('parallax leaves frame time and pose bytes independent of pointer motion', async ({ page }) => {
  // The browser-only probe mounts the same entry against the sample markup and
  // observes the returned player. The shipped sample installs no pose hook.
  const [html, bundle] = await Promise.all([
    readFile('parallax.html', 'utf8'),
    build({ configFile: false, logLevel: 'silent', build: { write: false, lib: { entry: resolve('samples/parallax.ts'), formats: ['es'] } } }),
  ]);
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!('output' in output)) throw new Error('Expected a bundled parallax entry');
  const entry = output.output.find(item => item.type === 'chunk' && item.isEntry);
  if (entry?.type !== 'chunk') throw new Error('Missing parallax entry');
  await page.route('**/parallax-clock-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: entry.code }));
  await page.route('**/parallax-clock-probe.html', route => route.fulfill({
    contentType: 'text/html',
    body: html.replace('/samples/parallax.ts', '/parallax-clock-probe.js')
      .replace('mountParallax().catch', 'mountParallax().then(player => { window.parallaxPlayer = player; }).catch'),
  }));
  await installFrameClock(page);

  const intervals = [20, 36, 40, 80, 30];
  async function take(withPointer: boolean) {
    await open(page, '/parallax-clock-probe.html');
    const samples = [];
    for (const [index, ms] of intervals.entries()) {
      if (withPointer) await point(page, index % 2 ? -1 : 1, -1);
      await tick(page, ms);
      samples.push(await page.evaluate(() => {
        const player = (window as SampleWindow).parallaxPlayer!;
        const pose = player.posedFrame();
        const bytes = JSON.stringify(pose, (_key, value) => Object.is(value, -0) ? { number: '-0' } : value);
        return { time: player.time, slots: pose.order.length, bytes };
      }));
    }
    return { samples, screen: await state(page) };
  }

  const stationary = await take(false);
  const moving = await take(true);
  const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const rows = stationary.samples.map((s, i) => ({
    stationaryTime: s.time, movingTime: moving.samples[i].time, slots: s.slots, bytes: Buffer.byteLength(s.bytes),
    sha256: digest(s.bytes), movingSha256: digest(moving.samples[i].bytes),
  }));
  console.log('[parallax] live pose bytes', JSON.stringify({ stationary: stationary.screen.camera, moving: moving.screen.camera, frames: rows }));
  expect(stationary.screen).toEqual(neutral);
  expect(Math.abs(moving.screen.camera[1])).toBeGreaterThan(20);
  expect(new Set(rows.map(row => row.sha256)).size).toBe(intervals.length);
  let expectedTime = 0;
  for (const [index, sample] of stationary.samples.entries()) {
    expectedTime += Math.min(intervals[index] / 1000, 1 / 15);
    expect(sample.time).toBe(expectedTime);
    expect(sample.slots).toBeGreaterThan(0);
    expect(moving.samples[index].time, `frame ${index + 1} time`).toBe(sample.time);
    expect(Buffer.from(moving.samples[index].bytes).equals(Buffer.from(sample.bytes)), `frame ${index + 1} pose bytes`).toBe(true);
  }
});
