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

test('setSets / addSet / removeSet compose disjoint attachment sets as the union of each alone and refuse an overlap by name (#168)', async ({ page }) => {
  const fixtures = await page.evaluate(() => window.rigPlayHarness.multiSetsProbe());
  expect(fixtures.map((f) => f.fixture)).toEqual(['talk', 'talk-packed']);
  for (const fx of fixtures) {
    // Bar 1: both active pose exactly the union of each alone, base elsewhere.
    expect(fx.unionDiffs).toEqual({ setup: [], 'chat@0.5': [], 'chat@0.5 tracks': [] });
    expect(fx.unionSlots).toEqual(['body', 'arm_upper', 'arm_lower', 'head', 'mouth']);
    expect(fx.unionPixelsMatchDirect).toBe(true);
    // Order independence.
    expect(fx.orderDiffs).toEqual([]);
    for (const active of fx.activeSetsAfterEachOrdering) expect(active).toEqual(['viseme_o', 'gesture_chin']);
    // Bar 2: every overlap refused by name (the slot and both sets), nothing changed.
    const expectedSlot: Record<string, string> = {
      'viseme_o+viseme_a': 'mouth',
      'viseme_o+mouth_rest': 'mouth_still',
      'gesture_chin+arm_hide': 'arm_upper',
      'viseme_o+talk_point': 'mouth',
      'gesture_chin+talk_point': 'arm_lower',
    };
    expect(fx.overlaps).toHaveLength(10);
    for (const o of fx.overlaps) {
      const [a, b] = o.pair.split('+');
      expect(o.error, `${o.pair} via ${o.route}`).toContain(`"${a}"`);
      expect(o.error, `${o.pair} via ${o.route}`).toContain(`"${b}"`);
      expect(o.error, `${o.pair} via ${o.route}`).toContain(`slot "${expectedSlot[o.pair]}"`);
      expect(o.unchanged, `${o.pair} via ${o.route}`).toBe(true);
    }
    expect(fx.duplicateError).toContain('"viseme_o"');
    expect(fx.unknownError).toContain('no_such_set');
    // Bar 3: the empty list and setSet(null) restore the base byte-identically.
    expect(fx.restoreEmptyFrame).toBe(true);
    expect(fx.restoreEmptyPixels).toBe(true);
    expect(fx.restoreNullFrame).toBe(true);
    expect(fx.restoreNullPixels).toBe(true);
    expect(fx.midTrackRestoreNextFrame).toBe(true);
    expect(fx.tracksModeRestoreNextFrame).toBe(true);
    expect(fx.inactiveZeroPoseDiffs).toBe(0);
    // slotIdentity() reports the active list; `set` names a set only when exactly one is active.
    expect(fx.identity.noneSets).toEqual([]);
    expect(fx.identity.both).toEqual({ set: null, sets: ['viseme_o', 'gesture_chin'], hidden: ['mouth_still'] });
    expect(fx.identity.afterRemove).toEqual({ set: 'gesture_chin', sets: ['gesture_chin'], activeSets: ['gesture_chin'] });
    expect(fx.identity.afterSetSet).toEqual({ set: 'viseme_a', sets: ['viseme_a'] });
  }
});

