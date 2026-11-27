import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import type { Backend, Clock, Draw, MountOptions, Move, Point, SceneCameraWindow, Source } from './scene-camera-harness.js';

type Sample = {
  frame?: number;
  authored_time: number;
  compiled_time: number;
  pan: [number, number];
  zoom: number;
  view: number[];
  backdrop_quad: number[][];
  figures: { id: string; bounds: number[] | null }[];
};
type CameraTrack = { duration: number; compiled_duration: number; loop: boolean; frames: Sample[] };
type Report = { spec: string; camera: { model_sha256: string; tracks: Record<string, CameraTrack> } };
type OracleSample = Sample & { requested_time: number };
type RichOracle = {
  tracks: Record<string, {
    samples: Record<string, OracleSample>;
    row_interpolation_controls: { sample: string; linear_row_pan: [number, number] }[];
  }>;
};

const fixtures = 'tests/fixtures/scene-camera';
const overscan = 'tests/fixtures/composed-direction/overscan';
const figure = process.env.SCENE_CAMERA_FIGURE_DIR ?? 'public/rigs/figure';
const origin = 'http://127.0.0.1:37143';
const prefix = '/scene-camera';
const linear = { modelUrl: `${prefix}/linear/skeleton.model.json`, sceneReportUrl: `${prefix}/linear/report.json` };
const rich = { modelUrl: `${prefix}/eased/skeleton.model.json`, sceneReportUrl: `${prefix}/eased/report.json` };
const v1 = `${prefix}/linear/legacy.json`;
const reserialized = `${prefix}/linear/reserialized.model.json`;
const absoluteTolerance = 0.001;
const outputClip = { x: 0, y: 0, width: 128, height: 128 };
const allPixels = outputClip.width * outputClip.height;
const modelSha256 = '01cf0c46b8f028fca3f90657ddec668e9e8bff6aa7c1fcf01e65300403e15a23';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let inputFiles: ReturnType<typeof inputs> | undefined;
function inputs() {
  return Promise.all([
    readFile(join(fixtures, 'linear.report.json')),
    readFile(join(overscan, 'skeleton.model.json')),
    readFile(join(fixtures, 'eased/expected.json'), 'utf8'),
  ]).then(([reportFile, modelBytes, oracleText]) => {
    const report: Report = JSON.parse(reportFile.toString());
    const oracle: RichOracle = JSON.parse(oracleText);
    const legacy = { ...report, spec: 'spine-parts-scene-report/1', camera: undefined };
    const changedBytes = Buffer.from(JSON.stringify(JSON.parse(modelBytes.toString())));
    return { report, reportFile, modelBytes, legacy, changedBytes, oracle };
  });
}

let harness: Promise<string> | undefined;
function compileHarness() {
  return harness ??= build({
    configFile: false, logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry: resolve('tests/scene-camera-harness.ts'), formats: ['es'] } },
  }).then(result => {
    const output = Array.isArray(result) ? result[0] : result;
    if (!('output' in output)) throw new Error('Expected the scene camera harness bundle');
    const chunk = output.output.find(item => item.type === 'chunk' && item.isEntry);
    if (chunk?.type !== 'chunk') throw new Error('Missing scene camera entry');
    return chunk.code;
  });
}

