import { expect, test, type Page } from '@playwright/test';

type ControlModel = {
  bones: Array<{ name: string; parent?: string; skinRequired?: boolean; x?: number }>;
  slots: Array<{ name: string; bone: string }>;
  skins: Array<{ name: string; bones: string[]; attachments: Record<string, Record<string, Record<string, unknown>>> }>;
  events: Array<Record<string, unknown>>;
  animations: Array<{ bones: unknown[]; events: Array<Record<string, unknown>> }>;
  editorOrder?: { skins: Array<{ name: string; slots: string[] }> };
};
async function fixture(page: Page, skins: boolean) {
  await page.route('**/rigs/turned/skeleton.model.json', async route => {
    const response = await route.fetch(); const model: ControlModel = await response.json();
    model.events = [{ name: 'before', int: 2, float: 0.1000065, string: 'base' }, { name: 'after' }];
    model.animations[0].events = [{ time: 0.25, name: 'before' }, { time: 0.25, name: 'after', int: 8, string: 'twin' }, { time: 0.75, name: 'after' }, { time: 1, name: 'before' }];
    if (skins) {
      model.bones.push({ name: 'required', parent: 'root', x: 5, skinRequired: true });
      const slot = model.slots.find(slot => slot.name === 's');
      if (!slot || !model.skins[0]?.attachments.s?.s) throw Error('STAGE1_FIXTURE: turned needs slot s and its default region');
      slot.bone = 'required';
      const alt = structuredClone(model.skins[0]); alt.name = 'alt'; alt.bones = ['required'];
      alt.attachments.s.s.x = 7; alt.attachments.s.s.name = 'alternate-s'; alt.attachments.s.s.path = 's';
      model.skins.push(alt);
      model.editorOrder?.skins.push({ name: 'alt', slots: ['r', 's'] });
      model.animations[0].bones = [{ name: 'root', timelines: [{ name: 'translatex', keys: [{ time: 0, value: 0 }, { time: 1, value: 3 }] }] }];
    }
    await route.fulfill({ response, json: model });
  });
  await page.goto('/tests/harness.html'); await page.waitForFunction(() => Boolean(window.rigPlayHarness));
}
for (const reentrant of [false, true]) test(`runtime stage1 listener order and retention, reentrant=${reentrant}`, async ({ page }) => {
  await fixture(page, false);
  const result = await page.evaluate(reentrant => window.rigPlayHarness.runtimeEventsProbe(reentrant), reentrant);
  expect(result.poser).toBe('runtime'); expect(result.deliveries[1].length).toBeGreaterThan(0);
  expect(result.difference).toBeNull(); expect(result.heldUnchanged).toBe(true);
  const dropped = await page.evaluate(reentrant => window.rigPlayHarness.runtimeEventsProbe(reentrant, true), reentrant);
  expect(dropped.difference).not.toBeNull();
  console.log('RUNTIME_STAGE1_EVENTS', JSON.stringify({ reentrant, result, droppedDifference: dropped.difference }));
});
test('runtime stage1 skin switching preserves wrapped frames, identity and event cursor', async ({ page }) => {
  await fixture(page, true);
  const result = await page.evaluate(() => window.rigPlayHarness.runtimeSkinProbe());
  for (const row of result.rows) {
    expect(row.poser).toBe('runtime'); expect(row.time).toBe(1.375);
    expect(row.frameDifference).toBeNull(); expect(row.identityDifference).toBeNull();
    expect(row.pending).toEqual([]); expect(row.stale).toBe(true); expect(row.snapshotKept).toBe(true);
    expect(row.pixelValues).toBeGreaterThan(0); expect(row.pixelDifferences).toBe(0);
  }
  expect(result.deliveryDifference).toBeNull();
  const wrong = await page.evaluate(() => window.rigPlayHarness.runtimeSkinProbe(true));
  expect(wrong.rows.some(row => row.frameDifference !== null || row.pixelDifferences > 0)).toBe(true);
  console.log('RUNTIME_STAGE1_SKINS', JSON.stringify({ result, wrongRows: wrong.rows }));
});
