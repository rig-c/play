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
as **one canvas** per player. It poses through rigc's bundled `rig-c/runtime`
and `rig-c/core`, and links nothing from Esoteric Software.
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

The [standing comparison and its conditions](https://github.com/rig-c/play/blob/main/docs/BENCHMARK.md#measured) record these tradeoffs:

| scene | observation in that comparison |
| --- | --- |
| High-count meshed grids | Batched official WebGL leads. |
| Held poses | DOM and canvas modes skip rasterization. |
| Rigid-heavy grids | DOM avoids per-player canvas blits. |
| Many independent players | DOM and canvas share a WebGL context across players. |

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
the bundled `rig-c/runtime` and `rig-c/core`: there is nothing else to install.

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

- [docs/REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md) — what the player does once it is on
  the page: what ships and what is measured (*Status*), then every API section
  from wind, gravity and dragging to the runtime knobs and what they cost.
  `physicsMoved(scope, motion)` supplies apparent world movement to named bone,
  subtree or constraint physics; `moved()` continues to report whole-rig motion.
  See the reference for explicit pivots, units and evaluation/history limits.
- [docs/MIGRATION.md](https://github.com/rig-c/play/blob/main/docs/MIGRATION.md) — adding live-frame consumers, coming
  from 1.8 (meshes draw through WebGL by default since 1.9) and from `spine-html`
  0.8 (the 0.8 → 1.0 table, what has no counterpart, before and after).
- [docs/TESTING.md](https://github.com/rig-c/play/blob/main/docs/TESTING.md) — how the suite holds the picture: the two
  render modes' parity, the clipping oracle, the loading harness, and the
  independent official raster oracle.
- [docs/BENCHMARK.md](https://github.com/rig-c/play/blob/main/docs/BENCHMARK.md) — the readings behind *Measured*, and
  the bench that produces them: scenes, framing, and what a headless number is
  not evidence of.
- [CHANGELOG.md](https://github.com/rig-c/play/blob/main/CHANGELOG.md) — what each version changed;
  [RELEASING.md](https://github.com/rig-c/play/blob/main/RELEASING.md) — how a version is cut.

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

`loadModel` reads the rig's compiled model document (`rig-c/core`'s `readModel`).
With the default `poser: 'auto'`, `RigPlayer` uses `rig-c/runtime`'s
`compileRuntime` and `RuntimePose` for covered models and animations, drawing
from a borrowed `LiveFrame` exposed by `player.liveFrame()`. Features and
operations outside that path's coverage use the `rig-c/core` oracle —
`openTrack` for a single track, `openTracks` for track composition. Models with
physics constraints stay on that oracle path. `player.poser` reports `"runtime"` or
`"oracle: <reason>"`; `poser: 'oracle'` selects the oracle explicitly. Posing
stays CPU-side and renderer-agnostic, advancing one `dt` at a time.
Both renderers accept a borrowed `LiveFrame` or a detached `PosedFrame`.
`player.posedFrame()` returns a snapshot that survives later pose mutations;
a live frame is valid only until the next pose mutation. See
[Borrowing a live frame](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#borrowing-a-live-frame) for the
buffer layout, lifetime and fallback policy.
At load time each region of the document's `pages` section is cut into its own
bitmap (rotation restored), one blob URL per region — except regions that
already cover their whole page, which are used as they are. Both frame forms
describe, for each slot in draw order, a region's four world corners (order
**BL, UL, UR, BR**) or a mesh's world vertices, page UVs and triangles, its tint,
blend and clip. For a region: flip Y (the frame is Y-up), derive the affine from three
corners, write one `matrix()` string. That's the whole rigid render path.

## License

See [NOTICE.md](NOTICE.md) for licensing and third-party notices.
