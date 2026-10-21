import { expect, test } from '@playwright/test';

for (const group of ['adjust', 'physics', 'lifetime'] as const) {
  test(`live core ${group}: ${group === 'adjust' ? 'unchanged patch matched-history seek equals continuous' : group === 'lifetime' ? 'changed-patch backward replay uses current standing patch without a journal' : 'pending public forwarding and retained history'}`, async ({ page }, testInfo) => {
    await page.goto('/tests/harness.html');
    await page.waitForFunction(() => Boolean(window.rigPlayHarness));
    const result = await page.evaluate((name) => window.rigPlayHarness.liveCoreProbe(name), group);
    await testInfo.attach(`${group}-raw.json`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(result.rows.length).toBeGreaterThan(20);
    for (const row of result.rows) expect(row.pass, `${row.label}: ${JSON.stringify(row.detail)}`).toBe(true);
  });
}
