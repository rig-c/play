import { expect, test } from '@playwright/test';

/**
 * A set switch that re-poses bones kicks the physics hung under them (#173),
 * and `{ physics: 'carry' | 'reset' }` on the set calls handles it. The bar was
 * written before measuring; the probe (tests/setPhysicsProbe.ts) computes its
 * figures on the public `drape` rig, in both stepper modes and on two idle
 * clips: `idle` turns the torso, `shift` slides it.
 *
 * - B1: without the option the switch reproduces the impulse — D at the
 *   switch or the first frame after it exceeds the idle range R.
 * - B2/B6: with `carry`, D at the switch and at the first frame are each
 *   ≤ max(R, R_after), in `openTrack` and in `tracks: true`; R_after is the
 *   switched pose's own idle range, measured on the no-option run. The idle's
 *   own motion depends on the pose: on `idle` a turning torso pushes the
 *   raised forearm, about 2.9× farther from its pivot, about 2.9× harder
 *   (R 1.47 × 2.9 ≈ 4.3 predicts R_after 4.21), so the bound is the idle's
 *   motion and not the carry figures (the `g0` and `up` diagnostics rule
 *   gravity out). On `shift` R_after < R and the bound is R. The next 60
 *   frames are reported.
 * - B3: `reset` is reported; no bar beyond "no throw".
 * - B4: deactivation with `carry`, on B2's bounds.
 * - B5: (a) the option absent, `{}` and `{ physics: undefined }` draw the same
 *   frames; (b) the control chain's frames are identical with every option;
 *   (c) `gesture` (drawn sets, no physics) draws the same frames with and
 *   without the option.
 * - B7: carry with M forced to the identity (a test-only private switch)
 *   fails B2 — the metric sees the mapping — and draws today's frames exactly
 *   (the trial step behind M leaves nothing behind).
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('a set switch carries or resets the physics under the bones it re-poses (#173)', async ({ page }) => {
  test.setTimeout(180_000);
  const probe = await page.evaluate(() => window.rigPlayHarness.setPhysicsProbe());

  const fmt = (v: number): string => v.toFixed(4);
  const rows = [...probe.runs, ...probe.diagnostics].map((r) =>
    [r.mode, r.clip, r.diagnostic === undefined ? r.option : `${r.option} (${r.diagnostic})`, fmt(r.R), fmt(r.dAct), fmt(r.dFirst), fmt(r.max60), fmt(r.Rafter), fmt(r.deact.dAct), fmt(r.deact.dFirst), fmt(r.deact.max60), r.frameHash].join(' | '),
  );
  console.log(['mode | clip | option | R | D_act | D_first | max60 | R_after | deact D_act | deact D_first | deact max60 | frames', ...rows].join('\n'));
  console.log(`no-physics (gesture) frames: ${JSON.stringify(probe.noPhysics)}`);

  for (const mode of ['track', 'tracks'] as const) {
    for (const clip of ['idle', 'shift'] as const) {
      const run = (option: string) => {
        const found = probe.runs.find((r) => r.mode === mode && r.clip === clip && r.option === option);
        if (found === undefined) throw new Error(`no ${mode}/${clip}/${option} run`);
        return found;
      };
      const none = run('none');
      const carry = run('carry');
      const reset = run('reset');
      const planted = run('plant');
      const label = (what: string) => `${mode}/${clip} ${what}`;

      // The clip moves the chain on every frame, so R is a range and not 0.
      expect(none.R, label('none R')).toBeGreaterThan(0);
      for (const r of [carry, reset, planted]) expect(r.R, label(`${r.option} R`)).toBe(none.R);

      // B1: today's switch kicks the chain.
      expect(Math.max(none.dAct, none.dFirst), label('none impulse')).toBeGreaterThan(none.R);

      // B2 / B6: carry keeps the switch inside the idle range, and the first frame inside the range of the pose it is in.
      // The idle's own motion in either pose: R before the switch, R_after in the switched pose, both from the no-option run.
      const bound = Math.max(none.R, none.Rafter);
      expect(carry.dAct, label('carry D_act')).toBeLessThanOrEqual(bound);
      expect(carry.dFirst, label('carry D_first')).toBeLessThanOrEqual(bound);

      // B4: so does the deactivation, on the same bounds.
      expect(carry.deact.dAct, label('carry deact D_act')).toBeLessThanOrEqual(bound);
      expect(carry.deact.dFirst, label('carry deact D_first')).toBeLessThanOrEqual(bound);

      // B3: reset ran (reported above).
      expect(Number.isFinite(reset.max60), label('reset')).toBe(true);

      // B7: the identity in place of M fails B2, and is exactly today's switch.
      expect(Math.max(planted.dAct, planted.dFirst), label('plant')).toBeGreaterThan(planted.R);
      expect(planted.frameHash, label('plant = none')).toBe(none.frameHash);

      // B5(b): the control chain never notices.
      expect(none.controlR, label('control moves')).toBeGreaterThan(0);
      for (const r of [carry, reset, planted]) expect(r.control === none.control, label(`${r.option} control`)).toBe(true);
    }

    // B5(a): the option absent, {} and { physics: undefined } are one path.
    expect(probe.absentVariantsSame[mode], `${mode} absent variants`).toBe(true);

    // B5(c): no physics under the drawn bones — every option draws the same frames.
    const np = probe.noPhysics[mode];
    expect(np.carry, `${mode} no-physics carry`).toBe(np.none);
    expect(np.reset, `${mode} no-physics reset`).toBe(np.none);
  }

  expect(probe.badOptionError).toContain('"bogus"');
  expect(probe.badOptionsObjectError).toContain('"carry"');
  expect(probe.badOptionUnchanged).toBe(true);
  expect(probe.beforePlaySame).toBe(true);
});
