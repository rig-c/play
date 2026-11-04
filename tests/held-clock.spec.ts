import { expect, test } from '@playwright/test';

/**
 * The held-clock step (#248): `hold(true)` makes `advance`/`frame` move the
 * physics clock by the step and re-pose at the same track time.
 *
 * The fixture is the `held` test rig: cloth's three-link physics chain
 * (`link_1..3`, `tip`) hung from an anchor the `sway` clip turns, beside a card
 * whose position, attachment (`a` → `b` at 0.5 s, back at 1.5 s) and draw order
 * (over everything from 1 s) are keyed, and a banner mesh whose deform and
 * colour are keyed. Only `link_1..3` and `tip` are physics-driven.
 *
 * The bars, written before the first run (the issue's, made numeric):
 * - B1: held at 0.7 s and at 1.2 s, single track (`sway`) and `tracks: true`
 *   (`glide`: `sway` without its draw-order key, which the live tracks do not
 *   mix), over 60
 *   held frames of 1/60: every bone that is not physics-driven, and every slot's
 *   z, draw order, blend, tint, attachment and page — and every non-physics
 *   slot's corners or vertices — equal the first held frame exactly; `time`
 *   does not move; the physics bones change. The fixture check: at 0.7 s the
 *   card shows `card_b` under the banner, at 1.2 s over everything (`sway`).
 * - B2: held at 0.7 s while the anchor swings the chain, the tip moves more than
 *   1e-3 world units over 60 held frames and its distance to rest (the tip after
 *   1,200 held frames) at frame 60 is under half its distance at frame 0.
 * - B3: after 60 held frames, `hold(false)` and one frame: the tip equals a core
 *   track given the same steps (zero steps on a clock that moves the held dt) at
 *   tolerance 0, it differs from a reset (the same time reached without a hold)
 *   by more than 1e-3, and its jump is no larger than the largest frame-to-frame
 *   tip move over 4 s of plain play.
 * - B4: rigs with no physics constraint (`walk` on the runtime poser and on the
 *   oracle), 30 held frames: the posed frame's JSON, the root's DOM, the
 *   generation and `time` are all unchanged.
 *
 * Planted controls (`heldPlant`, test-only), each one of today's ways round
 * the missing step, each expected to fail the bar named:
 * - `advance`: the held step is a plain `advance` (keep stepping) → B1, B4;
 * - `freeze`: the held step does nothing (`pause`, `timeScale` 0) → B2;
 * - `reset`: `hold(false)` replays the time as `seek` does → B3.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('B1: a held step leaves every animation timeline where it stands; only physics moves', async ({ page }) => {
  const { bar1 } = await page.evaluate(() => window.rigPlayHarness.heldClockProbe());
  const clean = bar1.filter((r) => r.plant === null);
  expect(clean.map((r) => `${r.mode} ${r.time}`)).toEqual(['track 0.7', 'track 1.2', 'tracks 0.7', 'tracks 1.2']);
  for (const r of clean) {
    expect(r.poser).toMatch(/^oracle/);
    expect(r.frames).toBe(60);
    expect(r.animatedDiffs, `${r.mode} ${r.time}`).toEqual([]);
    expect(r.timesMoved).toBe(false);
    expect(r.physicsChanged).toBe(true);
    // `glide`, the tracks' clip, is `sway` without the draw-order key: the card stays under the banner.
    expect(r.card).toEqual({ region: 'card_b', last: r.mode === 'track' && r.time === 1.2 });
  }
  for (const r of bar1.filter((x) => x.plant === 'advance')) {
    expect(r.animatedDiffs.length, `${r.mode} ${r.time}`).toBeGreaterThan(0);
  }
});

test('B2: a displaced chain settles under held stepping', async ({ page }) => {
  const { bar2 } = await page.evaluate(() => window.rigPlayHarness.heldClockProbe());
  const clean = bar2.find((r) => r.plant === null)!;
  expect(clean.tipMove).toBeGreaterThan(1e-3);
  expect(clean.d60).toBeLessThan(clean.d0 / 2);
  const freeze = bar2.find((r) => r.plant === 'freeze')!;
  expect(freeze.tipMove > 1e-3 && freeze.d60 < freeze.d0 / 2).toBe(false);
});

test('B3: releasing the hold continues the physics it settled, no reset, no jump', async ({ page }) => {
  const { bar3 } = await page.evaluate(() => window.rigPlayHarness.heldClockProbe());
  const clean = bar3.find((r) => r.plant === null)!;
  expect(clean.coreDiff).toBe(0);
  expect(clean.resetDiff).toBeGreaterThan(1e-3);
  expect(clean.jump).toBeLessThanOrEqual(clean.maxStep);
  expect(clean.time).toBeCloseTo(42 / 60 + 1 / 60, 12);
  const reset = bar3.find((r) => r.plant === 'reset')!;
  expect(reset.coreDiff === 0 && reset.resetDiff > 1e-3 && reset.jump <= reset.maxStep).toBe(false);
});

test('B4: a held step on a rig with no physics is a no-op, byte for byte', async ({ page }) => {
  const { bar4 } = await page.evaluate(() => window.rigPlayHarness.heldClockProbe());
  const clean = bar4.filter((r) => r.plant === null);
  expect(clean.map((r) => r.poser)).toEqual(['runtime', 'oracle: explicitly selected']);
  for (const r of clean) {
    expect(r.frameSame, r.poser).toBe(true);
    expect(r.domSame, r.poser).toBe(true);
    expect(r.generationSame, r.poser).toBe(true);
    expect(r.timeSame, r.poser).toBe(true);
  }
  for (const r of bar4.filter((x) => x.plant === 'advance')) {
    expect(r.frameSame && r.domSame && r.generationSame && r.timeSame, r.poser).toBe(false);
  }
});

test('hold: reads back, play clears it, pause still wins, moved() applies while held, bad input is refused by name', async ({ page }) => {
  const { api } = await page.evaluate(() => window.rigPlayHarness.heldClockProbe());
  expect(api).toEqual({
    initial: false,
    afterHold: true,
    afterPlay: false,
    pausedHeldTimeMoved: false,
    pausedHeldPhysicsMoved: false,
    badArg: 'hold expects true or false, got "yes"',
    nonFinite: 'advance step must be finite, got Infinity',
    nonFiniteLeftTrackUsable: true,
    movedWhileHeld: true,
  });
});
