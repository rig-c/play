# Testing @rig-c/play

Moved from the README unchanged (#182).

## Tests

```bash
bun run test   # builds + serves the demo, then runs chromium + webkit
```

Playwright drives rigc-built gallery and procedural test rigs through the
production `RigPlayer`; its pose comes from `rig-c/core`. CI runs the same
suite on Ubuntu with Chromium and WebKit. Internal parity captures the same
deterministic pose in two modes/backends within one engine. An independent
development oracle also reads the paired Spine export through the official
WebGL runtime. No snapshot goldens are committed. Residue limits are measured
per engine, case and renderer; an A/B design alone does not make a measured
budget portable to another platform. Pose discrepancies remain rigc issues;
the independent oracle checks the resulting raster.

**Internal picture parity** checks the two render modes drawing the same picture: every
scene captured in the DOM mode and in the canvas mode and diffed — bad pixels at
most 1.5% of drawn content on the test-rig scenes (measured floors 0.007–0.524%,
macOS Chromium; each scene's own feature dropped from the canvas mode — tint,
additive blend, clipping, a mesh — scores 4.2–77%) and 2.5% on the gallery
scenes (floors 0.585–1.553%, Chromium and WebKit). The DOM tier's two mesh
backends get the same A/B (`?backend=canvas2d` against `?backend=webgl`, at most
0.5%). Hairline seams are guarded by a deterministic canary (`?expand=0` must
change the canvas2d raster), the canvas2d source sub-rect by another (expand 32
against 8, forced to the sub-rect), the two source rects by an A/B that must
match exactly, and counter tests pin the dirty-skip / grow-only-backing /
clip-counter invariants plus the region corner order (BL, UL, UR, BR) and the
turned-region UVs, read off rig-c's pose against hand-written numbers.

Clipping gets its own oracle (`tests/clipping.spec.ts`), because a clip-path
that went through the wrong transform still parses and still counts as applied.
A clipped capture is compared against the **unclipped** capture of the same
slots masked in **screen space** by the world polygon — built once through the
stage transform, never through an element's local frame, so the check cannot
agree with the renderer by sharing its mistake. What it asserts is occupancy,
not pixel values: outside a 3 px band around the polygon's outline (where the
browser's clip-path antialiasing and the canvas `ctx.clip()` the oracle uses
legitimately differ), **no artwork may survive where the polygon excludes it
and none may go missing where it does not** — both counts absolute, no budget.
Pixel values are logged but not asserted, because a clipped element is drawn
through a mask and its silhouettes come out a shade different all over the
picture; a control capture, clipped by a polygon that removes nothing, pins
that down by coming back byte-identical to the unclipped one.

The loading path is not observable in a rendered frame, so it gets its own
page (`tests/harness.html`, a second build entry) that exposes the library to
the specs directly. Its oracle is the browser: a revoked object URL stops
resolving, so blob ownership — every unpacked URL freed, nothing the caller
owns touched, nothing stranded by a failed load — is asserted rather than
assumed.

### Independent official raster oracle

`tests/oracle.spec.ts` compares real DOM WebGL, DOM canvas2d and whole-canvas
output with `@esotericsoftware/spine-webgl` 4.3.13. The official reader parses
the same build's Spine JSON, atlas and original PNGs independently; it never
receives a `PosedFrame` or the player's alpha-corrected textures. JSON SHA-256
binds the export to the compiled model, and generation/page dimensions fail
closed. Both posers receive the same fixed-step history, crop, origin, scale
and DPR 1; world geometry must agree exactly before raster acceptance.

Captures include the actual images, element canvases, CSS transforms, tint
and clipping. Transparent RGB remains diagnostic, except for additional narrow
raw checks on the whole-canvas PMA case. Acceptance compares those
same captured bytes on black and white backgrounds with the shared pixel
differ, and separately constrains alpha coverage, sum, unequal-pixel count
and maximum. `tests/oracleLimits.ts` stores measured engine/case/mode floors:
zero stays exact; nonzero counts receive 10% plus two units, and nonzero byte
maxima one byte. macOS and Linux have separately measured tables; other
platforms are refused as uncalibrated. Tests never regenerate limits from the
image under test.

Cases cover geometry, tint, clipping, draw order with multiply/screen,
rotated/named regions, additive glow and an original-PMA twin. Named UV and
rotation coverage uses native scale: measured half-scale checker sampling
has additional residue, so arbitrary-scale pixel identity is not claimed.
The shared #37 negative control serves false PMA flags only in the player's
model response, leaving original files and the official reader unchanged.
Each renderer must first pass its healthy capture, then exceed the same
healthy black-composite budget with the altered response. This runs on both
CI browser projects. Original PMA PNG bytes are encoded before either reader
sees them.

The reference uses `antialias:false`, `preserveDrawingBuffer:true` and the
official `pmaAdditiveBatching:false` option to retain additive coverage in
transparent captures. Initialization finishes model/region extraction before
official page uploads, avoiding a measured concurrent WebKit initialization
artifact. Use the required nova-run guard and a unique `TEST_PORT` for a
focused `bun run test tests/oracle.spec.ts --workers=1`; full-suite acceptance
remains CI. Headless results are raster evidence, never device performance.


## Live-frame runtime and fallback tally

Generated from the run-derived `tally.json`, measured with published `rig-c`
2.72.0 and 2.74.0 on Chromium and WebKit.
This is correctness coverage at the four advance steps in `tests/liveFrameProbe.ts`,
not timing evidence or a claim about unsupported features.

Reproduce after installing the pinned dependencies and building fixtures:

```bash
bun run fetch-assets
bunx --no-install playwright test --config playwright.live-frame.config.ts > live-frame-contracts.log
node scripts/summarize-live-frame.mjs live-frame-contracts.log
```

The table below is generated from `LIVE_FRAME_CASE` records, paired with their
browser test labels; counts come from `summarize-live-frame.mjs`. All contract
tests must pass before summarizing; a partial log is not a complete tally.

| rig-c | Rows | Runtime | Fallback | Numeric differences | Pixel differences | Pixel skips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2.72.0 | 58 | 18 | 40 | 0 | 0 | 0 |
| 2.74.0 | 58 | 30 | 28 | 0 | 0 | 0 |

Fallback reasons below may overlap. Model-wide refusals preempt per-animation
checks; unreported features are not proven supported or absent.

| 2.74.0 fallback feature | Rows | Rigs |
| --- | ---: | --- |
| `clipping` | 16 | figure |
| `physics-constraint` | 6 | look |
| `slider-constraint` | 6 | look |
| `path-constraint` | 4 | ride |
| `dark-colour-timeline` | 2 | duo |

Each row is one browser/rig/animation combination. `fallback` denotes the named
oracle refusal; the feature table above groups those reasons. Numeric and pixel
difference columns below are from the 2.74.0 run.

| Browser | Rig | Animation | 2.72.0 | 2.74.0 | Numeric differences | Pixel differences |
| --- | --- | --- | --- | --- | ---: | ---: |
| chromium | walk | walk | runtime | runtime | 0 | 0 |
| chromium | flex | wave | fallback | runtime | 0 | 0 |
| chromium | flex | gust | fallback | runtime | 0 | 0 |
| chromium | squash | bounce | fallback | runtime | 0 | 0 |
| chromium | portrait | idle | runtime | runtime | 0 | 0 |
| chromium | portrait | gaze | runtime | runtime | 0 | 0 |
| chromium | portrait | turn | fallback | runtime | 0 | 0 |
| chromium | nod | idle | fallback | runtime | 0 | 0 |
| chromium | nod | bow | fallback | runtime | 0 | 0 |
| chromium | look | turn | fallback | fallback | 0 | 0 |
| chromium | look | tilt | fallback | fallback | 0 | 0 |
| chromium | look | sweep | fallback | fallback | 0 | 0 |
| chromium | ride | ride | fallback | fallback | 0 | 0 |
| chromium | ride | coast | fallback | fallback | 0 | 0 |
| chromium | figure | walk | runtime | runtime | 0 | 0 |
| chromium | figure | mask | fallback | fallback | 0 | 0 |
| chromium | figure | detail | runtime | runtime | 0 | 0 |
| chromium | figure | bare | runtime | runtime | 0 | 0 |
| chromium | figure | tilted | fallback | fallback | 0 | 0 |
| chromium | figure | tilted_moved | fallback | fallback | 0 | 0 |
| chromium | figure | nudge | fallback | fallback | 0 | 0 |
| chromium | figure | cover | fallback | fallback | 0 | 0 |
| chromium | figure | window | fallback | fallback | 0 | 0 |
| chromium | figure | inverse | fallback | fallback | 0 | 0 |
| chromium | figure | nested | fallback | fallback | 0 | 0 |
| chromium | glow | burn | runtime | runtime | 0 | 0 |
| chromium | glow | canary | runtime | runtime | 0 | 0 |
| chromium | turned | hold | runtime | runtime | 0 | 0 |
| chromium | duo | shift | fallback | fallback | 0 | 0 |
| webkit | walk | walk | runtime | runtime | 0 | 0 |
| webkit | flex | wave | fallback | runtime | 0 | 0 |
| webkit | flex | gust | fallback | runtime | 0 | 0 |
| webkit | squash | bounce | fallback | runtime | 0 | 0 |
| webkit | portrait | idle | runtime | runtime | 0 | 0 |
| webkit | portrait | gaze | runtime | runtime | 0 | 0 |
| webkit | portrait | turn | fallback | runtime | 0 | 0 |
| webkit | nod | idle | fallback | runtime | 0 | 0 |
| webkit | nod | bow | fallback | runtime | 0 | 0 |
| webkit | look | turn | fallback | fallback | 0 | 0 |
| webkit | look | tilt | fallback | fallback | 0 | 0 |
| webkit | look | sweep | fallback | fallback | 0 | 0 |
| webkit | ride | ride | fallback | fallback | 0 | 0 |
| webkit | ride | coast | fallback | fallback | 0 | 0 |
| webkit | figure | walk | runtime | runtime | 0 | 0 |
| webkit | figure | mask | fallback | fallback | 0 | 0 |
| webkit | figure | detail | runtime | runtime | 0 | 0 |
| webkit | figure | bare | runtime | runtime | 0 | 0 |
| webkit | figure | tilted | fallback | fallback | 0 | 0 |
| webkit | figure | tilted_moved | fallback | fallback | 0 | 0 |
| webkit | figure | nudge | fallback | fallback | 0 | 0 |
| webkit | figure | cover | fallback | fallback | 0 | 0 |
| webkit | figure | window | fallback | fallback | 0 | 0 |
| webkit | figure | inverse | fallback | fallback | 0 | 0 |
| webkit | figure | nested | fallback | fallback | 0 | 0 |
| webkit | glow | burn | runtime | runtime | 0 | 0 |
| webkit | glow | canary | runtime | runtime | 0 | 0 |
| webkit | turned | hold | runtime | runtime | 0 | 0 |
| webkit | duo | shift | fallback | fallback | 0 | 0 |