test('a set\'s drawn bones pose as @rig-c/parts check --set poses them, and the rules around drawn hold (#170)', async ({ page }) => {
  const combos = await page.evaluate(() =>
    window.rigPlayHarness.drawnMatchProbe('gesture', [
      { sets: ['wave'], still: 'gesture-still-wave' },
      { sets: ['nod'], still: 'gesture-still-nod' },
      { sets: ['wave', 'nod'], still: 'gesture-still-wave+nod' },
    ]),
  );
  for (const c of combos) {
    const label = c.sets.join('+');
    expect(c.boneNameDiffs, label).toEqual([]);
    expect(c.slotDiffs, label).toEqual([]);
    expect(c.drawnSlots, label).toBe(4);
    expect(c.rotationMaxDeg, `${label} worst ${c.worstBone}`).toBeLessThanOrEqual(1e-3);
    expect(c.positionMaxAbs, label).toBeLessThanOrEqual(1e-3);
    expect(c.matrixMaxAbs, label).toBeLessThanOrEqual(1e-5);
    // The planted copy without drawn does not match.
    expect(c.stripped.rotationMaxDeg, `${label} stripped worst ${c.stripped.worstBone}`).toBeGreaterThanOrEqual(1);
    // drawnLength / registration / threshold / focus move nothing.
    expect(c.notPosedKeysIgnored, label).toBe(true);
  }

  const rules = await page.evaluate(() => window.rigPlayHarness.drawnRulesProbe());
  expect(rules.overlapError).toContain('"wave"');
  expect(rules.overlapError).toContain('"elbow_only"');
  expect(rules.overlapError).toContain('bone "elbow"');
  expect(rules.overlapUnchanged).toBe(true);
  expect(rules.unknownSetKeyError).toContain('"bogus"');
  expect(rules.unknownSetKeyError).toContain('known: slots, hides, drawn, drawnLength, registration, threshold, focus');
  expect(rules.unknownDocumentKeyError).toContain('"bogus"');
  expect(rules.unknownBoneError).toContain('no_such_bone');
  expect(Object.keys(rules.malformedFocusErrors).sort()).toEqual([
    'long',
    'nonFinite',
    'nullItem',
    'nullValue',
    'object',
    'short',
    'string',
  ]);
  for (const [label, err] of Object.entries(rules.malformedFocusErrors)) {
    expect(err, label).toContain('set "wave" "focus" must be [x, y] of two finite numbers');
  }
  expect(rules.parts163Control).toEqual({
    setsEqual: true,
    setKeys: ['name', 'slots', 'hides', 'drawn'],
    poseEqual: true,
  });
  expect(rules.declaredDrawn).toEqual({ wave: { shoulder: 50, elbow: 95 }, nod: { head: 105 }, elbow_only: { elbow: 10 } });
  expect(rules.midClipUndrawnMaxAbs).toBeLessThanOrEqual(1e-9);
  expect(rules.midClipShoulderOverTorso).toBeCloseTo(42, 4);
  expect(rules.midClipRestoreNextFrame).toBe(true);
  expect(rules.tracksModeRestoreNextFrame).toBe(true);
  expect(rules.setupRestore).toBe(true);
  expect(rules.slotOnlyIdentical).toBe(true);
  expect(rules.adjustAfterDrawn).toBeCloseTo(0, 4);
  expect(rules.skinChangeKeepsDrawn).toBe(true);
});

