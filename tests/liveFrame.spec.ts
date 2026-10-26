import { expect, test } from '@playwright/test';

for (const rig of ['walk', 'flex', 'squash', 'portrait', 'nod', 'look', 'ride', 'figure', 'glow', 'turned', 'duo']) {
  test(`live frame exact values, snapshots and pixels: ${rig}`, async ({ page }) => {
    await page.goto('/tests/harness.html');
    await page.waitForFunction(() => Boolean(window.rigPlayHarness));
    const result = await page.evaluate(rig => window.rigPlayHarness.liveFrameProbe(rig), rig);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.numeric, `${rig}/${row.animation}: ${row.poser}`).toEqual([]);
      if (row.pixelValues > 0 && row.contentPixels > 0) expect(row.pixelDifferences, `${rig}/${row.animation}: ${row.poser}`).toBe(0);
      else console.log('LIVE_FRAME_PIXEL_SKIP', `${rig}/${row.animation}: no drawable content at the sampled times`);
      expect(row.snapshotKept).toBe(true);
      expect(row.stale).toBe(true);
      expect(row.nestedStale).toBe(true);
      expect(row.rendererStale).toBe(true);
      expect(row.readonly).toBe(true);
      if (row.poser === 'runtime') expect(row.drawIdentity).toBe(true);
      else expect(row.drawIdentity).toBeNull();
    }
    console.log('LIVE_FRAME_CASE', JSON.stringify(result));
  });
}

test('runtime composition fallback keeps time and invalidates old views', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const result = await page.evaluate(() => window.rigPlayHarness.liveFrameTransitions());
  expect(result.beforeCount).toBeGreaterThan(0);
  expect(result.composedReason).toContain('oracle: track composition');
  expect(result.composedTime).toBe(result.at);
  expect(result.oldStale).toBe(true);
  expect(result.disposed).toBe(true);
});

test('planted vertex, snapshot and unchecked-lease defects fail their gates', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const corrupt = await page.evaluate(() => window.rigPlayHarness.liveFrameProbe('turned', 'vertices'));
  expect(corrupt.rows.some(row => row.poser === 'runtime' && row.numeric.length > 0)).toBe(true);
  expect(corrupt.rows.some(row => row.pixelDifferences > 0)).toBe(true);
  const unchecked = await page.evaluate(() => window.rigPlayHarness.liveFrameProbe('turned', 'lease'));
  expect(unchecked.rows.some(row => row.poser === 'runtime' && !row.stale && !row.nestedStale && !row.rendererStale && !row.readonly)).toBe(true);
  const shared = await page.evaluate(() => window.rigPlayHarness.liveFrameProbe('walk', 'snapshot'));
  expect(shared.rows.some(row => row.poser === 'runtime' && !row.snapshotKept)).toBe(true);
});
