import { expect, test } from '@playwright/test';

test('native producer versus PNG roundtrip: exact normal and codec controls', async ({ page }) => {
  await page.goto('/tests/harness.html'); await page.waitForFunction(() => !!window.rigPlayHarness);
  const result = await page.evaluate(() => window.rigPlayHarness.atlasNativeRoundtrip());
  console.log(`ATLAS_NATIVE_ROUNDTRIP ${test.info().project.name} ${JSON.stringify(result)}`);
  expect(result.controls.normalEqual).toBe(true); expect(result.controls.oneChannelDefect).toBe(true);
  for (const row of result.rows) {
    expect(row.channels).toBeGreaterThan(0);
    expect(row.repeatedNativeChanged).toBe(0);
    expect(row.roundtripChanged).toBe(0);
    expect(row.alphaChanged).toBe(0); expect(row.opaqueChanged).toBe(0); expect(row.transparentChanged).toBe(0);
    if (!(test.info().project.name === 'webkit' && process.platform === 'linux')) expect(row.nativeChanged).toBe(0);
  }
});
