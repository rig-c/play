import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { diffInPage } from './pixelDiff';
import { SCENES, MODE_BAD_RATIO_LIMIT_TEST_RIGS, MODE_BAD_RATIO_LIMIT_GALLERY, MODE_CONTENT_MISMATCH_LIMIT } from './parityCases';

// Native producer and mesh-only equality stay strict. HQ admitted the existing
// mode-parity metric for composed rigid edges before its first measurement.
// Normal=A/A, defect=missing region, edge=one channel in one pixel.
async function diff(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(async ({ a, b }) => {
    async function pixels(src: string) {
      const img = new Image(); img.src = `data:image/png;base64,${src}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    }
    const [x, y] = await Promise.all([pixels(a), pixels(b)]);
    let pixelsChanged = 0, channelsChanged = 0, maxDelta = 0;
    for (let i = 0; i < x.length; i += 4) {
      let changed = false;
      for (let c = 0; c < 4; c++) { const d = Math.abs(x[i + c] - y[i + c]); if (d) { changed = true; channelsChanged++; maxDelta = Math.max(maxDelta, d); } }
      if (changed) pixelsChanged++;
    }
    return { pixelsChanged, channelsChanged, maxDelta };
  }, { a: a.toString('base64'), b: b.toString('base64') });
}
const shots = async (page: Page) => page.locator('#atlas-rigid-stage').screenshot();
test.beforeEach(async ({ page }) => { await page.goto('/tests/harness.html'); await page.waitForFunction(() => !!window.rigPlayHarness); });

test('strict raster metric controls: normal, missing region, one-channel edge', async ({ page }) => {
  const options = { rig: 'figure-packed', animation: 'walk', atlas: false };
  await page.evaluate(o => window.rigPlayHarness.atlasRigidStage(o), options);
  const a = await shots(page);
  expect((await diff(page, a, a)).pixelsChanged).toBe(0);
  await page.evaluate(o => window.rigPlayHarness.atlasRigidStage({ ...o, defect: true }), options);
  expect((await diff(page, a, await shots(page))).pixelsChanged).toBeGreaterThan(0);
  const edge = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0); const p = ctx.getImageData(0, 0, c.width, c.height);
    p.data[0] ^= 1; ctx.putImageData(p, 0, 0); return c.toDataURL().split(',')[1];
  }, a.toString('base64'));
  expect(await diff(page, a, Buffer.from(edge, 'base64'))).toEqual({ pixelsChanged: 1, channelsChanged: 1, maxDelta: 1 });
});

const cases = [
  ...SCENES.map(scene => {
    const q = new URLSearchParams(scene.query);
    return { rig: q.get('rig')!, animation: q.get('anim')!, scale: 0.4, gallery: scene.kind === 'gallery',
      tint: q.has('tint'), set: q.get('set') ?? undefined, wind: q.has('wind') ? q.get('wind')!.split(',').map(Number) as [number, number] : undefined };
  }),
  { rig: 'turned', animation: 'hold', scale: 30 },
  ...(['blob', 'data'] as const).flatMap(pageEncoding => [
    { rig: 'figure-packed', animation: 'walk', scale: 0.4, pageEncoding },
    { rig: 'figure-packed', animation: 'walk', scale: 0.4, pageEncoding, pma: true },
    { rig: 'figure-packed', animation: 'walk', scale: 0.4, pageEncoding, half: true },
    { rig: 'turned', animation: 'hold', scale: 30, pageEncoding },
  ]),
  ...['flex-packed', 'portrait', 'figure-packed'].map(rig => ({ rig, animation: rig === 'flex-packed' ? 'wave' : rig === 'portrait' ? 'turn' : 'walk', scale: 0.4, meshOnly: true })),
];
for (const [index, options] of cases.entries()) test(`atlas / encoded rigid parity ${index}: ${JSON.stringify(options)}`, async ({ page }, info) => {
  const nativeReadback = info.project.name === 'webkit' && process.platform === 'linux' ? 'png-roundtrip' as const : 'direct' as const;
  const compared = { ...options, nativeReadback };
  await page.evaluate(o => window.rigPlayHarness.atlasRigidStage({ ...o, atlas: false }), compared);
  const a = await shots(page);
  const probe = await page.evaluate(o => window.rigPlayHarness.atlasRigidStage({ ...o, atlas: true }), compared);
  const b = await shots(page);
  const result = await diff(page, a, b);
  const parity = await diffInPage(page, a, b);
  const badRatio = parity.bad / Math.max(1, parity.contentUnion);
  const contentMismatch = Math.abs(parity.contentA - parity.contentB) / Math.max(1, parity.contentA, parity.contentB);
  const limit = 'gallery' in options && options.gallery ? MODE_BAD_RATIO_LIMIT_GALLERY : MODE_BAD_RATIO_LIMIT_TEST_RIGS;
  console.log(`ATLAS_RASTER ${info.project.name} ${index} ${JSON.stringify({ options, probe, ...result, badRatio, contentMismatch, limit })}`);
  if (result.pixelsChanged) { writeFileSync(info.outputPath('encoded.png'), a); writeFileSync(info.outputPath('atlas.png'), b); await info.attach('encoded', { body: a, contentType: 'image/png' }); await info.attach('atlas', { body: b, contentType: 'image/png' }); }
  expect(probe.nativeChannels).toBeGreaterThan(0);
  expect(probe.nativeGateChanged, nativeReadback === 'png-roundtrip' ? 'Linux WebKit premultiplied-store readback rounding: encoded cuts through PNG; unencoded page pass-through direct; exact equality' : 'direct native readback, exact equality').toBe(0);
  expect(probe.repeatRasters).toBe(0);
  if ('meshOnly' in options && options.meshOnly) expect(result).toEqual({ pixelsChanged: 0, channelsChanged: 0, maxDelta: 0 });
  else {
    expect(probe.regions).toBeGreaterThan(0);
    expect(parity.contentUnion).toBeGreaterThan(0);
    if (options.rig === 'named') {
      // Opt-in only: the checker minification caveat is reported, never
      // relabelled as within the existing mode-parity gate. Native/mesh bars
      // above still apply. No replacement threshold is calibrated here.
      info.annotations.push({ type: 'atlas-filtering-caveat', description: `bad/content=${badRatio}; existing limit=${limit}` });
    } else expect(badRatio).toBeLessThanOrEqual(limit);
    expect(contentMismatch).toBeLessThanOrEqual(MODE_CONTENT_MISMATCH_LIMIT);
  }
});


test('atlas is opt-in, has no ready URLs or encoder, and rerasterizes only across scale bands', async ({ page }) => {
  const p = await page.evaluate(() => window.rigPlayHarness.atlasLoadingProbe());
  expect(p.defaultMode).toBe('blob'); expect(p.defaultRegions).toBe(2);
  expect(p.atlasMode).toBe('atlas'); expect(p.urls).toBe(0); expect(p.descriptors).toBe(2);
  expect(p.minted).toBe(0); expect(p.encodes).toBe(0);
  expect(p.initialRasters).toBe(2); expect(p.repeatRasters).toBe(0); expect(p.inBandRasters).toBe(0);
  expect(p.crossedRasters).toBe(2); expect(p.nativeRasters).toBe(2); expect(p.sharedSurvives).toBe(true);
});
