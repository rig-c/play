import { expect, test } from '@playwright/test';

// Public pixelRatio settings derived from the source fixture's boundary
// phase, not searched for after seeing the fixed renderer's output.
const RATIOS = [0.9999944561523227, 0.9999946241477069];

for (const ratio of RATIOS) {
  test(`packed surroundings and identical-final-frame history at pixelRatio ${ratio}`, async ({ page }, info) => {
    await page.goto('/tests/harness.html');
    await page.waitForFunction(() => Boolean(window.rigPlayHarness));
    const r = await page.evaluate((value) => window.rigPlayHarness.batchContextProbe(value), ratio);
    test.skip(!r.webglAvailable, `${info.project.name}: WebGL unavailable`);
    if (!r.webglAvailable) return;
    console.log(JSON.stringify({ probe: 'batch-context', project: info.project.name, ...r }));
    expect(r.backend).toBe('webgl');
    expect(r.commonUnchanged).toBe(true);
    expect(r.commonSlots).toEqual(['core']);
    expect(r.sourceSlots).toEqual(['pad_a', 'pad_b', 'core']);
    expect(r.contentPixels).toBeGreaterThan(0);
    expect(r.highPack.target).toEqual([512, 3328]);
    expect(r.highPack.common).toEqual([1, 1649]);
    expect(r.controls).toEqual({ normal: 0, defect: 1, emptyRefused: true });
    // The exact #187 byte regression is measured on Linux SwiftShader.
    // Other renderers still run the source/cache/state controls below and
    // report cold/warm residue; this is not a universal raster equivalence
    // claim (Mac headless WebKit retains a separate one-pixel residue).
    const measuredRenderer = process.platform === 'linux' && /SwiftShader/i.test(r.renderer);
    if (measuredRenderer) {
      expect.soft(r.coldDiff).toBe(0);
      expect.soft(r.warmDiff).toBe(0);
    } else {
      info.annotations.push({ type: 'pixel-scope', description: `Exact cold/warm byte bar is Linux SwiftShader only; observed ${r.coldDiff}/${r.warmDiff} on ${r.renderer}` });
    }
    expect(r.cachedDiff).toBe(0);
    expect(r.warmVisible).toEqual(['core']);
    expect(r.warmDrawn).toBe(0);
    expect(r.warmReused).toBe(1);
    expect(r.redrawDrawn).toBe(1);
    expect(r.redrawDiff).toBe(0);
    expect(r.afterFrameDiff).toBe(0);
    expect(r.frameRoundTripDiff).toBe(0);
  });
}
