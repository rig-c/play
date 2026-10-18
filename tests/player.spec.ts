import { expect, test } from '@playwright/test';

/**
 * RigPlayer's reads of the pose it holds (#73): a bone's world transform by
 * name, and the box of what the pose draws. Both are read off the core's pose
 * — the one the player steps — so the oracle is the probe's own pose of the
 * same walk (tests/rigFrames.ts `poseAt`) at tolerance 0, and the probe's own
 * box over the frame record; and both read the same in either render mode.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('bone() is the core pose, bit for bit, and bounds() is the box of the frame', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.boneBoundsProbe());

  expect(probe.boneCount).toBeGreaterThan(1);
  expect(probe.boneMismatches).toEqual([]);

  // Before play: the setup pose, not a refusal.
  expect(probe.setupBone).not.toBeNull();
  expect(probe.setupBounds).not.toBeNull();

  // A frame no clip covers: exactly the box of its corners and vertices.
  expect(probe.walkHasClip).toBe(false);
  expect(probe.walkBounds).toEqual(probe.walkExpected);

  // Under a clip the box may only shrink, and never past the clip's own.
  expect(probe.maskHasClip).toBe(true);
  const b = probe.maskBounds as NonNullable<typeof probe.maskBounds>;
  const u = probe.maskUnclipped as NonNullable<typeof probe.maskUnclipped>;
  expect(b.x).toBeGreaterThanOrEqual(u.x);
  expect(b.y).toBeGreaterThanOrEqual(u.y);
  expect(b.x + b.width).toBeLessThanOrEqual(u.x + u.width);
  expect(b.y + b.height).toBeLessThanOrEqual(u.y + u.height);

  expect(probe.canvasSame).toBe(true);
  expect(probe.unknownBoneError).toContain('no_such_bone');
});

test('skin can change on a live player: the pose re-resolves, the track keeps its animation and time', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.skinProbe());

  expect(probe.skins).toEqual(['default', 'alt']);
  // Only the alt skin fills the emblem slot (with the visor art).
  expect(probe.emblemNoSkin).toBeNull();
  expect(probe.emblemAlt).toBe('visor');
  expect(probe.drawnAfterSwitch).toBe('visor');
  expect(probe.emblemBack).toBeNull();
  expect(probe.setupEmblemAlt).toBe('visor');

  expect(probe.animationKept).toBe(true);
  expect(probe.timeAfter).toBeCloseTo(probe.timeBefore, 12);
  // Equal to a player built under that skin and seeked to the same time.
  expect(probe.boneMismatches).toEqual([]);
  expect(probe.frameSame).toBe(true);

  expect(probe.unknownError).toContain('no_such_skin');
  expect(probe.skinAfterUnknown).toBe('alt');
  expect(probe.emblemAfterUnknown).toBe('visor');
});

test('sets() reads sets.json and setSet(name | null) switches attachment sets at setup and mid-track (#134)', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.setsProbe());

  expect(probe.declaredSets).toEqual([
    { name: 'smile', slots: { face: 'face_smile', prop: 'prop_star' }, hides: [] },
    { name: 'wink', slots: { face: 'face_wink' }, hides: ['prop'] },
  ]);
  expect(probe.emptySetsOnWalk).toBe(0);
  expect(probe.nullSetsUrlCount).toBe(0);
  expect(probe.spineSpecArraySets).toEqual(probe.declaredSets);

  expect(probe.invalidSpecError).toContain('spine-parts-sets/1');
  expect(probe.unknownSlotError).toContain('no_such_slot');
  expect(probe.unknownAttachmentError).toContain('no_such_attachment');
  expect(probe.noSetsSetError).toContain('no sets.json');
  expect(probe.unknownSetError).toContain('no_such_set');
  expect(probe.setAfterUnknownError).toBe('wink');

  // Setup pose before play:
  expect(probe.setupBaseRegions).toEqual([
    { slot: 'body', kind: 'region', region: 'body_base' },
    { slot: 'face', kind: 'region', region: 'face_neutral' },
    { slot: 'face_still', kind: 'region', region: 'face_still' },
    { slot: 'prop', kind: 'region', region: 'prop_wand' },
  ]);
  expect(probe.setupSmileRegions).toEqual([
    { slot: 'body', kind: 'region', region: 'body_base' },
    { slot: 'face', kind: 'mesh', region: 'mesh:skeleton.png' },
    { slot: 'prop', kind: 'region', region: 'prop_star' },
  ]);
  expect(probe.setupWinkRegions).toEqual([
    { slot: 'body', kind: 'region', region: 'body_base' },
    { slot: 'face', kind: 'region', region: 'face_wink' },
  ]);
  expect(probe.setupSmileMatchesDirectPose).toBe(true);
  expect(probe.setupCanvasSmileMatchesDirectPixels).toBe(true);
  expect(probe.setupRestoredByteIdentical).toBe(true);
  expect(probe.setupCanvasRestoredPixelIdentical).toBe(true);

  // Mid-track switching at t = 0.5 (track keys body -> body_track, face -> face_track):
  expect(probe.midTrackBaseRegions).toEqual([
    { slot: 'body', kind: 'region', region: 'body_track' },
    { slot: 'face', kind: 'region', region: 'face_track' },
    { slot: 'face_still', kind: 'region', region: 'face_still' },
    { slot: 'prop', kind: 'region', region: 'prop_wand' },
  ]);
  expect(probe.midTrackSmileRegions).toEqual([
    { slot: 'body', kind: 'region', region: 'body_track' },
    { slot: 'face', kind: 'mesh', region: 'mesh:skeleton.png' },
    { slot: 'prop', kind: 'region', region: 'prop_star' },
  ]);
  expect(probe.midTrackWinkRegions).toEqual([
    { slot: 'body', kind: 'region', region: 'body_track' },
    { slot: 'face', kind: 'region', region: 'face_wink' },
  ]);
  expect(probe.midTrackClearedRegions).toEqual(probe.midTrackBaseRegions);
  expect(probe.midTrackClearedNextFrameByteIdentical).toBe(true);
  expect(probe.tracksModeMidTrackByteIdentical).toBe(true);
  expect(probe.inactiveSetZeroPoseDiffs).toBe(0);
});

test('snapshot-backed seek matches cold replay at tolerance 0 across forward, backward, random, repeated, and off-grid seeks, in O(1) warm time, and invalidates on setSet (#141)', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.seekSnapshotProbe());

  expect(probe.rigs).toHaveLength(4);
  for (const run of probe.rigs) {
    expect(run.forwardBoneDiffs, `${run.rig} tracks=${run.tracks} forwardBoneDiffs`).toBe(0);
    expect(run.forwardPhysicsDiffs, `${run.rig} tracks=${run.tracks} forwardPhysicsDiffs`).toBe(0);
    expect(run.forwardFrameDiffs, `${run.rig} tracks=${run.tracks} forwardFrameDiffs`).toBe(0);
    expect(run.warmBackwardBoneDiffs, `${run.rig} tracks=${run.tracks} warmBackwardBoneDiffs`).toBe(0);
    expect(run.warmBackwardPhysicsDiffs, `${run.rig} tracks=${run.tracks} warmBackwardPhysicsDiffs`).toBe(0);
    expect(run.coldBackwardBoneDiffs, `${run.rig} tracks=${run.tracks} coldBackwardBoneDiffs`).toBe(0);
    expect(run.coldBackwardPhysicsDiffs, `${run.rig} tracks=${run.tracks} coldBackwardPhysicsDiffs`).toBe(0);
    expect(run.warmRandomBoneDiffs, `${run.rig} tracks=${run.tracks} warmRandomBoneDiffs`).toBe(0);
    expect(run.warmRandomPhysicsDiffs, `${run.rig} tracks=${run.tracks} warmRandomPhysicsDiffs`).toBe(0);
    expect(run.coldRandomBoneDiffs, `${run.rig} tracks=${run.tracks} coldRandomBoneDiffs`).toBe(0);
    expect(run.coldRandomPhysicsDiffs, `${run.rig} tracks=${run.tracks} coldRandomPhysicsDiffs`).toBe(0);
    expect(run.repeatedDiffs, `${run.rig} tracks=${run.tracks} repeatedDiffs`).toBe(0);
    expect(run.offGridDiffs, `${run.rig} tracks=${run.tracks} offGridDiffs`).toBe(0);

    // Warm seeks never replay from 0: at most 1 step from the nearest grid snapshot.
    expect(run.maxWarmPosesPerSeek).toBeLessThanOrEqual(1);
    expect(run.warmP95Ms).toBeLessThanOrEqual(10);

    for (const row of run.costTable) {
      expect(row.warmGridPoses).toBeLessThanOrEqual(1);
      expect(row.warmExactPoses).toBe(0);
    }
    expect(run.costTable[run.costTable.length - 1].coldPoses).toBeGreaterThanOrEqual(179);
    console.log(
      `[seek #141] ${run.rig} (tracks=${run.tracks}) warmP95=${run.warmP95Ms}ms costVsT=` +
      run.costTable.map((r) => `t=${r.time}s:cold=${r.coldReplayMs}ms(${r.coldPoses}p)/warmGrid=${r.warmGridStepMs}ms(${r.warmGridPoses}p)/warmExact=${r.warmExactMs}ms(${r.warmExactPoses}p)`).join(' | '),
    );
  }
  console.log(
    `[seek #141] twoRigClip frames=${probe.twoRigClip.frames} p50=${probe.twoRigClip.p50Ms}ms p95=${probe.twoRigClip.p95Ms}ms max=${probe.twoRigClip.maxMs}ms missPct=${probe.twoRigClip.deadlineMissPct}%`,
  );

  // Bar 3: two-rig pose p95 <= 20 ms, deadline misses <= 1% over the clip.
  expect(probe.twoRigClip.p95Ms).toBeLessThanOrEqual(20);
  expect(probe.twoRigClip.deadlineMissPct).toBeLessThanOrEqual(1);

  // Bar 4: valid setSet invalidates cache (0 diffs); mutant with stale cache differs by name.
  expect(probe.invalidation.validSetSwitchDiffs).toEqual([]);
  expect(probe.invalidation.mutantStaleSetCacheDiffs).toEqual([
    'face=mesh:skeleton.png (expected face=face_wink)',
    'prop=prop_star (expected prop=hidden)',
  ]);
  expect(probe.invalidation.validEnvSwitchDiffs).toBe(0);
  expect(probe.invalidation.validSkinSwitchDiffs).toBe(0);
  expect(probe.invalidation.validAdjustSwitchDiffs).toBe(0);
});