test.use({ viewport: { width: 160, height: 160 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  const [{ reportFile, modelBytes, changedBytes, legacy }, script] = await Promise.all([inputFiles ??= inputs(), compileHarness()]);
  await page.route(`${origin}${prefix}/**`, route => {
    const path = new URL(route.request().url()).pathname.slice(prefix.length + 1);
    switch (path) {
      case 'probe.html':
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><div id="stage" style="position:relative;width:128px;height:128px"></div><script type="module" src="./probe.js"></script>' });
      case 'probe.js':
        return route.fulfill({ contentType: 'application/javascript', body: script });
      case 'linear/report.json':
        return route.fulfill({ contentType: 'application/json', body: reportFile });
      case 'linear/legacy.json':
        return route.fulfill({ json: legacy });
      case 'linear/skeleton.model.json':
        return route.fulfill({ contentType: 'application/json', body: modelBytes });
      case 'linear/reserialized.model.json':
        return route.fulfill({ contentType: 'application/json', body: changedBytes });
      case 'linear/skeleton.png':
        return route.fulfill({ path: join(overscan, 'skeleton.png') });
      case 'eased/report.json':
      case 'eased/skeleton.model.json':
      case 'eased/skeleton.png':
        return route.fulfill({ path: join(fixtures, path) });
      default: {
        if (/^figure\/(?:skeleton\.model\.json|(?:parts\/)?[a-z0-9_-]+\.png)$/.test(path)) {
          return route.fulfill({ path: join(figure, path.slice('figure/'.length)) });
        }
        return route.fulfill({ status: 404, body: path });
      }
    }
  });
  await page.goto(`${origin}${prefix}/probe.html`);
  await page.waitForFunction(() => Boolean((window as SceneCameraWindow).sceneCameraTest));
});

function authored(seconds: number): Clock {
  return { basis: 'authored', seconds };
}
function mounted(page: Page, options: MountOptions, actions: Move[]) {
  return page.evaluate(({ options, actions }) => (window as SceneCameraWindow).sceneCameraTest.mounted(options, actions), { options, actions });
}
function direct(page: Page, source: Source, backend: Backend, animation: string, clocks: Clock[], options?: { backdropControlIndex?: number }) {
  return page.evaluate(args => (window as SceneCameraWindow).sceneCameraTest.direct(args), { ...source, backend, animation, clocks, ...options });
}
function close(actual: number[], expected: number[], label: string, tolerance = absoluteTolerance) {
  expect(actual, label).toHaveLength(expected.length);
  const max = Math.max(...actual.map((value, i) => Math.abs(value - expected[i])));
  expect(max, label).toBeLessThanOrEqual(tolerance);
}
const coordinates = ({ x, y }: Point) => [x, y];
function slot(draw: Draw, name: string) {
  const found = draw.slots.find(row => row.name === name);
  if (!found) throw new Error(`Missing drawn slot ${name}`);
  return found;
}
function figureBounds(draw: Draw) {
  const all = draw.slots.filter(({ name }) => name.startsWith('actor:')).flatMap(({ points }) => points);
  const xs = all.filter((_, i) => i % 2 === 0), ys = all.filter((_, i) => i % 2 !== 0);
  expect(all.length).toBeGreaterThan(0);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function projectScene([x, y]: number[], sample: Pick<Sample, 'view' | 'zoom'>) {
  return [(x - sample.view[0]) * sample.zoom, (y - sample.view[1]) * sample.zoom];
}
function checkReport(draw: Draw, sample: Sample, label: string) {
  close(figureBounds(draw), sample.figures.find(row => row.id === 'actor')!.bounds!, `${label} figure bounds`);
  close(slot(draw, 'backdrop').points, sample.backdrop_quad.flatMap(point => projectScene(point, sample)), `${label} posed backdrop`);
}
function checkProjection(actual: Awaited<ReturnType<typeof direct>>[number], sample: Pick<Sample, 'view' | 'zoom'>) {
  const { point, device, outside, outsideWorld } = actual;
  expect(actual.outputClip).toEqual(outputClip);
  close(coordinates(device), projectScene([point.x + 64, 128 - point.y], sample), 'public world to authored output');
  close(coordinates(actual.roundTrip), coordinates(point), 'world round trip');
  close(coordinates(outsideWorld), [
    outside.x / sample.zoom + sample.view[0] - 64, 128 - (outside.y / sample.zoom + sample.view[1]),
  ], 'inverse off the output clip');
  close(coordinates(actual.outsideRoundTrip), coordinates(outside), 'unclamped output round trip');
}
function checkDraws(draws: Draw[], backend: Backend) {
  expect(draws.map(draw => draw.backend)).toEqual(draws.map(() => backend));
  expect(draws.some(draw => draw.triangles > 0 && draw.reused === 0)).toBe(true);
}

for (const backend of ['webgl', 'canvas2d'] as const) {
  test.describe(backend, () => {
    const idle = { ...linear, backend, animation: 'idle', loop: true };
    test('matches the Parts report in the mounted take and direct renderer', async ({ page }) => {
      const { report } = await (inputFiles ??= inputs());
      const rows = [0, 6, 24, 42].map(i => report.camera.tracks.idle.frames[i]);
      const requests: string[] = [];
      const listen = (request: { url(): string; resourceType(): string }) =>
        requests.push(`${request.resourceType()} ${new URL(request.url()).pathname}`);
      page.on('request', listen);
      const actual = await mounted(page, idle, rows.map(row => ({ seek: row.compiled_time })));
      page.off('request', listen);
      expect(requests.sort()).toEqual([
        `fetch ${linear.modelUrl}`, `fetch ${linear.sceneReportUrl}`, `image ${prefix}/linear/skeleton.png`,
      ].sort());
      const projected = await direct(page, linear, backend, 'idle', rows.map(row => authored(row.authored_time)));
      for (const [i, row] of rows.entries()) {
        checkReport(actual[i].draw, row, `mounted ${row.frame}`);
        checkReport(projected[i].draw, row, `direct ${row.frame}`);
        checkProjection(projected[i], row);
        expect(actual[i].refusal).toBeNull();
        expect(actual[i].pixel.opaque).toBe(allPixels);
        expect(projected[i].pixel.opaque).toBe(allPixels);
        expect(actual[i].draw.slots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['region', 'mesh']));
      }
      expect(actual[0].pixel.sha256).not.toBe(actual[2].pixel.sha256);
      checkDraws(actual.map(reading => reading.draw), backend);
      checkDraws(projected.map(reading => reading.draw), backend);
    });

    test('advances, holds while paused, seeks and repeats at the loop seam', async ({ page }) => {
      const { report } = await (inputFiles ??= inputs());
      const rows = report.camera.tracks.idle.frames;
      const observations = await mounted(page, idle, [
        { advance: 0.5 }, { pause: true, advance: 1.5 }, { pause: false, advance: 1.5 },
        { seek: 0 }, { advance: 4 }, { advance: 2 }, { seek: 0.5 },
      ]);
      for (const [i, frame] of [6, 6, 24, 0, 0, 24, 6].entries()) {
        const obs = observations[i];
        close([obs.animationTime!], [rows[frame].compiled_time], `mounted phase ${i}`, 1e-8);
        checkReport(obs.draw, rows[frame], `mounted phase ${i}`);
      }
      expect(observations[1].trackTime).toBe(observations[0].trackTime);
      expect(observations[4].trackTime).toBe(4);
      expect(observations[5].trackTime).toBe(6);
      for (const [a, b] of [[0, 1], [0, 6], [2, 5], [3, 4]]) {
        expect(observations[a].pixel.sha256).toBe(observations[b].pixel.sha256);
      }
      const [phase, terminal, wrapped] = await direct(page, linear, backend, 'idle', [
        { basis: 'compiled', seconds: 4, endpoint: 'phase' }, { endpoint: 'terminal' }, authored(4.5),
      ]);
      expect([phase.authoredSeconds, terminal.authoredSeconds, wrapped.authoredSeconds]).toEqual([0, 4, 0.5]);
      expect([phase.compiledSeconds, terminal.compiledSeconds, wrapped.compiledSeconds]).toEqual([0, 4, 0.5]);
      checkReport(phase.draw, rows[0], 'loop phase at duration');
      checkReport(terminal.draw, rows[48], 'unwrapped terminal');
      checkReport(wrapped.draw, rows[6], 'wrapped phase');
    });

    test('uses the Parts easing and step knots between report rows and moves the posed backdrop', async ({ page }) => {
      const { oracle } = await (inputFiles ??= inputs());
      const track = oracle.tracks.idle;
      const labels = ['named-open-between-rows', 'step-hold', 'before-step-jump', 'step-jump', 'named-shut-between-rows'];
      const rows = labels.map(label => track.samples[label]);
      const actual = await mounted(page, { ...idle, ...rich, movingBackdrop: true }, rows.map(row => ({ seek: row.compiled_time })));
      const projected = await direct(page, rich, backend, 'idle', rows.map(row => authored(row.requested_time)), { backdropControlIndex: 1 });
      for (const [i, row] of rows.entries()) {
        checkReport(actual[i].draw, row, `mounted ${labels[i]}`);
        checkReport(projected[i].draw, row, `direct ${labels[i]}`);
        checkProjection(projected[i], row);
      }
      // Change only pan to the value from interpolating adjacent 12 fps
      // observations. The difference must be detectable at both named samples.
      for (const control of track.row_interpolation_controls) {
        const i = labels.indexOf(control.sample);
        const row = rows[i];
        const linearPanMutant = {
          zoom: row.zoom,
          view: [row.view[0] + control.linear_row_pan[0] - row.pan[0], row.view[1] + control.linear_row_pan[1] - row.pan[1]],
        };
        const { point, device } = projected[i];
        const wrong = projectScene([point.x + 64, 128 - point.y], linearPanMutant);
        expect(Math.max(...coordinates(device).map((value, axis) => Math.abs(value - wrong[axis])))).toBeGreaterThan(0.1);
      }
      const control = projected[1].backdropControl!;
      expect(control.actual.opaque).toBe(allPixels);
      expect(control.difference.pixels).toBeGreaterThan(20);
      expect(control.difference.maxChannelDelta).toBeGreaterThan(5);
      expect(actual[2].pixel.sha256).not.toBe(actual[3].pixel.sha256);
      checkDraws(actual.map(reading => reading.draw), backend);
      checkDraws(projected.map(reading => reading.draw), backend);
    });

    test('maps the authored one-shot clock to the compiled clock and clamps after the end', async ({ page }) => {
      const { oracle } = await (inputFiles ??= inputs());
      const labels = ['named-shut-between-rows', 'moving-model-key', 'before-step-jump', 'step-jump', 'before-end', 'unwrapped-end', 'after-end-clamped'];
      const rows = labels.map(label => oracle.tracks.shot.samples[label]);
      const end = rows[5];
      const projected = await direct(page, rich, backend, 'shot', rows.map((row, i) => i === 5
        ? { endpoint: 'terminal' }
        : i === 1 ? { basis: 'compiled', seconds: row.compiled_time } : authored(row.requested_time)));
      const actual = await mounted(page, { ...rich, backend, animation: 'shot', loop: false, movingBackdrop: true }, [
        ...rows.slice(0, 5).map(row => ({ seek: row.compiled_time })), { seek: end.compiled_time }, { advance: 1 },
      ]);
      expect(end.compiled_time).not.toBe(end.authored_time);
      for (const [i, row] of rows.entries()) {
        expect(projected[i].loop).toBe(false);
        close([projected[i].authoredSeconds, projected[i].compiledSeconds],
          [row.authored_time, row.compiled_time], `direct clocks ${labels[i]}`, 1e-10);
        close([actual[i].animationTime!], [row.compiled_time], `mounted clock ${labels[i]}`, 1e-8);
        checkReport(actual[i].draw, row, `mounted ${labels[i]}`);
        checkReport(projected[i].draw, row, `direct ${labels[i]}`);
        checkProjection(projected[i], row);
      }
      expect(actual[5].pixel.sha256).toBe(actual[6].pixel.sha256);
      expect(projected[5].pixel.sha256).toBe(projected[6].pixel.sha256);
      expect(actual[1].pixel.sha256).not.toBe(actual[5].pixel.sha256);
      await expect(mounted(page, { ...rich, backend, animation: 'shot', loop: true, movingBackdrop: true }, []))
        .rejects.toThrow('SCENE_CAMERA_CLIP_MISMATCH');
    });

    test('applies pointer offsets in display pixels independently of the keyed zoom', async ({ page }) => {
      const { report } = await (inputFiles ??= inputs());
      const row = report.camera.tracks.idle.frames[24];
      const [fixed, pan] = await mounted(page, { ...idle, maxDisplacement: { x: 4, y: 8 } }, [{ seek: row.compiled_time }, { aim: true }]);
      expect(row.zoom).toBe(1.25);
      expect(pan.mode).toBe('pan');
      expect(pan.refusal).toBeNull();
      expect(pan.animationTime).toBe(fixed.animationTime);
      close(coordinates(pan.cameraTarget), [2, -4], 'pointer target in Y-up display pixels');
      close(coordinates(pan.offsets.figure), [-2, -4], 'figure display offset');
      for (const name of ['actor:face', 'actor:torso']) {
        const translated = slot(pan.draw, name).points;
        const still = slot(fixed.draw, name).points;
        const actual = translated.map((value, i) => value - still[i]);
        const shift = still.map((_, i) => i % 2 === 0 ? -2 : -4);
        close(actual, shift, `unzoomed pointer shift for ${name}`);
        expect(Math.max(...actual.map((v, i) => Math.abs(v - shift[i] * row.zoom)))).toBeGreaterThan(0.5);
      }
      expect(pan.pixel.sha256).not.toBe(fixed.pixel.sha256);
      expect(pan.pixel.opaque).toBe(allPixels);
    });

    test('projects real regions, meshes and their shared clip into a nonuniform backing', async ({ page }) => {
      const { report } = await (inputFiles ??= inputs());
      const sample = report.camera.tracks.idle.frames[24];
      const result = await page.evaluate(args => (window as SceneCameraWindow).sceneCameraTest.clipping(
        args.source, args.figureUrl, args.backend, args.sample,
      ), { source: linear, figureUrl: `${prefix}/figure/skeleton.model.json`, backend, sample });
      expect([result.draw.width, result.draw.height]).toEqual([256, 192]);
      expect(result.draw.clipCount).toBe(1);
      expect(result.restoration).toEqual(Array.from({ length: 3 }, () => ({
        sameViewport: true, viewport: { x: -31, y: 9, width: 41, height: 57 }, ratio: 1.75,
      })));
      checkDraws([result.draw], backend);
      for (const expected of result.expectedSlots) {
        const actual = slot(result.draw, expected.name);
        close(actual.points, expected.points, `authored coordinates for ${actual.name}`);
        close(actual.clip!, result.expectedPolygon, `authored clip for ${actual.name}`);
      }
      expect(result.correct.removed).toBeGreaterThan(100);
      expect(result.correct.retained).toBeGreaterThan(100);
      expect(result.correct.leaked).toBe(0);
      expect(result.correct.missing).toBe(0);
      expect(result.mutant.leaked + result.mutant.missing).toBeGreaterThan(100);
      expect(result.mutantDiff.pixels).toBeGreaterThan(100);
    });

    test('preserves legacy pixels for absent, /1, and known-unkeyed /2 reports', async ({ page, browser, browserName }, info) => {
      const baseline = browserName === 'chromium' && backend === 'canvas2d' ? process.env.SCENE_CAMERA_BASELINE_DIR : undefined;
      const legacy = await page.evaluate(args => (window as SceneCameraWindow).sceneCameraTest.legacy(
        args.options, 2, args.reports, args.raw,
      ), { options: { ...idle, sceneReportUrl: undefined }, reports: [v1], raw: baseline !== undefined });
      const known = await page.evaluate(args => (window as SceneCameraWindow).sceneCameraTest.legacy(
        args.options, 0.5, args.reports, false,
      ), { options: { ...idle, sceneReportUrl: undefined, animation: 'actor:body_turn' }, reports: [v1, linear.sceneReportUrl] });
      expect([legacy.backend, known.backend]).toEqual([backend, backend]);
      for (const comparison of [...legacy.comparisons, ...known.comparisons]) {
        expect(comparison).toMatchObject({ backend, pixels: 0, maxChannelDelta: 0 });
      }
      expect(legacy.pixel.opaque).toBe(allPixels);
      expect(known.pixel.opaque).toBe(allPixels);

      const evidence = {
        browserName, browserVersion: browser.version(), backend, dpr: legacy.dpr, animation: 'idle',
        phaseSeconds: 2, width: legacy.width, height: legacy.height, sha256: legacy.pixel.sha256, modelSha256,
      };
      console.log('[scene-camera legacy] ' + JSON.stringify(evidence));
      await info.attach('legacy-rgba-at-2s', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      if (baseline) {
        const receipt = JSON.parse(await readFile(join(baseline, 'browser.json'), 'utf8'));
        const matched = receipt.modelOnly.matched;
        expect(receipt.browserVersion).toBe(evidence.browserVersion);
        expect(receipt.modelSha256).toBe(modelSha256);
        expect(matched).toMatchObject({ backend, dpr: 1, width: 128, height: 128, trackTime: 2 });
        const bytes = await readFile(join(baseline, 'model-only-2s.rgba'));
        expect(hash(bytes)).toBe(matched.sha256);
        expect(evidence.sha256).toBe(matched.sha256);
        expect(Buffer.from(legacy.raw!).equals(bytes)).toBe(true);
      }

      const [keyed, unkeyed, resumed] = await mounted(page, { ...idle, bakedForeground: false }, [
        { advance: 2 },
        { play: { animation: 'actor:body_turn', loop: true }, advance: 0.5 },
        { play: { animation: 'idle', loop: true }, advance: 2 },
      ]);
      expect([keyed.animation, unkeyed.animation, resumed.animation]).toEqual(['idle', 'actor:body_turn', 'idle']);
      expect([keyed.animationTime, unkeyed.animationTime, resumed.animationTime]).toEqual([2, 0.5, 2]);
      expect([keyed.refusal, unkeyed.refusal, resumed.refusal]).toEqual([null, null, null]);
      const { report } = await (inputFiles ??= inputs());
      checkReport(keyed.draw, report.camera.tracks.idle.frames[24], 'initial keyed projection');
      checkReport(resumed.draw, report.camera.tracks.idle.frames[24], 'restored keyed projection');
      expect(unkeyed.pixel.sha256).toBe(known.pixel.sha256);
      expect(resumed.pixel.sha256).toBe(keyed.pixel.sha256);
      expect(keyed.pixel.sha256).not.toBe(legacy.pixel.sha256);
    });
  });
}

test('reports all five named camera refusal codes on one-variable controls', async ({ page }) => {
  const { report, reportFile, modelBytes, changedBytes } = await (inputFiles ??= inputs());
  expect(report.spec).toBe('spine-parts-scene-report/2');
  expect(hash(reportFile)).toBe('32951f79f83a13554b5965a61e2b1911384138d45c19411a8c26cdc9b7a35500');
  expect(hash(modelBytes)).toBe(report.camera.model_sha256);
  expect(hash(modelBytes)).toBe(modelSha256);
  expect(JSON.parse(changedBytes.toString())).toEqual(JSON.parse(modelBytes.toString()));
  expect(hash(changedBytes)).not.toBe(hash(modelBytes));
  const result = await page.evaluate(args => (window as SceneCameraWindow).sceneCameraTest.refusals(
    args.linear, args.reserialized, args.v1,
  ), { linear, reserialized, v1 });
  expect(result).toMatchObject({
    legacy: true, unkeyed: true, positive: true,
    coverage: { code: 'SCENE_CAMERA_REPORT_INVALID' },
    bytes: { code: 'SCENE_CAMERA_MODEL_MISMATCH' },
    missingDigest: { code: 'SCENE_CAMERA_MODEL_MISMATCH' },
    clip: { code: 'SCENE_CAMERA_CLIP_MISMATCH' },
    clock: { code: 'SCENE_CAMERA_CLOCK_INVALID' },
    view: { code: 'SCENE_CAMERA_VIEW_INVALID' },
    mountRefusal: { code: 'SCENE_CAMERA_MODEL_MISMATCH' },
  });
});
