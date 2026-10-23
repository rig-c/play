import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

/**
 * An eased set switch (#174): `{ ease: seconds }` on the set calls turns the
 * bones a set draws over the duration and swaps the attachments on the frame
 * nearest the middle. The bar was written before measuring; the probe
 * (tests/setEaseProbe.ts) computes its figures on `wind-wave`, `@rig-c/parts`'
 * public wind example with its gesture set (built by scripts/fetch-assets.sh),
 * in both stepper modes, at frame(1/60).
 *
 * - B1: the progress from start to end is non-decreasing and inside [0, 1]
 *   (1e-9), activation and deactivation, while the clip moves the bones.
 * - B2: on a held clip the covered bones' world angles are monotonic from
 *   base to drawn and back, with no overshoot.
 * - B3: the attachments swap on the frame whose u is nearest ½ (a tie goes
 *   to the later frame): 0.5 s lands on u = ½ exactly, 0.25 s on a tie.
 * - B4: from the first frame after the ease ends, every bone's world rotation
 *   is an instant switch's within 1e-6°, and the slot identity has 0 diffs.
 * - B5: without the option and with `ease: 0`, the frames are main's
 *   (gesture, drape, wave; both modes; 480 frames). In the run: the two are
 *   one. Against main: the hashes recorded on the unmodified tree, read from
 *   the JSON file `RIG_PLAY_EASE_B5_BASELINE` names when it is set.
 * - B6: a reversal mid-ease makes no frame-to-frame step larger than the
 *   uninterrupted ease's own largest.
 * - B7: drape with #173's D/R metric, on both clips: (i) ease + carry's largest
 *   D over the ease ≤ #173's instant carry's largest D over the same window
 *   (30 frames), the behaviour the merged player already has; (ii) with gravity
 *   0 (`g0`), ease + carry's largest D ≤ max(R, R_after) of the g0 no-option
 *   run — the impulse check with the chain's re-settling under gravity taken
 *   out. The gravity-on window against max(R, R_after), none, carry, the ease
 *   alone and ease + reset are reported.
 * - B8: planted controls (test-only private switches) fail B3 and B1.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('B5: without the option, and with ease 0, the frames are unchanged (#174)', async ({ page }) => {
  test.setTimeout(180_000);
  const { hashes } = await page.evaluate(() => window.rigPlayHarness.setEaseB5Probe());
  console.log(`B5 hashes: ${JSON.stringify(hashes)}`);
  for (const rig of ['gesture', 'drape', 'wind-wave']) {
    for (const mode of ['track', 'tracks']) {
      expect(hashes[`${rig}/${mode}/ease0`], `${rig}/${mode} ease 0 = absent`).toBe(hashes[`${rig}/${mode}/absent`]);
    }
  }
  const baseline = process.env.RIG_PLAY_EASE_B5_BASELINE;
  if (baseline !== undefined && baseline !== '') {
    const main = JSON.parse(readFileSync(baseline, 'utf8')) as Record<string, string>;
    expect(Object.keys(main).sort()).toEqual(Object.keys(hashes).sort());
    for (const [key, hash] of Object.entries(main)) expect(hashes[key], `${key} = main`).toBe(hash);
  }
});

test('an eased set switch turns the drawn bones and swaps at the midpoint (#174)', async ({ page }) => {
  test.setTimeout(300_000);
  const probe = await page.evaluate(() => window.rigPlayHarness.setEaseProbe());
  const f = (v: number, d = 6): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));

  const phaseRow = (label: string, ph: (typeof probe.runs)[number]['activation']) =>
    [label, ph.frames, f(ph.pMin, 9), f(ph.pMax, 9), f(ph.pDrop, 12), ph.skipped, ph.monotonic, ph.swapFrame, ph.expectedSwap, ph.swapClean, f(ph.endFrameWorldDiff, 9), f(ph.endWorldDiff, 9), ph.endIdentityDiffs].join(' | ');
  console.log(
    [
      'mode/ease/plant/phase | frames | p min | p max | p drop | skipped | B1 | swap | expected | clean | end-frame Δ° | after-end Δ° | id diffs',
      ...probe.runs.flatMap((r) => [
        phaseRow(`${r.mode}/${r.ease}/${r.plant}/act`, r.activation),
        phaseRow(`${r.mode}/${r.ease}/${r.plant}/deact`, r.deactivation),
      ]),
    ].join('\n'),
  );
  console.log(`mid-ease slotIdentity (frame before the swap): ${JSON.stringify(probe.runs.filter((r) => r.plant === 'none').map((r) => ({ mode: r.mode, ease: r.ease, ...r.midIdentity })))}`);
  for (const h of probe.held) {
    console.log(`B2 ${h.mode}: monotonic ${h.monotonic}, base drift ${f(h.baseDrift, 12)}°; ` +
      Object.entries(h.bones).map(([b, v]) => `${b} base ${f(v.base, 4)} drawn ${f(v.drawn, 4)} act [${v.activation.map((x) => f(x, 3)).join(', ')}] deact [${v.deactivation.map((x) => f(x, 3)).join(', ')}]`).join('; '));
  }
  for (const r of probe.reversal) {
    console.log(`B6 ${r.mode}: own max ${f(r.ownMax, 6)}°, reversed max ${f(r.reversedMax, 6)}° (at call ${f(r.atCall, 6)}, first after ${f(r.firstAfter, 6)}), instant reversal max ${f(r.instantMax, 6)}°`);
  }
  console.log(['B7 mode | clip | option | R | D_act | D_first | max over activation (frame) | R_after | max over deactivation',
    ...probe.drape.map((r) => [r.mode, r.clip, r.diagnostic === undefined ? r.option : `${r.option} (${r.diagnostic})`, f(r.R, 4), f(r.dAct, 4), f(r.dFirst, 4), `${f(r.maxAct, 4)} (${r.maxActFrame})`, f(r.Rafter, 4), f(r.maxDeact, 4)].join(' | '))].join('\n'));
  console.log(`B5 hashes: ${JSON.stringify(probe.b5.hashes)}`);
  console.log(`bad ease: ${JSON.stringify(probe.badEase)}; before play same: ${probe.beforePlaySame}; paused holds: ${probe.pausedHolds}, ends same: ${probe.pausedEndsSame}`);

  for (const mode of ['track', 'tracks'] as const) {
    const run = (ease: number, plant: string) => {
      const found = probe.runs.find((r) => r.mode === mode && r.ease === ease && r.plant === plant);
      if (found === undefined) throw new Error(`no ${mode}/${ease}/${plant} run`);
      return found;
    };
    for (const ease of [0.5, 0.25]) {
      const r = run(ease, 'none');
      for (const [name, ph] of [['activation', r.activation], ['deactivation', r.deactivation]] as const) {
        const label = `${mode} ease ${ease} ${name}`;
        // B1
        expect(ph.skipped, `${label} measured every frame`).toBe(0);
        expect(ph.monotonic, `${label} B1`).toBe(true);
        // B3
        expect(ph.swapFrame, `${label} B3 swap frame`).toBe(ph.expectedSwap);
        expect(ph.swapClean, `${label} B3 old then new`).toBe(true);
        // B4
        expect(ph.endWorldDiff, `${label} B4 world`).toBeLessThanOrEqual(1e-6);
        expect(ph.endIdentityDiffs, `${label} B4 identity`).toBe(0);
      }
    }
    // 0.5 s lands on u = ½ (frame 15), 0.25 s between frames 7 and 8 (the tie goes to 8).
    expect(run(0.5, 'none').activation.expectedSwap).toBe(15);
    expect(run(0.25, 'none').activation.expectedSwap).toBe(8);

    // B8: the planted controls fail the bar lines they plant.
    const swap0 = run(0.5, 'swap-at-0');
    expect(swap0.activation.swapFrame, `${mode} plant swap-at-0 fails B3`).not.toBe(swap0.activation.expectedSwap);
    expect(swap0.deactivation.swapFrame, `${mode} plant swap-at-0 fails B3 (deactivation)`).not.toBe(swap0.deactivation.expectedSwap);
    const over = run(0.5, 'overshoot');
    expect(over.activation.monotonic, `${mode} plant overshoot fails B1`).toBe(false);
    expect(over.deactivation.monotonic, `${mode} plant overshoot fails B1 (deactivation)`).toBe(false);

    // B2
    const held = probe.held.find((h) => h.mode === mode);
    expect(held?.baseDrift, `${mode} B2 the held clip holds`).toBe(0);
    expect(held?.monotonic, `${mode} B2`).toBe(true);

    // B6
    const rev = probe.reversal.find((r) => r.mode === mode);
    if (rev === undefined) throw new Error(`no ${mode} reversal`);
    expect(rev.reversedMax, `${mode} B6`).toBeLessThanOrEqual(rev.ownMax);
    expect(rev.instantMax, `${mode} B6 control: an instant reversal jumps`).toBeGreaterThan(rev.ownMax);

    // B7
    for (const clip of ['idle', 'shift'] as const) {
      const d = (option: string, diagnostic?: 'g0') => {
        const found = probe.drape.find((r) => r.mode === mode && r.clip === clip && r.option === option && r.diagnostic === diagnostic);
        if (found === undefined) throw new Error(`no ${mode}/${clip}/${option}${diagnostic === undefined ? '' : ` (${diagnostic})`} drape run`);
        return found;
      };
      // (i) no worse than #173's instant carry over the same window.
      expect(d('ease+carry').maxAct, `${mode}/${clip} B7(i) ease+carry ≤ instant carry`).toBeLessThanOrEqual(d('carry').maxAct);
      // (ii) gravity off: no impulse beyond the idle's own motion.
      const g0 = d('none', 'g0');
      expect(d('ease+carry', 'g0').maxAct, `${mode}/${clip} B7(ii) ease+carry with gravity 0`).toBeLessThanOrEqual(Math.max(g0.R, g0.Rafter));
      for (const option of ['carry', 'ease', 'ease+carry', 'ease+reset']) expect(Number.isFinite(d(option).maxAct)).toBe(true);
    }
  }

  // The option's own rules.
  for (const bad of probe.badEase) {
    expect(bad.error, `ease ${bad.value}`).toContain('options.ease');
    expect(bad.unchanged, `ease ${bad.value} changes nothing`).toBe(true);
  }
  expect(probe.beforePlaySame).toBe(true);
  expect(probe.pausedHolds).toBe(true);
  expect(probe.pausedEndsSame).toBe(true);
});
