import { expect, test } from '@playwright/test';
import type { GlFallbackSample } from './harness';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

function expectDraw(sample: GlFallbackSample, active: GlFallbackSample['active'], reason: GlFallbackSample['reason'], label: string) {
  expect(sample.reason, `${label} reason`).toBe(reason);
  expect(sample.active, `${label} backend`).toBe(active);
  expect(sample.draws, `${label} draw count`).toBeGreaterThan(0);
  expect(sample.pixels, `${label} non-transparent pixels`).toBeGreaterThan(1000);
}

for (const mode of ['dom', 'canvas'] as const) {
  test(`${mode}: explicit 2D makes no WebGL request and a creation refusal is cached`, async ({ page }) => {
    const r = await page.evaluate((mode) => window.rigPlayHarness.glCreationFallbackProbe(mode), mode);
    expect(r.requested).toBe('webgl');
    expect(r.initialReason).toBeNull();
    expectDraw(r.explicit, 'canvas2d', 'not-requested', 'explicit Canvas2D');
    expect(r.explicitAttempts).toBe(0);
    expectDraw(r.blocked, 'canvas2d', 'creation-failed', 'initial creation refusal');
    expect(r.blockedAttempts).toBe(1);
    expectDraw(r.cached, 'canvas2d', 'creation-failed', 'same renderer after lifting refusal');
    expectDraw(r.freshCached, 'canvas2d', 'creation-failed', 'fresh renderer after lifting refusal');
    expect(r.attempts).toBe(1);
  });

  test(`${mode}: context loss is reported in the interrupted flush and stays diagnosed`, async ({ page }) => {
    const r = await page.evaluate((mode) => window.rigPlayHarness.glLossFallbackProbe(mode), mode);
    if (!r) throw new Error('No shared WebGL context to lose');
    expectDraw(r.healthy, 'webgl', null, 'healthy WebGL');
    expect(r.lostDuringDraw).toBe(true);
    expect(r.beforeLossEvent).toBe(true);
    expectDraw(r.immediate, 'canvas2d', 'context-lost', 'interrupted flush before the loss event');
    expect(r.lossDefaultPrevented).toBe(false);
    expectDraw(r.afterLoss, 'canvas2d', 'context-lost', 'after the loss event');
    expect(r.retired).toBe(true);
    expectDraw(r.afterRestore, 'canvas2d', 'context-lost', 'after a restore event');
  });

  test(`${mode}: tiling stays on WebGL and an unusable grant clears after recovery`, async ({ page }) => {
    const { healthy, grant } = await page.evaluate((mode) => window.rigPlayHarness.glGrantFallbackProbe(mode), mode);
    expectDraw(healthy, 'webgl', null, 'healthy WebGL');
    if (!grant) throw new Error('No shared WebGL context for the grant probe');
    expect(grant.steadyWebgl, 'WebGL active through 120 steady frames').toBe(true);
    expect(grant.steadyNoReason, 'no diagnosis through 120 steady frames').toBe(true);
    expect(grant.tiledJobs).toBeGreaterThan(0);
    expectDraw(grant.tiled, 'webgl', null, 'successfully tiled WebGL');
    expectDraw(grant.denied, 'canvas2d', 'over-grant', 'unusable grant');
    expectDraw(grant.recovered, 'webgl', null, 'recovery at the same pose');
  });
}
