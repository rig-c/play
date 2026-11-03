import { expect, type Page, test } from '@playwright/test';
import type { CapCase, CapIdentityResult } from './zoomBufferProbe';

/**
 * A zoom that asks the shared WebGL buffer for more than the browser grants
 * must not draw through the part of the canvas the browser did not give it
 * (rig-c/review#332), and must not leave WebGL for it either (#245): past the
 * grant the blitter draws in passes and tiles. The probes
 * (tests/zoomBufferProbe.ts) say why and what each comparison is against;
 * on Chromium every one is exact; on WebKit the pixel comparisons are
 * reported rather than held, see `identityHeld`.
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
 * Where pixel identity across tilings is held at 0, and why only there.
 *
 * Chromium (SwiftShader on the CI runner) draws a job identically wherever in
 * the buffer it is placed, so a tiling, a pass split and a zoom-sized buffer
 * are all the single-pass draw's pixels: held at 0 in both modes, which is the
 * engine #245 is for.
 *
 * WebKit is not translation-invariant, and how far it is not differs by host.
 * Headless WebKit on macOS draws a mesh job identically only under shifts
 * that are multiples of 32 px (the blitter's ALIGN, which makes its dom mode
 * exact here), and its canvas mode's frame job still differed: 6,130 of
 * 47.6 M px (up to 51 levels) for the zoom in two tilings, 75 px (1 level)
 * before and after it. WebKit on the Linux CI runner differs on the same
 * phase in both modes (CI run 41686808736): zoom 4,197 px (dom) and 5,983
 * (canvas), after it 3 and 121, and under the capped grant 14–54 px a frame
 * (dom) and 115–205 (canvas). Snapping vertices to a 1/256 px grid made macOS
 * exact and pushed the official oracle (tests/oracle.spec.ts) past its floors
 * on SwiftShader in five scenes, so it was not kept.
 *
 * So on WebKit the pixel counts are annotated as `pixel-scope`, and what stays
 * asserted there is #245's point: the backend is WebGL on every frame past
 * the grant, and the passes, pieces and tiles are the ones the cap forces.
 */
function identityHeld(project: string): boolean {
  return project === 'chromium';
}

const IDENTITY = 'identical: part canvases';

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
    if (identityHeld(test.info().project.name)) expect(r.zoomedDiff).toBe(0);
    else test.info().annotations.push({ type: 'pixel-scope', description: `not held here: ${r.zoomedDiff} of ${r.zoomedPixels} px, max ${r.zoomedMaxDelta}` });
  });

  test(`${mode} mode: after a zoom, the ratio-1 frame draws as it did before`, async ({ page }) => {
    const r = await probe(page, mode);
    test.info().annotations.push({ type: 'zoom', description: JSON.stringify(r) });
    expect(r.referenceInk).toBeGreaterThan(1000);
    expect(r.afterCanvases).toBeGreaterThan(0);
    expect(r.afterPixels).toBeGreaterThan(0);
    if (identityHeld(test.info().project.name)) expect(r.afterDiff).toBe(0);
    else test.info().annotations.push({ type: 'pixel-scope', description: `not held here: ${r.afterDiff} of ${r.afterPixels} px, max ${r.afterMaxDelta}` });
  });
}

/**
 * Under a test-only cap on the granted buffer far below the fixture, every
 * frame stays on WebGL — drawn in several passes, with one job tiled, and with
 * tiles and whole jobs sharing passes (`capIdentityProbe`) — and, where
 * `identityHeld`, its canvases are the uncapped single-pass draw's exactly.
 */
const CASES: Array<['dom' | 'canvas', CapCase]> = [
  ['dom', 'passes'],
  ['dom', 'tile'],
  ['dom', 'mixed'],
  ['canvas', 'tile'],
];

for (const [mode, cap] of CASES) {
  test(`${mode} mode, ${cap}: under a capped grant, every frame stays on WebGL and is the uncapped single-pass draw`, async ({ page }) => {
    const r = await capProbe(page, mode, cap);
    test.info().annotations.push({ type: 'cap', description: JSON.stringify(r) });
    const held = identityHeld(test.info().project.name);
    expect(r.checks.map((c) => c.name)).toContain(IDENTITY);
    for (const c of r.checks) {
      if (c.name === IDENTITY && !held) test.info().annotations.push({ type: 'pixel-scope', description: `not held here: ${c.detail} px per frame` });
      else expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    }
  });
}

// The planted control: with tiling turned off, a job larger than the capped
// buffer is declined to canvas2d, as it was before #245, and the checks above
// must say so by name.
for (const mode of ['dom', 'canvas'] as const) {
  test(`${mode} mode: planted control — without tiling, the checks fail by name`, async ({ page }) => {
    const r = await capProbe(page, mode, 'tile', 'no-tiling');
    test.info().annotations.push({ type: 'plant', description: JSON.stringify(r) });
    const names = failed(r);
    expect(names).toContain('webgl on every frame');
    expect(names).toContain('tile: the first frame tiles a job');
    // Declined frames differ by tens of thousands of pixels, but the identity
    // check is only a held verdict where `identityHeld` says so.
    if (identityHeld(test.info().project.name)) expect(names).toContain(IDENTITY);
    // The cap and the reference are the healthy run's: only the plant differs.
    expect(names).not.toContain('reference: one pass on every frame that drew');
    expect(names).not.toContain('cap: below what the uncapped draw used');
  });
}
