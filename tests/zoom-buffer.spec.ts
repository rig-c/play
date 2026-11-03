import { expect, type Page, test } from '@playwright/test';
import type { CapCase, CapIdentityResult } from './zoomBufferProbe';

/**
 * A zoom that asks the shared WebGL buffer for more than the browser grants
 * must not draw through the part of the canvas the browser did not give it
 * (rig-c/review#332), and must not leave WebGL for it either (#245): past the
 * grant the blitter draws in passes and tiles. The probes
 * (tests/zoomBufferProbe.ts) say why and what each comparison is against;
 * every one is exact, but for the one engine and mode named below.
 */

function probe(page: Page, mode: 'dom' | 'canvas') {
  return page.evaluate((m) => window.rigPlayHarness.zoomBufferProbe(m), mode);
}

function capProbe(page: Page, mode: 'dom' | 'canvas', cap: CapCase, plant: 'none' | 'no-tiling' = 'none') {
  return page.evaluate(([m, c, p]) => window.rigPlayHarness.capIdentityProbe(m, c, p), [mode, cap, plant] as const);
}

function failed(r: CapIdentityResult): string[] {
  return r.checks.filter((c) => !c.pass).map((c) => c.name);
}

/**
 * Where the zoom's two exact comparisons are not held, and why. Headless
 * WebKit on macOS (Apple GPU) rasters the canvas mode's frame job differently
 * at two window positions even on the blitter's 32 px phase: the zoom drawn in
 * one pass and in tiles differed by 6,130 of 47.6 M pixels (up to 51 levels),
 * and the ratio-1 frame before and after the zoom by 75 (1 level), on the
 * build where its mesh jobs are identical. Snapping every vertex to a 1/256 px
 * grid in the vertex shader made both exact, and pushed the official oracle
 * (tests/oracle.spec.ts) past its floors on SwiftShader in five scenes —
 * `figure geometry`'s black residue to 10 levels against 7 — so it was not
 * kept. These two cases are reported on that engine rather than held; every
 * other engine and mode, the CI runner's included, is held to 0.
 */
function frameTranslationExact(project: string, mode: 'dom' | 'canvas'): boolean {
  return !(process.platform === 'darwin' && project === 'webkit' && mode === 'canvas');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

for (const mode of ['dom', 'canvas'] as const) {
  test(`${mode} mode: a zoom past the grant stays on WebGL and is the same pixels in another tiling`, async ({ page }) => {
    const r = await probe(page, mode);
    test.info().annotations.push({ type: 'zoom', description: JSON.stringify(r) });
    expect(r.backend).toBe('webgl');
    expect(r.cappedBackend).toBe('webgl');
    // Drawn only through a drawing buffer the browser granted in full.
    expect(r.bufferGranted, `buffer ${r.bufferWidth} x ${r.bufferHeight}`).toBe(true);
    // Where the engine does not grant the zoom's buffer (Chromium's area cap),
    // the real grant is what tiled it.
    if (!r.granted) expect(r.tiledJobs, `granted ${r.grantedWidth} x ${r.grantedHeight} for ${r.width} x ${r.height}`).toBeGreaterThanOrEqual(1);
    expect(r.cappedTiledJobs).toBeGreaterThanOrEqual(1);
    expect(r.cappedPieces).toBeGreaterThan(r.pieces);
    expect(r.zoomedPixels).toBeGreaterThan(0);
    if (frameTranslationExact(test.info().project.name, mode)) expect(r.zoomedDiff).toBe(0);
    else test.info().annotations.push({ type: 'pixel-scope', description: `not held here: ${r.zoomedDiff} of ${r.zoomedPixels} px, max ${r.zoomedMaxDelta}` });
  });

  test(`${mode} mode: after a zoom, the ratio-1 frame draws as it did before (0 pixels)`, async ({ page }) => {
    const r = await probe(page, mode);
    test.info().annotations.push({ type: 'zoom', description: JSON.stringify(r) });
    expect(r.referenceInk).toBeGreaterThan(1000);
    expect(r.afterCanvases).toBeGreaterThan(0);
    expect(r.afterPixels).toBeGreaterThan(0);
    if (frameTranslationExact(test.info().project.name, mode)) expect(r.afterDiff).toBe(0);
    else test.info().annotations.push({ type: 'pixel-scope', description: `not held here: ${r.afterDiff} of ${r.afterPixels} px, max ${r.afterMaxDelta}` });
  });
}

/**
 * Under a test-only cap on the granted buffer far below the fixture, every
 * frame stays on WebGL and its canvases are the uncapped single-pass draw's,
 * exactly — drawn in several passes, with one job tiled, and with tiles and
 * whole jobs sharing passes (`capIdentityProbe`).
 */
const CASES: Array<['dom' | 'canvas', CapCase]> = [
  ['dom', 'passes'],
  ['dom', 'tile'],
  ['dom', 'mixed'],
  ['canvas', 'tile'],
];

for (const [mode, cap] of CASES) {
  test(`${mode} mode, ${cap}: under a capped grant, every frame is the uncapped single-pass draw (0 pixels)`, async ({ page }) => {
    const r = await capProbe(page, mode, cap);
    test.info().annotations.push({ type: 'cap', description: JSON.stringify(r) });
    for (const c of r.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
  });
}

// The planted control: with tiling turned off, a job larger than the capped
// buffer is declined to canvas2d, as it was before #245, and the checks above
// must say so by name.
for (const mode of ['dom', 'canvas'] as const) {
  test(`${mode} mode: planted control — without tiling, the identity check fails by name`, async ({ page }) => {
    const r = await capProbe(page, mode, 'tile', 'no-tiling');
    test.info().annotations.push({ type: 'plant', description: JSON.stringify(r) });
    const names = failed(r);
    expect(names).toContain('webgl on every frame');
    expect(names).toContain('tile: the first frame tiles a job');
    expect(names).toContain('identical: part canvases');
    // The cap and the reference are the healthy run's: only the plant differs.
    expect(names).not.toContain('reference: one pass on every frame that drew');
    expect(names).not.toContain('cap: below what the uncapped draw used');
  });
}
