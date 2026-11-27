# Keyed scene camera fixtures

Both 128 × 128 scenes use the synthetic actor and foreground from Create's
public [composed-direction example]. Play's [composed-direction fixture]
documents the source archive, Parts actor build, overscan derivation and MIT
license. The overscan plate extends the original edge texels by 15 px. Both
camera reports are the exact bytes emitted by Parts 2.63.0 with Core 3.11.0 and
Bun 1.4.4. The reports bind their packed model by SHA-256 and record PASS with
zero edge overruns, nonopaque source texels and nonopaque output pixels.

| Files | Producer inputs and expected reading |
| --- | --- |
| `linear.scene.json`, `linear.report.json` | The public overscan scene plus a linear camera on the four-second `idle`. At two seconds its pan is `[12, -4]` and zoom is `1.25`. It uses the checked-in `overscan` model and page, byte-identical to the camera compose outputs. |
| `eased/camera-eased.scene.json`, `eased/report.json`, `eased/skeleton.model.json`, `eased/skeleton.png` | The same actor and foreground, with the actor placed at `[16, 16]` at scale `0.75`, a moving backdrop, and named ease, stepped and linear camera segments. `eased/background-camera-marked.png` is the source backdrop with 1,496 opaque RGB texels changed to make motion visible. The one-shot `shot` ends at authored time `0.73` and compiled time `0.7300000190734863`. |
| `eased/expected.json` | Parts `resolveSceneCamera` samples between report rows, paired with Core poses of the exact packed model at the corresponding compiled phases. The producer verified the sampler against all 59 report rows. The fixture retains the independent row-interpolation controls. |

To reproduce the reports, prepare the public overscan input layout described in
the composed-direction fixture. Use the source Parts CLI and its Core 3.11.0
dependency. Copy the linear input as `camera.scene.json`. For the eased build,
copy `camera-eased.scene.json` and put the supplied marked backdrop at
`inputs/background-camera-marked.png`. Both scene inputs resolve the same
public actor build at `evidence/compose-character`.

```sh
bun "$PARTS_SOURCE/cli.ts" compose --scene camera.scene.json --out camera
bun "$PARTS_SOURCE/cli.ts" compose --scene camera-eased.scene.json --out eased
```

Verify the checked-in reports, inputs and assets from this directory.

```sh
shasum -a 256 -c SHA256SUMS
```

## Acceptance

`scene-camera.spec.ts` uses the Parts report and off-grid oracle for output
geometry, with a 0.001 authored output px per-axis tolerance. It reads the
actual drawn frame and canvas pixels for both backends. The direct clip
control uses the existing Play `figure` rig’s authored `window` attachment on
posed regions and meshes. It maps that posed input into the camera example’s
world units and checks the projected clip against actual occupancy with
separate no-clip and shifted-clip controls. The direct renderer also has to
restore the caller’s viewport and pixel ratio after each draw. The two Parts reports have no
skeletal clipping attachment. The composed-direction `clip` variant tests
Parts’ baked canvas crop.

The regular Playwright configuration supplies the compiled `figure` rig. To
run this spec alone in a Nova snapshot, the following command builds only
that local rig, then runs this single Chromium spec without the demo build or
the gallery asset fetch. Use a Nova image with the locked Playwright browser
and Bun dependencies installed.

```sh
scratch=$(mktemp -d)
mkdir -p "$scratch/figure"
node_modules/.bin/rigc build --rig tests/rigs/figure/rig.json \
  --motion tests/rigs/figure/motion.json --out "$scratch/figure" --pack
cat > "$scratch/playwright.config.mjs" <<'CONFIG'
export default {
  testDir: process.cwd() + '/tests',
  testMatch: 'scene-camera.spec.ts',
  workers: 1,
  timeout: 60_000,
  use: {
    browserName: 'chromium',
    deviceScaleFactor: 1,
    launchOptions: { args: ['--renderer-process-limit=1'] },
  },
}
CONFIG
SCENE_CAMERA_FIGURE_DIR="$scratch/figure" \
  node node_modules/@playwright/test/cli.js test --config "$scratch/playwright.config.mjs"
```

The legacy pixel test prints `[scene-camera legacy]` and attaches
`legacy-rgba-at-2s` with the browser version,
backend, stage size, model hash and RGBA hash for the model-only mount. To
compare against a Chromium Canvas2D capture from the base source, set
`SCENE_CAMERA_BASELINE_DIR` to its emitted artifact directory containing
`browser.json` and `model-only-2s.rgba`. The test checks matching inputs and
browser version and compares the full RGBA bytes. Both captures use a
128 × 128 Fixed mount in a 160 × 160 Chromium viewport at DPR 1, the
`canvas2d` backend and the public `idle` take advanced by two seconds. To
compare just the legacy case, use `--grep 'preserves legacy pixels'` with
the focused configuration. Keep the base receipt
outside the repository. The per-engine legacy comparisons run in every
acceptance run and use their own model-only output as the reference.

[composed-direction example]: https://github.com/rig-c/create/tree/ed949ef5a44e443a89f640ab0d6b8f8fac0ca1ae/templates/example-composed-direction
[composed-direction fixture]: ../composed-direction/README.md
