import { expect, type Page, test } from '@playwright/test';

/**
 * A zoom that asks the shared WebGL buffer for more than the browser grants
 * must not draw through the part of the canvas the browser did not give it
 * (rig-c/review#332). The probe (tests/zoomBufferProbe.ts) says why and what
 * each comparison is against; both are exact, because both references are
 * draws the defect cannot reach: canvas2d at the zoomed ratio, and the same
 * ratio-1 frame drawn before the buffer ever grew.
 */

function probe(page: Page, mode: 'dom' | 'canvas') {
  return page.evaluate((m) => window.rigPlayHarness.zoomBufferProbe(m), mode);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

for (const mode of ['dom', 'canvas'] as const) {
  test(`${mode} mode: a zoomed draw is the canvas2d draw, or one through a buffer the browser granted`, async ({ page }) => {
    const r = await probe(page, mode);
    test.info().annotations.push({ type: 'zoom', description: JSON.stringify(r) });
    expect(r.zoomedPixels).toBeGreaterThan(0);
    if (r.backend === 'webgl') {
      // GL drew it: only correct through a drawing buffer of the size it needed.
      expect(r.granted, `drew ${r.width} x ${r.height} through a ${r.grantedWidth} x ${r.grantedHeight} buffer`).toBe(true);
    } else {
      expect(r.zoomedDiff).toBe(0);
    }
  });

  test(`${mode} mode: after a zoom the browser refused, the ratio-1 frame draws as it did before (0 pixels)`, async ({ page }) => {
    const r = await probe(page, mode);
    test.info().annotations.push({ type: 'zoom', description: JSON.stringify(r) });
    // A granted zoom grew the buffer legitimately; the probe says why that
    // case is reported rather than held to 0.
    test.skip(r.granted, `this engine granted the ${r.width + 2} x ${r.height + 2} buffer (after: ${r.afterDiff} px, max ${r.afterMaxDelta})`);
    expect(r.referenceInk).toBeGreaterThan(1000);
    expect(r.afterCanvases).toBeGreaterThan(0);
    expect(r.afterPixels).toBeGreaterThan(0);
    expect(r.afterDiff).toBe(0);
  });
}
