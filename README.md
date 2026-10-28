<p align="center">
  <img src="assets/banner.svg" alt="@rig-c/play - plays rigc's compiled model as DOM elements or one canvas" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rig-c/play"><img src="https://img.shields.io/npm/v/@rig-c/play.svg?style=flat-square&color=FF6B4A" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@rig-c/play"><img src="https://img.shields.io/npm/dm/@rig-c/play.svg?style=flat-square&color=EC4899" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-38BDF8.svg?style=flat-square" alt="license" /></a>
</p>

`@rig-c/play` plays the rigs [rigc](https://github.com/rig-c/core) builds — the
compiled model document `rigc build` writes, `skeleton.model.json` — as **plain
DOM**: one absolutely-positioned `<img>` per rigid slot, posed with a single CSS
`matrix()` write per frame, and deforming meshes on small per-part canvases; or
as **one canvas** per player. It poses through `rig-c/core`, rigc's own posing
core, bundled into the package, and links nothing from Esoteric Software.
`rig-play` is the convenience install name; `spine-html` is the legacy install name.
The compiler is [@rig-c/core](https://github.com/rig-c/core) (npm `@rig-c/core`)
and the part generator [rig-c/parts](https://github.com/rig-c/parts).

## Why

The package began in 0.x as `spine-html`, an experiment in drawing Spine skeletons
without a canvas. Every Spine web runtime rasterizes into one, yet the pose itself is
computed on the CPU, and for a **region attachment** (a rigid part) the bone transform is
a plain affine map that CSS `transform: matrix()` expresses *exactly* — so the rigid tier
could live in the DOM, composited by the browser, inspectable in devtools, styled with
CSS. The idea had been floated on the Spine forum three times since 2014 and never built;
the blockers named were meshes, clipping and DOM update overhead, and the 0.x line
answered each of them (per-part mesh canvases, element-level `clip-path`, dirty-skip).

At 1.0 it stopped being a Spine runtime. It plays the model document `rigc build` writes,
poses it through `rig-c/core` — rigc's own posing core, bundled into the package — and
links nothing from Esoteric Software; a Spine export is refused by name. It gained a
second render mode that draws the whole frame into one canvas. And it took the name
`rig-play`, which says what it is; after 1.8 it moved with the rest of the toolchain to
`@rig-c/play`. `rig-play` and `spine-html` keep being published with the same files, so
links to either earlier name keep working.

### Measured

**Standing comparison against `@esotericsoftware/spine-webgl 4.3.13` (`npm run bench`, #39)** —
measured on 2026-10-17 in **headed** Chromium `151.0.7922.34` on an Apple M4 GPU
(`ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)`, macOS `Darwin 25.6.0`,
10 cores, 32 GiB RAM, `1280×720` viewport, `devicePixelRatio: 1`, 100 warm-up frames +
600 measured frames per row, `loadPerCoreBefore: 0.33`, `loadPerCoreAfter: 0.33` under the
`1.0` load guard; each row is its own page load with only that runtime animating, and grid
scenes batch the official skeletons through one shared WebGL canvas while `small players`
mounts independent player instances):

| scene | runtime | rig | clipped to | fps | pose ms | render ms | drawn players | triangles | draw calls | origin Δpx | live contexts |
| --- | --- | --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| 1 meshed rig animating | dom | `portrait-packed` `turn` | pane | 59.99 | 0.17 | 0.16 | —/1 | 48 | — | 0.007 | —/1 |
| 1 meshed rig animating | canvas | `portrait-packed` `turn` | pane | 59.99 | 0.23 | 0.18 | —/1 | 0 | 0 | 0.007 | —/1 |
| 1 meshed rig animating | official | `portrait-packed` `turn` | pane | 60.00 | 0.05 | 0.13 | 1/1 | 88 | 1 | 0.000 | 1/1 |
| 4 meshed rigs animating | dom | `portrait-packed` `turn` | pane | 60.01 | 0.46 | 0.48 | —/4 | 96 | — | 0.009 | —/1 |
| 4 meshed rigs animating | canvas | `portrait-packed` `turn` | pane | 60.00 | 0.60 | 0.49 | —/4 | 176 | 2 | 0.009 | —/1 |
| 4 meshed rigs animating | official | `portrait-packed` `turn` | pane | 59.99 | 0.13 | 0.17 | 4/4 | 352 | 1 | 0.000 | 1/1 |
| 16 meshed rigs animating | dom | `portrait-packed` `turn` | pane | 60.00 | 0.66 | 0.74 | —/16 | 384 | — | 0.010 | —/1 |
| 16 meshed rigs animating | canvas | `portrait-packed` `turn` | pane | 59.87 | 0.84 | 0.50 | —/16 | 704 | 8 | 0.010 | —/1 |
| 16 meshed rigs animating | official | `portrait-packed` `turn` | pane | 60.00 | 0.21 | 0.30 | 16/16 | 1408 | 1 | 0.000 | 1/1 |
| 36 meshed rigs animating | dom | `portrait-packed` `turn` | pane | 48.28 | 1.24 | 1.42 | —/36 | 1104 | — | 0.010 | —/1 |
| 36 meshed rigs animating | canvas | `portrait-packed` `turn` | pane | 60.11 | 1.15 | 0.85 | —/36 | 1760 | 20 | 0.010 | —/1 |
| 36 meshed rigs animating | official | `portrait-packed` `turn` | pane | 60.00 | 0.43 | 0.49 | 36/36 | 3168 | 1 | 0.000 | 1/1 |
| 64 meshed rigs animating | dom | `portrait-packed` `turn` | pane | 29.07 | 2.13 | 2.69 | —/64 | 1824 | — | 0.010 | —/1 |
| 64 meshed rigs animating | canvas | `portrait-packed` `turn` | pane | 53.99 | 1.62 | 1.17 | —/64 | 3168 | 36 | 0.010 | —/1 |
| 64 meshed rigs animating | official | `portrait-packed` `turn` | pane | 59.99 | 0.42 | 0.54 | 64/64 | 5632 | 1 | 0.000 | 1/1 |
| 1 meshed rig animating (canvas2d) | dom | `portrait-packed` `turn` | pane | 60.00 | 0.18 | 0.28 | —/1 | 48 | — | 0.007 | —/0 |
| 1 meshed rig animating (canvas2d) | canvas | `portrait-packed` `turn` | pane | 60.00 | 0.20 | 0.18 | —/1 | 88 | 1 | 0.007 | —/1 |
| 1 meshed rig animating (canvas2d) | official | `portrait-packed` `turn` | pane | 59.99 | 0.06 | 0.14 | 1/1 | 88 | 1 | 0.000 | 1/1 |
| 16 meshed rigs animating (canvas2d) | dom | `portrait-packed` `turn` | pane | 59.89 | 0.65 | 0.99 | —/16 | 384 | — | 0.010 | —/0 |
| 16 meshed rigs animating (canvas2d) | canvas | `portrait-packed` `turn` | pane | 60.00 | 0.93 | 0.59 | —/16 | 792 | 9 | 0.010 | —/1 |
| 16 meshed rigs animating (canvas2d) | official | `portrait-packed` `turn` | pane | 60.00 | 0.18 | 0.31 | 16/16 | 1408 | 1 | 0.000 | 1/1 |
| 1 held pose | dom | `portrait-packed` `turn` | pane | 60.11 | 0.00 | 0.15 | —/1 | 0 | — | 0.007 | —/1 |
| 1 held pose | canvas | `portrait-packed` `turn` | pane | 60.02 | 0.01 | 0.11 | —/1 | 0 | 0 | 0.007 | —/1 |
| 1 held pose | official | `portrait-packed` `turn` | pane | 60.00 | 0.00 | 0.13 | 1/1 | 88 | 1 | 0.000 | 1/1 |
| 16 held poses | dom | `portrait-packed` `turn` | pane | 60.09 | 0.00 | 0.43 | —/16 | 0 | — | 0.010 | —/1 |
| 16 held poses | canvas | `portrait-packed` `turn` | pane | 59.99 | 0.01 | 0.55 | —/16 | 0 | 0 | 0.010 | —/1 |
| 16 held poses | official | `portrait-packed` `turn` | pane | 60.08 | 0.00 | 0.35 | 16/16 | 1408 | 1 | 0.000 | 1/1 |
| 64 held poses | dom | `portrait-packed` `turn` | pane | 59.99 | 0.02 | 2.43 | —/64 | 0 | — | 0.010 | —/1 |
| 64 held poses | canvas | `portrait-packed` `turn` | pane | 60.10 | 0.02 | 2.56 | —/64 | 0 | 0 | 0.010 | —/1 |
| 64 held poses | official | `portrait-packed` `turn` | pane | 60.10 | 0.00 | 0.90 | 64/64 | 5632 | 1 | 0.000 | 1/1 |
| 1 rigid rig animating | dom | `walk-packed` `walk` | pane | 59.99 | 0.30 | 0.15 | —/1 | 0 | — | 0.007 | —/1 |
| 1 rigid rig animating | canvas | `walk-packed` `walk` | pane | 59.99 | 0.33 | 0.21 | —/1 | 30 | 1 | 0.007 | —/1 |
| 1 rigid rig animating | official | `walk-packed` `walk` | pane | 60.00 | 0.04 | 0.16 | 1/1 | 30 | 1 | 0.000 | 1/1 |
| 16 rigid rigs animating | dom | `walk-packed` `walk` | pane | 60.00 | 0.77 | 0.65 | —/16 | 0 | — | 0.010 | —/1 |
| 16 rigid rigs animating | canvas | `walk-packed` `walk` | pane | 60.00 | 0.62 | 0.47 | —/16 | 480 | 16 | 0.010 | —/1 |
| 16 rigid rigs animating | official | `walk-packed` `walk` | pane | 60.00 | 0.15 | 0.22 | 16/16 | 480 | 1 | 0.000 | 1/1 |
| 64 rigid rigs animating | dom | `walk-packed` `walk` | pane | 59.89 | 1.58 | 1.63 | —/64 | 0 | — | 0.010 | —/1 |
| 64 rigid rigs animating | canvas | `walk-packed` `walk` | pane | 42.00 | 1.50 | 1.21 | —/64 | 1920 | 64 | 0.010 | —/1 |
| 64 rigid rigs animating | official | `walk-packed` `walk` | pane | 60.00 | 0.14 | 0.13 | 64/64 | 1920 | 1 | 0.000 | 1/1 |
| 8 small players | dom | `walk-packed` `walk` | cell | 60.00 | 0.24 | 0.18 | —/8 | 0 | — | 0.012 | —/1 |
| 8 small players | canvas | `walk-packed` `walk` | cell | 60.00 | 0.33 | 0.30 | —/8 | 240 | 8 | 0.012 | —/1 |
| 8 small players | official | `walk-packed` `walk` | cell | 60.00 | 0.09 | 0.24 | 8/8 | 240 | 8 | 0.007 | 8/8 |
| 20 small players | dom | `walk-packed` `walk` | cell | 60.00 | 1.03 | 0.84 | —/20 | 0 | — | 0.015 | —/1 |
| 20 small players | canvas | `walk-packed` `walk` | cell | 59.99 | 0.69 | 0.54 | —/20 | 600 | 20 | 0.015 | —/1 |
| 20 small players | official | `walk-packed` `walk` | cell | 60.00 | 0.13 | 0.24 | 16/20 | 480 | 16 | 0.006 | 16/20 |

Where each side wins and loses on that table, the Safari mesh-backend readings
and the 0.x numbers are in [docs/BENCHMARK.md](docs/BENCHMARK.md).

## Install

```bash
npm i @rig-c/play
npm i -D @rig-c/core    # the build tool: `rigc build` writes the model the player loads
```

The package plays rigs built by [rigc](https://github.com/rig-c/core):
`rigc build` writes a compiled model document, `skeleton.model.json` (spec
`rigc-compiled/3`), next to the Spine pair and the atlas pages. That document
is what the player loads, and it states everything posing and drawing need —
the skeleton, the animations, and where every region sits on its page — so the
`.atlas` and `skeleton.json` beside it are not fetched. Poses are computed by
`rig-c/core`, rigc's own posing core, which is bundled into this package: there
is nothing else to install.

```ts
import { loadModel, RigPlayer } from '@rig-c/play';

const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });

// A positioned element becomes the rig's world origin (Y-up: the rig grows
// upward from it). Layout and scaling are the caller's.
const player = new RigPlayer(rootElement, assets);
player.play('walk');                        // looping; { loop: false } holds at the end

function frame(delta: number) {
  player.frame(delta);                      // step the track by delta × timeScale, draw
}

// Unloading (a cutscene ends, a level swaps): elements first, bitmaps second.
// The unpacked regions are blob URLs — nothing else frees them.
player.dispose();
assets.dispose();
```

### A minimal page

Layout is the caller's, so the first page is the place to see it: the root
element is the rig's world origin, Y up, and scaling it is a CSS transform the
player cannot see. This one loads a build, fits its stage box to a container,
tells the renderer about the scale, and plays the first animation:

```html
<!doctype html>
<meta charset="utf-8">
<div id="stage" style="position: relative; width: 480px; height: 640px; overflow: hidden"></div>
<script type="module">
  import { loadModel, RigPlayer } from 'https://cdn.jsdelivr.net/npm/@rig-c/play@1/dist/index.js';

  const stage = document.getElementById('stage');
  const assets = await loadModel({ modelUrl: 'rigs/look/skeleton.model.json' });
  const root = stage.appendChild(document.createElement('div'));
  const player = new RigPlayer(root, assets);
  player.play(assets.animations[0].name);

  // Fit the rig's stage box (world units, Y up) to the container: scale it, and
  // put the origin where the box's left edge and top land.
  const box = assets.stage ?? player.bounds();
  const scale = Math.min(stage.clientWidth / box.width, stage.clientHeight / box.height);
  root.style.cssText = `position: absolute; transform-origin: 0 0; transform: scale(${scale});
    left: ${-box.x * scale}px; top: ${(box.y + box.height) * scale}px`;
  player.renderer.syncPixelRatio(); // raster at the size on screen, not the unscaled one

  let last = performance.now();
  requestAnimationFrame(function tick(now) {
    player.frame((now - last) / 1000);
    last = now;
    requestAnimationFrame(tick);
  });
</script>
```

`syncPixelRatio()` is what makes the scale cheap: without it the mesh canvases
raster at the device pixel ratio of the *unscaled* rig, `1 / scale²` times more
pixels than the screen shows (ideally 16× at `scale = 0.25`, before backing-store rounding and slack). Call it again after anything that changes the
scale. `tests/readme-page.spec.ts` runs this block as written, against the
package built from this tree.

## Where to read next

- [docs/REFERENCE.md](docs/REFERENCE.md) — what the player does once it is on
  the page: what ships and what is measured (*Status*), then every API section
  from wind, gravity and dragging to the runtime knobs and what they cost.
  `physicsMoved(scope, motion)` supplies apparent world movement to named bone,
  subtree or constraint physics; `moved()` continues to report whole-rig motion.
  See the reference for explicit pivots, units and evaluation/history limits.
- [docs/MIGRATION.md](docs/MIGRATION.md) — coming from 1.8 (meshes draw through
  WebGL by default since 1.9) and from `spine-html` 0.8 (the 0.8 → 1.0 table,
  what has no counterpart, before and after).
- [docs/TESTING.md](docs/TESTING.md) — how the suite holds the picture: the two
  render modes' parity, the clipping oracle, the loading harness, and the
  independent official raster oracle.
- [docs/BENCHMARK.md](docs/BENCHMARK.md) — the readings behind *Measured*, and
  the bench that produces them: scenes, framing, and what a headless number is
  not evidence of.
- [CHANGELOG.md](CHANGELOG.md) — what each version changed;
  [RELEASING.md](RELEASING.md) — how a version is cut.

## Demo (this repository)

```bash
bun install
bun run dev
```

The demo plays rigc's own gallery rigs (`walk`, `flex`, `squash`, `portrait`,
`nod`, `look`, `ride`), each built by `rigc build` from a pinned rigc tag into
`public/rigs/<name>/` on first `dev`/`build` — and each again with `--pack` into
`public/rigs/<name>-packed/`. The same step builds this repository's test rigs
(`tests/rigs/`: `figure`, `glow`, `turned`), which `?rig=` also reaches; nothing
is downloaded but the rigc tag's gallery sources. `bun run fetch-assets` runs it
manually, and it is idempotent.

Debug knobs (query string): `?rig=flex` `?anim=wave` `?count=10` pick the scene,
`?tint=ff8080` tints the whole rig, `?dpr=2` overrides the mesh-canvas backing
ratio, `?timescale=0` freezes the pose (every mesh should report "reused"),
`?expand=0` disables the crack-closing clip overdraw, `?backend=webgl` rasterizes
meshes through the shared WebGL blitter (also a live header select; the stats line
names the active backend), `?clipping=0` turns clips back off (they are then
counted and skipped), and `?time=1.2` seeks every instance to the same pose for
deterministic captures.

## How it works

`loadModel` reads the rig's compiled model document (`rig-c/core`'s `readModel`),
and `RigPlayer` opens an animation on a live track (`openTrack`): bones,
constraints, physics, deform and draw order are posed by the core — all
CPU-side, renderer-agnostic — one `dt` at a time. At load time each region of
the document's `pages` section is cut into its own bitmap (rotation restored),
one blob URL per region — except regions that already cover their whole page,
which are used as they are. Per frame, the pose becomes a `PosedFrame`: for
each slot in draw order, a region's four world corners (order **BL, UL, UR,
BR**) or a mesh's world vertices, page UVs and triangles, its tint, blend and
clip. For a region: flip Y (the frame is Y-up), derive the affine from three
corners, write one `matrix()` string. That's the whole rigid render path.

## License

@rig-c/play's own code is MIT (see [LICENSE](LICENSE)). That says nothing about Spine,
so here is what is true of this package and this repository, stated plainly:

1. The published package — `@rig-c/play`, and `rig-play` and `spine-html`, the same files — **links
   nothing from Esoteric Software**. Its one module bundles the renderer and
   `rig-c/core` (MIT), which poses rigc's model document; no part of the
   [Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes) is in it or
   required beside it.
2. Development tooling pins `@esotericsoftware/spine-webgl` 4.3.13 and its matching
   spine-core dependency for the independent oracle and comparison/benchmark.
   The [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license)
   covers those runtimes, not this project's MIT license. They remain outside
   production source, the public API and the library package; package guards
   and the library-only pack allowlist hold that boundary.
   The optional load-profile harness keeps `spine-pixi-v8` 4.3.13 and PixiJS
   in a separate private install under `bench/oracle`.
3. `rigc build`, which this repository runs to make its fixtures, also writes Spine
   skeleton data (`skeleton.json` and `skeleton.atlas`) beside each model document.
   Development tooling reads this paired export independently. Generated fixtures
   remain gitignored and excluded from the library package. See [NOTICE.md](NOTICE.md).
4. A product that plays that Spine data with a Spine Runtime has integrated the Spine
   Runtimes, whose licence permits it **under Section 2 of the
   [Spine Editor License Agreement](https://esotericsoftware.com/spine-editor-license)**,
   or otherwise on the condition that **each user of the product obtains their own
   Spine Editor license** — the licence's own two routes, restated, not a term of
   this project.

> **What a consumer does with rigc's Spine-format output is governed by Esoteric
> Software's terms**, not by this package — @rig-c/play neither adds those terms nor
> removes them.

The optional load-profile harness fetches checksum-pinned spineboy and raptor
example assets together with their upstream `license.txt`. These development
fixtures are gitignored and excluded from the library package. See
[NOTICE.md](NOTICE.md) for the full notice.
