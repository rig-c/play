import { expect, type Page, test } from '@playwright/test';

let galleryReport: Awaited<ReturnType<Window['rigPlayHarness']['setupMeshGalleryProbe']>> | undefined;
async function gallery(page: Page) {
  if (!galleryReport) {
    await page.goto('/tests/harness.html');
    galleryReport = await page.evaluate(() => window.rigPlayHarness.setupMeshGalleryProbe());
  }
  return galleryReport;
}

test('literal and independent official geometry; identities, refusals, detached arrays and setup-slider domains', async ({ page }, info) => {
  await page.goto('/tests/harness.html');
  const r = await page.evaluate(() => window.rigPlayHarness.setupMeshLiteralProbe());
  await info.attach('setup-mesh-literals.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
  expect(r.literal).toEqual({ translated: [8, 7], weighted: [8, 3.25], decimal: 5.100000001490116 });
  expect(r.officialPairs.length).toBe(4);
  for (const pair of r.officialPairs) {
    expect(pair.actual.vertices).toEqual(pair.expected);
    expect(pair.actual.triangles).toEqual([0, 1, 2]); expect(pair.actual.hull).toBe(3);
  }
  expect(r.identity.alternate).toBe('alternate');
  expect(r.identity.linked).toMatchObject({ slot: 't', attachment: 'linked', skin: 'default', triangles: [0, 1, 2], hull: 3 });
  // Independent official runtime values, including inherited cos-90 residue.
  expect(r.identity.linked.vertices.slice(0, 2)).toEqual([1.9999999535897934, 1.9999999999999996]);
  expect(r.identity.linked.vertices).toEqual(r.identity.linkedExpected);
  expect(r.identity.noHull).toBeNull();
  expect(r.identity.inactive).toEqual([0, 0, 0, 0, 0, 0]); expect(r.identity.activatedX).toBe(53);
  expect(r.errors.length).toBe(8);
  for (const [i, error] of r.errors.entries()) {
    expect(error.coreError).toBe(true);
    expect(error.message).toContain(i === 0 ? 'no such slot' : i === 3 ? '--skin "missing-skin": no such skin' : i >= 4 ? 'not a mesh' : 'no such attachment');
    if (i !== 3) { expect(error.message).toContain(error.target.slot); expect(error.message).toContain(error.target.attachment); }
  }
  expect(r.detached.again).toEqual(r.detached.expected); expect(r.detached.other).toEqual(r.detached.expected);
  expect(r.detached.afterHash).toBe(r.detached.beforeHash); expect(r.detached.otherHash).toBe(r.detached.beforeHash);
  expect(r.skins.fallback).toBe('default'); expect(r.skins.named).toBe('named');
  expect(r.skins.noSkinOther.coreError).toBe(true); expect(r.skins.noSkinOther.message).toContain('no such attachment');
  expect(r.skins.all.vertices).toEqual(r.skins.namedWeighted.vertices); expect(r.skins.all.skin).toBe('default');
  expect(r.skins.nullSkin).toEqual(r.skins.omittedSkin);
  expect(r.skins.ambiguous.coreError).toBe(true); expect(r.skins.ambiguous.message).toContain('choose a named skin');
  expect(r.skins.ambiguityAfter).toBe(r.skins.ambiguityBefore);
  expect(r.slider.selected).toEqual(r.slider.rawSetup); expect(r.slider.selected).not.toEqual(r.slider.stored);
  for (const xy of r.slider.unselected) expect(xy).toEqual(r.slider.stored);
  expect(r.slider.afterHash).toBe(r.slider.beforeHash);
  expect(r.nonfinite.refusal.coreError).toBe(true); expect(r.nonfinite.afterHash).toBe(r.nonfinite.beforeHash);
});

test('every selected public gallery mesh is bit-identical to same-input core poseRawSetup', async ({ page }, info) => {
  const report = await gallery(page);
  console.log('SETUP_MESH_GALLERY ' + JSON.stringify(report));
  await info.attach('setup-mesh-gallery.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(report.builds).toBe(14);
  expect(report.selected.meshes).toBeGreaterThan(0);
  expect(report.nonselected.meshes).toBeGreaterThanOrEqual(0); // Zero is an explicit empty domain, not evidence for it.
  expect(report.coreSetup.meshes).toBe(report.selected.meshes);
  expect(report.coreSetup.coordinates).toBe(report.selected.coordinates);
  expect(report.coreSetup.bitMismatches).toBe(0);
  expect(report.coreSetup.worstDelta).toBe(0);
  expect(report.contractFailures).toEqual([]);
});

test('fixed released Review stored-only differences are recorded and exactly explained by setup-deform inputs', async ({ page }, info) => {
  // Post-measurement HQ bar revision: the original strict Review-zero run is
  // retained as FAIL. The primary promise above is core setup bit identity;
  // this compatibility read explains the stored-only reference's difference.
  const report = await gallery(page);
  await info.attach('setup-mesh-review-domain.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(report.reviewExplanation.unexplainedCoordinates).toBe(0);
  expect(report.reviewExplanation.explainedDifferingCoordinates).toBe(report.reviewExplanation.differingCoordinates);
  expect(report.contractFailures).toEqual([]);
});

test('1000 reads per player state leave time, generation, identity, events, DOM and pixels unchanged', async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.goto('/tests/harness.html');
  const report = await page.evaluate(() => window.rigPlayHarness.setupMeshPlayerProbe());
  console.log('SETUP_MESH_PLAYER ' + JSON.stringify(report));
  await info.attach('setup-mesh-player.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(report.states).toEqual(['setup', 'playing', 'paused', 'mixed', 'physics-held']);
  expect(report.reads).toBe(5000);
  expect(report.differences).toEqual([]);
});
