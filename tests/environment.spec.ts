import { expect, test } from '@playwright/test';

/**
 * The environment the page sets (#121): `player.environment({ wind, gravity })`
 * and `player.moved({ x, y, rotation })`, forwarded to the core's live tracks
 * (rig-c/core#1416: spine-core's skeleton-level wind and gravity, x right and
 * y down, start values wind [1, 0] and gravity [0, 1]; `physicsTranslate` and
 * `physicsRotate`). Fixture: the `cloth` test rig, a three-link physics chain
 * hanging from an anchor, each link answering wind 12 and gravity 12; `look`
 * (one physics bone) and `walk` (none) beside it. Steps of 1/60 s.
 *
 * What each test asserts was written before its first run (the plan on #121),
 * with two corrections made after it, said where they are: checkpoints are
 * steps 60 (calm, before the gust), 90 (inside a drag or a turn, added after
 * the first run read the drag at step 120, thirty steps after it had ended),
 * 120 (the gust's end), 180 and 240 (after it).
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('no environment and no motion: every pose is the core track given neither, to the bit', async ({ page }) => {
  // Asserts: on cloth, look and walk, 600 steps, the largest difference of any
  // bone reading between the player and the core track is 0.
  const r = await page.evaluate(() => window.rigPlayHarness.environmentProbe());
  expect(r.untouched.map((u) => u.rig)).toEqual(['cloth', 'look', 'walk']);
  for (const u of r.untouched) expect(u.maxDiff).toBe(0);
});

test('a side gust pushes the chain its way and lets it go; more gravity pulls it back', async ({ page }) => {
  // Asserts, in the DOM mode and the canvas mode alike (the same numbers to
  // the bit): calm hangs straight (tip x within 1 of 0 at step 60); a gust
  // of wind [+1, 0] leaves the tip more than 20 units right of calm at
  // step 120, and [−1, 0] the mirror; after the gust the gap shrinks
  // (step 240 smaller than step 180); under gravity [0, 3] the same gust
  // leaves the tip less far right than under the start gravity.
  const { tips } = await page.evaluate(() => window.rigPlayHarness.environmentProbe());
  for (const name of Object.keys(tips)) expect(tips[name].canvas).toEqual(tips[name].dom);
  const calm = tips.calm.dom, right = tips.gustRight.dom, left = tips.gustLeft.dom, heavy = tips.gustHeavy.dom;
  expect(Math.abs(calm[0])).toBeLessThanOrEqual(1);
  expect(right[2] - calm[2]).toBeGreaterThan(20);
  expect(left[2] - calm[2]).toBeLessThan(-20);
  // The mirror to 1e-5: the first run asked 5e-7 and read 6.3e-7 — the two
  // gusts integrate the same floats in the other order.
  expect(Math.abs((left[2] - calm[2]) + (right[2] - calm[2]))).toBeLessThan(1e-5);
  expect(Math.abs(right[4] - calm[4])).toBeLessThan(Math.abs(right[3] - calm[3]));
  expect(heavy[2]).toBeLessThan(right[2]);
  expect(heavy[2] - calm[2]).toBeGreaterThan(0);
});

test('moving the rig trails the chain; turning it swings the chain', async ({ page }) => {
  // Asserts: moved({ x: +5 }) for 30 steps leaves the tip more than 20 units
  // left of calm at step 90, inside the drag (it trails); moved({ rotation: 3 })
  // for 30 steps moves the tip more than 10 units off calm at step 90; both
  // settle back (step 240 nearer calm than step 90).
  const { tips } = await page.evaluate(() => window.rigPlayHarness.environmentProbe());
  const calm = tips.calm.dom, drag = tips.dragRight.dom, turn = tips.turn.dom;
  expect(drag[1] - calm[1]).toBeLessThan(-20);
  expect(Math.abs(turn[1] - calm[1])).toBeGreaterThan(10);
  expect(Math.abs(drag[4] - calm[4])).toBeLessThan(Math.abs(drag[1] - calm[1]));
  expect(Math.abs(turn[4] - calm[4])).toBeLessThan(Math.abs(turn[1] - calm[1]));
});

test('the player forwards exactly what a core track given the same calls poses', async ({ page }) => {
  // Asserts: a gust plus a drag, at a fixed 1/20 s, a fixed 1/60 s and a
  // jittered 60 Hz clock, poses every bone of the cloth as the core track
  // given the same setEnvironment / physicsTranslate calls, to the bit.
  const r = await page.evaluate(() => window.rigPlayHarness.environmentProbe());
  expect(r.throughCore.map((t) => t.name)).toEqual(['fixed 1/20', 'fixed 1/60', 'rAF 60 Hz, jittered']);
  for (const t of r.throughCore) expect(t.maxDiff).toBe(0);
});

test('a rig without physics answers no environment and no motion', async ({ page }) => {
  // Asserts: walk under a changing wind, gravity, translation and rotation
  // every step poses every bone as walk under none, to the bit.
  const r = await page.evaluate(() => window.rigPlayHarness.environmentProbe());
  expect(r.noPhysicsMaxDiff).toBe(0);
});

test('environment() reports what stands: before play, after a half, after null', async ({ page }) => {
  // Asserts: set before play, wind [0.5, 0] stands with the start gravity;
  // a gravity-only call keeps that wind; null is the start values.
  const r = await page.evaluate(() => window.rigPlayHarness.environmentProbe());
  expect(r.beforePlay).toEqual([0.5, 0, 0, 1]);
  expect(r.afterHalf).toEqual([0.5, 0, 0, 2]);
  expect(r.afterNull).toEqual([1, 0, 0, 1]);
});

for (const rig of ['cloth', 'held'] as const) {
  for (const tracks of [false, true]) {
    test(`scheduled seek on ${rig} (tracks: ${tracks})`, async ({ page }) => {
      const r = await page.evaluate(({ rig, tracks }) => window.rigPlayHarness.scheduledSeekProbe(rig, tracks), { rig, tracks });
      expect.soft(r.poser, 'auto poser falls back for the physics chain').toMatch(/^oracle: physics constraint/);
      expect(r.setup.slots).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'banner', kind: 'mesh' }),
        expect.objectContaining({ name: 'link_3', kind: 'region' }),
      ]));

      await test.step('zero seek resets to setup without sampling the schedule', () => {
        expect.soft(r.zero.calls).toEqual([]);
        expect.soft(r.zero.pose).toEqual(r.setup);
      });

      await test.step('callbacks sample the accumulated pre-step clock through the fractional tail', () => {
        const starts = r.lateForward.starts;
        expect(starts).toHaveLength(69);
        expect(starts[0]).toBe(0);
        expect(starts[68]).toBeGreaterThan(2); // The animation loops at 2 s.
        expect.soft(r.late.calls).toEqual(starts);
      });

      await test.step('every corner and mesh vertex matches forward integration', () => {
        expect.soft(r.late.pose).toEqual(r.lateForward.pose);
        expect.soft(r.lateForward.pose.slots, 'one-step-ahead weather changes geometry').not.toEqual(r.shiftedForward.slots);
      });

      await test.step('constant schedule and standing legacy seek agree with forward integration', () => {
        expect.soft(r.constantSeek.pose).toEqual(r.constantLegacy);
        expect.soft(r.constantLegacy).toEqual(r.constantForward);
        expect.soft(r.legacyBefore).toEqual(r.standingForward);
        expect.soft(r.constantForward.slots, 'the two standing environments produce different geometry').not.toEqual(r.standingForward.slots);
      });

      await test.step('same-time seeks resample a new callback and a changed closure', () => {
        expect.soft(r.other.calls).toEqual(r.lateForward.starts);
        expect.soft(r.other.pose).toEqual(r.otherForward);
        expect.soft(r.other.pose.slots).not.toEqual(r.late.pose.slots);
        expect.soft(r.changed.calls).toEqual(r.lateForward.starts);
        expect.soft(r.changed.pose).toEqual(r.changedForward);
        expect.soft(r.changed.pose.slots).not.toEqual(r.other.pose.slots);
      });

      await test.step('the standing environment drives the first advance after a seek', () => {
        expect.soft(r.restored).toEqual(r.standing);
        expect.soft(r.continued).toEqual(r.lateForward.continued);
      });

      await test.step('scheduled replay is repeatable backward and leaves legacy replay isolated', () => {
        expect.soft(r.rerun.calls).toEqual(r.earlyForward.starts);
        expect.soft(r.rerun.pose).toEqual(r.earlyForward.pose);
        expect.soft(r.rerun).toEqual(r.early);
        expect.soft(r.legacyAfter).toEqual(r.legacyBefore);
        expect.soft(r.uncachedLegacy).toEqual(r.uncachedLegacyForward);
      });
    });
  }
}

test('scheduled seek on the runtime poser skips the callback and seeks normally', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.runtimeScheduledSeekProbe());
  expect(r.poser).toBe('runtime');
  expect(r.calls).toEqual([]);
  expect(r.scheduled).toEqual(r.legacy);
  expect(r.before.slots).not.toEqual(r.legacy.slots);
});