test('snapshot-backed seek matches cold replay at tolerance 0 across forward, backward, random, repeated, and off-grid seeks, in O(1) warm time, and invalidates on setSet (#141)', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.seekSnapshotProbe());

  expect(probe.rigs).toHaveLength(4);
  for (const run of probe.rigs) {
    expect(run.physicsConstraintCount, `${run.rig} physicsConstraintCount`).toBeGreaterThan(0);
    expect(run.physicsWordsPerFrame, `${run.rig} physicsWordsPerFrame`).toBe(3 + 21 * run.physicsConstraintCount);

    expect(run.forwardBoneDiffs, `${run.rig} tracks=${run.tracks} forwardBoneDiffs`).toBe(0);
    expect(run.forwardPhysicsDiffs, `${run.rig} tracks=${run.tracks} forwardPhysicsDiffs`).toEqual([]);
    expect(run.forwardFrameDiffs, `${run.rig} tracks=${run.tracks} forwardFrameDiffs`).toBe(0);
    expect(run.warmBackwardBoneDiffs, `${run.rig} tracks=${run.tracks} warmBackwardBoneDiffs`).toBe(0);
    expect(run.warmBackwardPhysicsDiffs, `${run.rig} tracks=${run.tracks} warmBackwardPhysicsDiffs`).toEqual([]);
    expect(run.coldBackwardBoneDiffs, `${run.rig} tracks=${run.tracks} coldBackwardBoneDiffs`).toBe(0);
    expect(run.coldBackwardPhysicsDiffs, `${run.rig} tracks=${run.tracks} coldBackwardPhysicsDiffs`).toEqual([]);
    expect(run.warmRandomBoneDiffs, `${run.rig} tracks=${run.tracks} warmRandomBoneDiffs`).toBe(0);
    expect(run.warmRandomPhysicsDiffs, `${run.rig} tracks=${run.tracks} warmRandomPhysicsDiffs`).toEqual([]);
    expect(run.coldRandomBoneDiffs, `${run.rig} tracks=${run.tracks} coldRandomBoneDiffs`).toBe(0);
    expect(run.coldRandomPhysicsDiffs, `${run.rig} tracks=${run.tracks} coldRandomPhysicsDiffs`).toEqual([]);
    expect(run.repeatedDiffs, `${run.rig} tracks=${run.tracks} repeatedDiffs`).toBe(0);
    expect(run.offGridDiffs, `${run.rig} tracks=${run.tracks} offGridDiffs`).toBe(0);

    // Positive control on physics comparator: perturbing rotateVelocity in cached snapshot fails by name.
    expect(run.mutantPhysicsPerturbDiffs).toHaveLength(1);
    expect(run.mutantPhysicsPerturbDiffs[0]).toMatch(/\.rotateVelocity=.* \(expected .*\)/);

    // Warm seeks never replay from 0: at most 1 step from the nearest grid snapshot.
    expect(run.maxWarmPosesPerSeek).toBeLessThanOrEqual(1);
    expect(run.warmP95Ms).toBeLessThanOrEqual(10);

    for (const row of run.costTable) {
      expect(row.warmGridPoses).toBeLessThanOrEqual(1);
      expect(row.warmExactPoses).toBe(0);
    }
    expect(run.costTable[run.costTable.length - 1].coldPoses).toBeGreaterThanOrEqual(179);
    console.log(
      `[seek #141] ${run.rig} (tracks=${run.tracks}) constraints=${run.physicsConstraintCount} words=${run.physicsWordsPerFrame} perturb=${run.mutantPhysicsPerturbDiffs[0]} warmP95=${run.warmP95Ms}ms costVsT=` +
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

test('slotIdentity() is coherent with posedFrame() across sets, timeline keys, skins and filters, mutates no pixel or physics word over 1000 held reads, and fails by slot name on stale setup attachments (#144)', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.slotIdentityProbe());

  // Bar 1: public two-set fixture (`sets` and `sets-packed`) across setSet(null / 'smile' / 'wink') and dance at t = 0.5
  expect(probe.setsFixtures).toHaveLength(2);
  for (const fx of probe.setsFixtures) {
    expect(fx.coherenceDiffs, `${fx.rig} coherenceDiffs`).toEqual([]);
    expect(fx.generationsStrictlyIncreasing, `${fx.rig} generationsStrictlyIncreasing (${fx.generations.join(',')})`).toBe(true);

    expect(fx.setupBase.set).toBeNull();
    expect(fx.setupBase.skin).toBeNull();
    expect(fx.setupBase.slots).toEqual([
      { slot: 'body', z: 0, attachment: 'body_base', skin: 'default', reason: null },
      { slot: 'face', z: 1, attachment: 'face_neutral', skin: 'default', reason: null },
      { slot: 'face_still', z: 2, attachment: 'face_still', skin: 'default', reason: null },
      { slot: 'prop', z: 3, attachment: 'prop_wand', skin: 'default', reason: null },
    ]);

    expect(fx.setupSmile.set).toBe('smile');
    expect(fx.setupSmile.slots).toEqual([
      { slot: 'body', z: 0, attachment: 'body_base', skin: 'default', reason: null },
      { slot: 'face', z: 1, attachment: 'face_smile', skin: 'default', reason: null },
      { slot: 'face_still', z: 2, attachment: null, skin: null, reason: 'set-hide' },
      { slot: 'prop', z: 3, attachment: 'prop_star', skin: 'default', reason: null },
    ]);

    expect(fx.setupWink.set).toBe('wink');
    expect(fx.setupWink.slots).toEqual([
      { slot: 'body', z: 0, attachment: 'body_base', skin: 'default', reason: null },
      { slot: 'face', z: 1, attachment: 'face_wink', skin: 'default', reason: null },
      { slot: 'face_still', z: 2, attachment: null, skin: null, reason: 'set-hide' },
      { slot: 'prop', z: 3, attachment: null, skin: null, reason: 'set-hide' },
    ]);

    expect(fx.setupRestored.set).toBeNull();
    expect(fx.setupRestored.slots).toEqual(fx.setupBase.slots);

    expect(fx.danceBase.set).toBeNull();
    expect(fx.danceBase.slots).toEqual([
      { slot: 'body', z: 0, attachment: 'body_track', skin: 'default', reason: null },
      { slot: 'face', z: 1, attachment: 'face_track', skin: 'default', reason: null },
      { slot: 'face_still', z: 2, attachment: 'face_still', skin: 'default', reason: null },
      { slot: 'prop', z: 3, attachment: 'prop_wand', skin: 'default', reason: null },
    ]);

    expect(fx.danceSmile.set).toBe('smile');
    expect(fx.danceSmile.slots).toEqual([
      { slot: 'body', z: 0, attachment: 'body_track', skin: 'default', reason: null },
      { slot: 'face', z: 1, attachment: 'face_smile', skin: 'default', reason: null },
      { slot: 'face_still', z: 2, attachment: null, skin: null, reason: 'set-hide' },
      { slot: 'prop', z: 3, attachment: 'prop_star', skin: 'default', reason: null },
    ]);

    expect(fx.danceWink.set).toBe('wink');
    expect(fx.danceWink.slots).toEqual([
      { slot: 'body', z: 0, attachment: 'body_track', skin: 'default', reason: null },
      { slot: 'face', z: 1, attachment: 'face_wink', skin: 'default', reason: null },
      { slot: 'face_still', z: 2, attachment: null, skin: null, reason: 'set-hide' },
      { slot: 'prop', z: 3, attachment: null, skin: null, reason: 'set-hide' },
    ]);

    expect(fx.danceRestored.set).toBeNull();
    expect(fx.danceRestored.slots).toEqual(fx.danceBase.slots);
    expect(fx.tracksDanceSmile.slots).toEqual(fx.danceSmile.slots);
    expect(fx.tracksDanceWink.slots).toEqual(fx.danceWink.slots);
  }

  // Skin ownership and reasons ('no-attachment', 'hidden', 'timeline-null')
  expect(probe.reasonsAndSkins.coherenceDiffs).toEqual([]);
  expect(probe.reasonsAndSkins.noSkinEmblem).toEqual({
    slot: 'emblem',
    z: probe.reasonsAndSkins.noSkinEmblem.z,
    attachment: null,
    skin: null,
    reason: 'no-attachment',
  });
  expect(probe.reasonsAndSkins.altSkinEmblem).toEqual({
    slot: 'emblem',
    z: probe.reasonsAndSkins.altSkinEmblem.z,
    attachment: 'emblem',
    skin: 'alt',
    reason: null,
  });
  expect(probe.reasonsAndSkins.altSkinTorso).toEqual({
    slot: 'torso',
    z: probe.reasonsAndSkins.altSkinTorso.z,
    attachment: 'torso',
    skin: 'default',
    reason: null,
  });
  expect(probe.reasonsAndSkins.filteredTorso.reason).toBeNull();
  expect(probe.reasonsAndSkins.filteredHead.reason).toBeNull();
  expect(probe.reasonsAndSkins.filteredArmBack).toEqual({
    slot: 'arm_b_up',
    z: probe.reasonsAndSkins.filteredArmBack.z,
    attachment: null,
    skin: null,
    reason: 'hidden',
  });
  expect(probe.reasonsAndSkins.filteredEmblemNoSkin.reason).toBe('no-attachment');
  expect(probe.reasonsAndSkins.timelineNullBefore).toEqual({
    slot: 'head',
    z: probe.reasonsAndSkins.timelineNullBefore.z,
    attachment: 'head',
    skin: 'default',
    reason: null,
  });
  expect(probe.reasonsAndSkins.timelineNullAt).toEqual({
    slot: 'head',
    z: probe.reasonsAndSkins.timelineNullAt.z,
    attachment: null,
    skin: null,
    reason: 'timeline-null',
  });
  expect(probe.reasonsAndSkins.squashOpenEyes).toEqual({
    slot: 'eyes',
    z: probe.reasonsAndSkins.squashOpenEyes.z,
    attachment: 'eyes',
    skin: 'default',
    reason: null,
  });
  expect(probe.reasonsAndSkins.squashShutEyes).toEqual({
    slot: 'eyes',
    z: probe.reasonsAndSkins.squashShutEyes.z,
    attachment: 'eyes_shut',
    skin: 'default',
    reason: null,
  });

  // Bar 2: Reading 1000x on a held pose changes no pixel and no physics word
  expect(probe.heldRead1000.pixelDiffs).toBe(0);
  expect(probe.heldRead1000.physicsDiffs).toEqual([]);
  expect(probe.heldRead1000.boneDiffs).toBe(0);
  expect(probe.heldRead1000.extraPoses).toBe(0);
  expect(probe.heldRead1000.generationChanged).toBe(false);
  expect(probe.heldRead1000.allSameRef).toBe(true);
  expect(probe.heldRead1000.isFrozen).toBe(true);

  // Bar 3: Mutant — timeline attachment key applied, but snapshot still naming setup attachment -> fails by slot name
  expect(probe.mutants.realSetsDanceDiffs).toEqual([]);
  expect(probe.mutants.staleSetsDanceDiffs).toEqual([
    'sets:dance: slot "body" snap.attachment=body_base != frame.region=body_track',
    'sets:dance: slot "face" snap.attachment=face_neutral != frame.region=face_track',
  ]);
  expect(probe.mutants.realSquashBounceDiffs).toEqual([]);
  expect(probe.mutants.staleSquashBounceDiffs).toEqual([
    'squash:bounce: slot "eyes" attachment=eyes != expected=eyes_shut',
    'squash:bounce: slot "eyes" snap.attachment=eyes != frame.region=eyes_shut',
  ]);
});


