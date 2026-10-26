# @rig-c/play reference

The sections below were the README's *Status* and the reference under its
*Install* (#182), moved here unchanged. A link into the old README lands at the
same heading in the file this table names:

| Old README anchor | Now |
| --- | --- |
| `#status` | [Status](#status), below |
| `#wind-gravity-and-dragging-the-rig` | [Wind, gravity and dragging the rig](#wind-gravity-and-dragging-the-rig), below |
| `#drawing-your-own-frames` | [Drawing your own frames](#drawing-your-own-frames), below |
| `#reading-the-pose` | [Reading the pose](#reading-the-pose), below |
| `#drawing-some-slots-only` | [Drawing some slots only](#drawing-some-slots-only), below |
| `#attachment-sets-setsjson` | [Attachment sets (`sets.json`)](#attachment-sets-setsjson), below |
| `#slot-identity-snapshot-slotidentity` | [Slot identity snapshot (`slotIdentity()`)](#slot-identity-snapshot-slotidentity), below |
| `#several-tracks` | [Several tracks](#several-tracks), below |
| `#adjusting-bones` | [Adjusting bones](#adjusting-bones), below |
| `#live-physics-parameters` | [Live physics parameters](#live-physics-parameters), below |
| `#one-load-several-players` | [One load, several players](#one-load-several-players), below |
| `#loading-it-yourself` | [Loading it yourself](#loading-it-yourself), below |
| `#loading-for-the-canvas-mode-only-and-data-regions` | [Loading for the canvas mode only, and `data:` regions](#loading-for-the-canvas-mode-only-and-data-regions), below |
| `#pages-that-ship-at-another-resolution` | [Pages that ship at another resolution](#pages-that-ship-at-another-resolution), below |
| `#premultiplied-pages-pma` | [Premultiplied pages (`pma`)](#premultiplied-pages-pma), below |
| `#what-unloading-frees` | [What unloading frees](#what-unloading-frees), below |
| `#one-part-per-page` | [One part per page](#one-part-per-page), below |
| `#runtime-knobs-and-what-they-cost` | [Runtime knobs and what they cost](#runtime-knobs-and-what-they-cost), below |
| `#coming-from-18-meshes-draw-through-webgl-by-default` | [MIGRATION.md](MIGRATION.md#coming-from-18-meshes-draw-through-webgl-by-default) |
| `#coming-from-spine-html-08`, `#08--10`, `#no-counterpart-in-100`, `#before-and-after` | [MIGRATION.md](MIGRATION.md#coming-from-spine-html-08) |
| `#tests`, `#independent-official-raster-oracle` | [TESTING.md](TESTING.md) |
| `#benchmark-dom-canvas-and-official-webgl` | [BENCHMARK.md](BENCHMARK.md#benchmark-dom-canvas-and-official-webgl) |

*Measured*, *Install*, *A minimal page*, *Demo (this repository)*, *How it
works* and *License* stay in the [README](../README.md).

## Status

**Production.** The questions this started as a PoC to answer — how far does the
DOM actually go, and how cheap is it — are answered with on-device numbers: the
practical scenario (a character or two, mostly holding pose, a few parts
deforming) holds **60 fps on every engine measured**, and the 10-skeleton
stress scene holds 45 fps on the weakest one (Safari, webgl backend). Ships
with a self-contained test suite (backend visual parity + invariants) and CI.

**Two render modes.** `mode: 'dom'` (the default, everything below) draws a rig
as elements. `mode: 'canvas'` draws the whole frame into **one `<canvas>`** per
player: every slot as textured triangles from its atlas page through the same
shared WebGL context the mesh tier's `webgl` backend uses, into one rect, then
one `drawImage` onto the player's canvas. Tint and dark (two-colour) tint are
vertex colours, blend modes are batch state, clips are cut on the CPU by
`rig-c/core`'s clipper — no `clip-path`, no SVG filter, no per-slot element.
`RigPlayer` swaps between the two in place (`player.mode = 'canvas'`). The
canvas mode is held against the DOM tier pixel for pixel on the parity suite's
frozen poses (bad pixels ≤ 1.6% of drawn content, measured, macOS Chromium and
WebKit); which mode is faster where is **not measured on a device yet**, so the
default stays `dom`.

- ✅ Region attachments (rigid parts): exact affine mapping, draw-order via `z-index`,
  attachment swaps, alpha
- ✅ Atlas unpacking at load time (90°-packed regions restored to the orientation
  the region's UVs name, held against hand-written UVs on a rigc build whose region
  is packed turned),
  so the rigid per-frame path never touches a canvas — a region that covers its whole
  page is passed through uncut, and `revokeRegions()` frees the rest when a skeleton
  is unloaded
- ✅ Mesh attachments (deform tier): small per-part canvases sized to the mesh's world
  bounds, interleaved with the rigid `<img>` slots in one stacking context — the DOM
  handles the bones, a rasterizer handles the warps
- ✅ Blend modes via `mix-blend-mode` (additive = `plus-lighter`)
- ✅ Crack-free mesh seams on the canvas2d backend: canvas2d antialiases each
  triangle's clip edge, so two triangles sharing an edge each leave it partly
  transparent and the background shows through as a hairline — plainest over a
  light background behind light art (#104). Each edge of a triangle's clip
  polygon is moved 0.5px outward along its own normal so neighbours overlap —
  the texture is continuous across shared edges, so the overlap is invisible
  (`?expand=0` shows the cracks for comparison)
- ✅ RGB tinting (skeleton × slot × attachment color) via an SVG `feColorMatrix`
  reference filter per element — an exact channel multiply that works identically on
  `<img>` and `<canvas>` without touching the raster (needs reference-filter support,
  Safari 15+; verified pixel-level on Chromium and WebKit). Dark/two-color tint is
  not expressible this way and stays out of scope
- ✅ DPR-aware mesh canvas backing store: `renderer.pixelRatio` (defaults to
  `devicePixelRatio`; if you scale the root element, fold that scale in)
- ✅ Dirty-skip: a mesh whose canvas-space vertices match the last raster reuses it;
  whole-pixel translations allow at most half a Float32 ULP at the current world
  coordinate, strictly less than half a pixel. CSS still tracks the translation, while
  stationary axes stay exact and the comparison anchor changes only on a redraw.
  10 frozen spineboys: WebKit ~141 → ~0.5 ms/frame
- ✅ Clipping attachments as element-level CSS `clip-path`: spine-core's semantics
  (one active clip at a time, applied from the clip's slot through its end slot
  inclusive), with the polygon expressed in each element's own local frame — the
  inverse of the `<img>` matrix for rigid slots, the canvas translate for mesh
  slots. Covers **part masks** (a clip with a real end slot, like the figure test
  rig's `mask` animation) and **whole-skeleton clips** (an end slot that never
  arrives, which takes a fast path: one `clip-path` on the root instead of one per
  element). **Inverse clips** are supported too: the region they keep has a hole
  in it, so it needs two rings, and `polygon()` carries only one — a box and a
  polygon listed inside one `polygon()` become a single self-intersecting ring
  whose even-odd fill leaves a wedge along the seam between them (measured, on a
  corner of spineboy's boot). So an inverse clip is written as a two-subpath
  `path(evenodd, …)` whose outer ring is the element's own box. The whole feature
  is element-level, so both mesh backends see the same thing and neither raster
  path knows clipping exists; `renderer.clipping = false`
  restores the old counted-and-skipped behaviour. Concave polygons go to CSS as
  authored — the convex decomposition spine's CPU clipper performs exists to feed a
  triangle rasterizer and has no job here. Two things this does not do: Spine's
  clipper convexifies an *inverse* polygon (convex hull) where CSS clips it as
  authored, so the two agree exactly when that polygon is convex — which is the
  shape `inverse` is meant for; and the cost of many simultaneous `clip-path`s on
  real-device Safari is **not measured** (the headless numbers that exist are not
  Safari evidence — see Measured above)
- ✅ Safari mesh cost root-caused by on-device triangulation (two corrections deep):
  the early "~15× slower per-triangle path" was a **headless-WebKit artifact**
  (software rasterization), and the follow-up "on par with Chromium" held only for
  in-callback JS time. Real-Safari rAF rates — rigid ×10 = 60 fps, meshed ×1 =
  37 fps, meshed ×10 = 3–4 fps with JS flat at ~4–5 ms — put the real cost in the
  GPU process: Safari antialiases canvas2d **clip paths**, so the per-triangle clip
  mapping pays a per-triangle AA-mask tax (the same AA that caused the seam cracks)
- ✅ WebGL blit backend for the mesh tier, the default since 1.9 (#109;
  `renderer.meshBackend = 'canvas2d'` keeps the 2d raster). All dirty meshes are shelf-packed into
  **one shared offscreen WebGL context** (module-level — browsers cap contexts at
  ~16), drawn as textured triangles with premultiplied alpha, then rect-blitted
  onto the same per-part canvases with an unclipped `drawImage` — cheap on Safari.
  Everything element-level is unchanged: z-index interleave, tint filter,
  `mix-blend-mode`, dirty-skip, grow-only backing. GL rasterizes shared triangle
  edges seamlessly, so this path needs no crack overdraw. Falls back to canvas2d
  when WebGL is unavailable or the context is lost. Backend parity verified by
  headless Chromium+WebKit screenshot diffs (glow / clipping / tint scenes;
  sub-pixel edge differences only). On-device Safari, meshed ×10 with every mesh
  redrawn per frame: **3–4 fps (canvas2d) → 45 fps (webgl)**

### Wind, gravity and dragging the rig

A rig's physics links answer the world the page sets (#121). `environment()`
gives them spine-core's skeleton-level wind and gravity — x right, **y down**,
the runtime's axes; each constraint's authored `wind` / `gravity` is its
response, so a link stating `wind: 0` feels none — and `moved()` tells them the
page moved or turned the rig, in the skeleton's world (y up), so a dragged rig
trails its cloth. Both apply from the next step, at any time. Added to the
minimal page above:

```ts
// A wind slider, -1 (left) to 1 (right). The runtime starts at wind [1, 0], so set calm first.
const wind = stage.appendChild(Object.assign(document.createElement('input'),
  { type: 'range', min: '-1', max: '1', step: '0.01', value: '0' }));
player.environment({ wind: [0, 0] });
wind.addEventListener('input', () => player.environment({ wind: [Number(wind.value), 0] }));

// Drag the rig: move the root, and tell the physics how far, in world units with y up.
let held = null; // the pointer's position while a drag is held
stage.addEventListener('pointerdown', (e) => { if (e.target !== wind) held = { x: e.clientX, y: e.clientY }; });
addEventListener('pointerup', () => { held = null; });
stage.addEventListener('pointermove', (e) => {
  if (!held) return;
  const dx = e.clientX - held.x, dy = e.clientY - held.y;
  held = { x: e.clientX, y: e.clientY };
  root.style.left = `${parseFloat(root.style.left) + dx}px`;
  root.style.top = `${parseFloat(root.style.top) + dy}px`;
  player.moved({ x: dx / scale, y: -dy / scale });
});
```

The block is plain JavaScript, so it runs inside the page as written.
`environment(null)` returns to the runtime's start values, and `environment()`
reads what stands. The state is the player's, not a track's: every track and
layer answers the same world, and a `seek` replays under the environment as it
stands — no history is kept. A rig with no physics ignores both.
`tests/readme-page.spec.ts` runs this block in the minimal page.

The demo's `wind.html` is the same thing with controls: wind and gravity
sliders, a drag on the stage, and the rig named by `?model=` (the `cloth` test
rig by default; `bun run dev`, then `/wind.html?model=rigs/<name>/skeleton.model.json`).
`tests/wind-page.spec.ts` holds it.

The player owns one track: `play(name, { loop })` opens an animation at its first
pose, `frame(dt)` steps it (or `advance(dt)` then `draw()`, to time the two
apart), `pause()` / `resume()` hold and release it, `timeScale` scales every
step, and `seek(t)` moves it to a time. A seek is "reopen, then step to the
time" in `seekStep` increments (1/60 s by default) — never a jump, because a
physics rig has history and its pose at a time depends on the steps that
reached it. The physics integrates on rig-c's render clock (`physicsClockStep`:
each step and 2⁻³⁰ of it more), so stepping at a fixed rate — `frame(1/60)`, a
capture, a test — shows no single-frame spring jump where a frame ends on a
physics step; the animation, the events and `time` stay on the steps (#103). `on('event', …)` receives the event keys each step crosses, in the
runtime's order across a loop's wrap; `on('complete', …)` fires once a step
completes a cycle. `skin` (a constructor option) poses under a named skin;
without it the rig is posed the way a fresh Spine skeleton is, with no skin
set. `player.color` multiplies a whole-rig colour into every slot's tint.
`player.renderer` is the `DomRenderer` underneath, whose knobs and counters
are below.

**What it refuses, by name.** A Spine export (`.json`, `.skel`) is refused
before anything is fetched: this package reads compiled models and nothing
else. A document whose `spec` is not one `rig-c/core` reads is refused with the
core's own sentence plus "build it with `rigc build`", and so is a
`rigc-compiled/1` document, which predates the `pages` section.

`@rig-c/play` is a third-party renderer and is not affiliated with or endorsed by
Esoteric Software.

### Drawing your own frames

`RigPlayer` is the convenient path; the renderer underneath takes a plain
record, so anything that can produce one can draw through it:

```ts
import { DomRenderer, type PosedFrame } from '@rig-c/play';

const renderer = new DomRenderer(rootElement, assets.regionImages, assets.pageImages);
renderer.render(frame); // frame: PosedFrame
```

```ts
PosedFrame { order: PosedSlot[] }                     // the slots that draw, in draw order
PosedSlot = { slot; z; blend: 'Normal'|'Additive'|'Multiply'|'Screen';
              tint: [r, g, b, a]; dark?: [r, g, b];
              clip?: { polygon: number[]; inverse: boolean; convex: boolean } }   // world space, Y up
          & ( { kind: 'region'; region: string; corners: number[] /* BL, UL, UR, BR */;
                page: string; pma: boolean; uvs: number[] /* page UVs at the corners */ }
            | { kind: 'mesh'; page: string; pma: boolean; vertices: number[];
                uvs: number[]; triangles: number[]; sequence: number } )
```

`player.posedFrame()` returns the record the player would draw. Two things the
renderer reads off it by identity rather than by value: every slot a clip
covers carries the **same** `clip` object (one that covers every slot of the
frame takes the one-`clip-path`-on-the-root path), and a mesh's `uvs` and
`triangles` are the same arrays from frame to frame for the same texture
mapping (a new array re-rasters the mesh).

### Borrowing a live frame

`player.liveFrame()` borrows the current draw buffers until the next pose mutation
(`advance`, `play`, `seek`, `repose`, a set/skin/filter change, or disposal).
A colour refresh that overwrites borrowed tint data also invalidates checked leases.
`player.poser` reads `"runtime"` for a covered active animation, or
`"oracle: <reason>"` naming a missing model/animation feature or an operation
that needs the oracle. Covered event keys are delivered to the same listeners, in the same order and
with the same payload shape as the oracle. Re-entrant listeners keep the rest
of the current delivery batch. Event keys are not silently ignored. A mixed track,
local adjustment or attachment-set operation continues on the oracle when the
runtime cannot execute it. `new RigPlayer(root, assets, { poser: 'oracle' })`
selects that reference path explicitly.

```ts
player.advance(dt);
const live = player.liveFrame();
renderer.render(live); // DomRenderer and CanvasRenderer accept both frame forms
for (let i = 0; i < live.count; i++) {
  const attachment = live.attachments[live.drawOrder[i]];
  // World x/y pairs: live.vertices[attachment.offset .. offset + count).
  // Final RGBA: live.tint[attachment.slotIndex * 4 .. + 4).
  // attachment.uvs, triangles, page, pma, blend, dark and clip describe the draw.
}
```

`drawOrder[0..count)` contains attachment indices. The remaining buffer capacity
is not a draw list. `LiveNumbers` exposes read-only indexed values and length,
not writable backing storage. Runtime attachment metadata includes the exact
`skin` and `placeholder` table identity; `attachment` is the display name and
need not be unique. On the oracle fallback `placeholder` is explicitly `null`,
because its snapshot does not expose that table key. `slotIndex` always means
the setup slot index, not the index among visible draws.

The runtime preallocates its production buffers and render view. Development
builds add generation-capturing leases: reading a held frame **or a retained
nested buffer** after mutation throws `LIVE_FRAME_STALE`; drawing a stale lease
also refuses before touching the renderer. Writes and backing-storage escape
routes refuse as `LIVE_FRAME_READONLY`. `liveFrameChecks` can explicitly select
this diagnostic behavior. Those leases allocate; they are reported separately
from the production allocation measurement. Listener delivery creates the same
detached callback payloads as the oracle and is measured separately; the
no-listener advance/liveFrame path reuses event records and frame buffers. The oracle fallback packs a borrowed
view from its snapshot and also carries no zero-allocation promise.

Supported skin changes rebuild the view and preserve accumulated track time
and its wrapped animation time. A held checked live view becomes stale; retained
snapshots keep their old values. Unsupported views still name the oracle fallback.

A production borrowed view is reused and overwritten: keeping its object does
not keep its values or its old generation. Use `player.posedFrame()` for a
detached snapshot that survives later steps, including when the runtime is
selected. Existing `posedFrame(slots)` filtering and `slotIdentity()` generation
coherence remain available. Bone/identity readback can perform an on-demand
oracle read; it is not part of the runtime advance/live-frame allocation path.
The core runtime entry is experimental and the bundled core version is pinned
exactly; consumers of this package need no separate core installation.

### Reading the pose

Two reads off the pose the player holds — the last `frame`/`advance`/`seek`,
or the setup pose before `play` — for framing a stage around a rig:

```ts
const head = player.bone('head');   // { x, y, a, b, c, d, rotationX, rotationY, scaleX, scaleY, active }
const box = player.bounds();        // { x, y, width, height } | null — world units, Y up
```

`bone` is the core's world transform for that bone (`rig-c/core`'s `RawBone`,
unchanged), and an unknown name is refused by name. `bounds` is the box of
every region's four corners and every mesh's vertices in the frame record the
renderer takes; a slot under a clip counts only inside the clip polygon's own
box, an inverse clip removes nothing, and bounding boxes, paths and points do
not draw and do not count. Both cost nothing until called and read the same
numbers in `dom` and `canvas` mode.

`readSetupMesh` reads a named mesh from loaded assets before or during playback,
including an attachment the setup pose does not select:

```ts
import { readSetupMesh } from '@rig-c/play';

const mesh = readSetupMesh(assets, { slot: 'flag', attachment: 'alternate' });
// mesh: { slot, attachment, skin, vertices, triangles, hull }
// vertices: flat world x,y pairs, Y up; hull counts vertices, or is null.
```

Names are exact slot names and attachment table keys, not display names or atlas
regions. Omitted or `null` skin means no skin set, as for a fresh player. A named
`skin` uses that skin's activation lists with default-table fallback; the returned
`skin` names the supplying table. `skin: 'all'` uses all activation lists and
refuses differing definitions rather than guessing a merge order. Linked meshes
retain the requested identity and borrow source topology/bindings; unweighted
vertices use the queried slot's bone. Inactive bones retain core's zero matrix.
The result and its arrays are detached and mutable. Missing slot/attachment/skin,
non-mesh and ambiguous targets throw core's named `CoreInputError` messages;
setup/non-finite refusals propagate unchanged. The read creates no player and
changes no document, existing player, time, generation or rendered frame.

**Setup-slider boundary (core 2.66.0):** selected meshes include setup-slider
deform, exactly as core's setup pose does. Unselected meshes use stored geometry
through the same setup constraint/reset-physics matrices, without switching the
attachment or borrowing another selection's deform. Core measured **four of six
nonselected official-runtime comparisons differing by up to
`2.9999999999999982` world units (about 3.0)**: spine-core 4.3.13's
`computeWorldVertices` borrows the selected slot's deform, including for a linked
mesh with `timelines: false`. The other two nonselected calls and all three
selected reads agree exactly. This wrapper passes core's output through; it does
not correct or round it. Stored-only formula comparisons therefore have a
different domain from selected geometry with setup deform. See
[core AUTHORING §14, including S1538_09](https://github.com/rig-c/core/blob/v2.66.0/docs/AUTHORING.md#14-read-a-named-mesh-at-setup).

### Drawing some slots only

`slots` is a draw filter — an allow list of slot names or a predicate — settable up
front and on a live player. The pose is the whole rig's whatever the filter:
bones, constraints, physics, `bone()`, `adjust`, events and tracks see no filter;
only the draw does, in both modes, and `bounds()` reads the drawn slots. A
clipping slot the filter leaves out does not clip. An allow list naming a slot
the document does not have is refused by name.

```ts
const hand = new RigPlayer(frontRoot, assets, { slots: ['hand_f', 'arm_f_lo'] });
player.slots = (slot) => !slot.startsWith('weapon');
```

Two players over one `ModelAssets` share the load but each poses the rig. To
pose it once and draw it twice — a hand drawn again in front of another
character — give a second renderer this player's pose under another filter:

```ts
const front = new DomRenderer(frontRoot, assets.regionImages, assets.pageImages);
// each frame, after player.frame(dt):
front.render(player.posedFrame(['hand_f', 'arm_f_lo']));
```

### Attachment sets (`sets.json`)

A build from `@rig-c/parts` (or authored alongside a rig) may ship a `sets.json`
sidecar beside `skeleton.model.json` declaring named attachment sets — an
expression, a viseme, a side view — under spec `"rig-parts-sets/1"` or
`"spine-parts-sets/1"`:

```json
{
  "spec": "rig-parts-sets/1",
  "sets": {
    "smile": {
      "slots": { "face": "face_smile", "prop": "prop_star" },
      "hides": []
    },
    "wink": {
      "slots": { "face": "face_wink" },
      "hides": ["prop"]
    }
  }
}
```

`loadModel` probes `sets.json` in the model document's directory by default
(treating a 404 as "no sets"; pass `setsUrl: null` to skip the probe, or a URL
string to require one at another path) and validates every slot and attachment
name against the model document. `player.sets()` (and `assets.sets`) returns the
declared `readonly RigSet[]` (`{ name, slots, hides }`), and `player.setSet(name)`
switches the active set at runtime (#134):

```ts
player.sets();          // [{ name: 'smile', slots: { ... }, hides: [] }, ...]
player.setSet('smile'); // covered slots take the set's attachments; <slot>_still and hides are hidden
player.set;             // 'smile'
player.setSet(null);    // restore base / track attachments
```

The active set is applied immediately to the held pose (including the setup pose
before `play`) and after track evaluation on every subsequent `advance`, so a
track key on a covered slot is overridden while the set is active and restored
on the next frame when cleared with `setSet(null)`. Uncovered slots keep their
track attachments, mesh deforms and sequence frames untouched; when no set is
active (`null`), track evaluation runs with zero extra work and produces
byte-identical poses. An unknown set name throws by name; on a build without
`sets.json`, `sets()` is empty (`[]`) and `setSet` throws.

**Several sets at once** (#168): sets that touch disjoint slots can be active
together — a mouth viseme driven by audio beside an arm gesture driven by
input, without building every combination as its own set:

```ts
player.setSets(['viseme_o', 'gesture_chin']); // exactly these, together
player.removeSet('viseme_o');                 // the gesture stays
player.addSet('viseme_a');                    // beside the active ones; already active = no change
player.activeSets;                            // ['viseme_a', 'gesture_chin'] in sets.json order
player.set;                                   // null: several are active (one active → its name)
player.setSets([]);                           // restore base / track attachments
```

A set *touches* every slot it covers, every slot it `hides` and the
`<base>_still` companion it hides. Two active sets touching the same slot are
refused by name — `sets "viseme_o" and "talk_point" both touch slot "mouth"` —
and nothing changes; precedence is never guessed. Disjoint sets compose as the
union of each alone, whatever the order they were named or added in, and every
rule above (applied to the held pose, after track evaluation, uncovered slots
untouched) holds for the composition. `setSet(name)` keeps meaning *exactly this
one* (`setSets([name])`) and `setSet(null)` is `setSets([])`; an unknown or
repeated name throws by name. `slotIdentity()` reports the list as `sets`
beside `set`.

**Drawn bones** (#170): a set from `@rig-c/parts` that replaces a limb
(a *gesture* subset set) carries `drawn` — the world rotation, in degrees
(CCW, Y up), each of its bones was painted at — and its attachments are
placed in the frame of the bones posed there:

```json
"wave": {
  "slots": { "arm_upper": "arm_upper_wave", "arm_lower": "arm_lower_wave" },
  "drawn": { "shoulder": 50, "elbow": 95 }
}
```

While such a set is active its bones are posed at those angles, the way
`rig-parts check --set` poses them: in document order, each drawn bone's
local rotation is the drawn angle less its world rotation at local 0 under
its already-posed parents (no constraint applied), computed once when the set
is activated. On a track that local rotation replaces the clip's rotation
of that bone on every pose, before `adjust` (so `adjust` still has the last
word); every other bone keeps playing. Activating or clearing a drawn set
poses the held pose again at the same time. Two active sets drawing the same
bone are refused by name, as two sets touching one slot are. A `drawn` naming
a bone the document does not have is refused when `sets.json` is loaded.

**Physics under a drawn bone** (#173). A physics chain hung from a bone a set
re-poses — a sleeve under a raised arm — reads the jump to the drawn angle as
motion: the constraint remembers where its bone was and pointed, so the
switch kicks it (on the test rig `drape`, a 110° raise throws the sleeve's
tip about 297 units off the arm in the switch itself, against an idle
frame-to-frame range of 1.5). Every set call takes an option for the chains
under the bones the switch re-poses:

```ts
player.setSets(['raise'], { physics: 'carry' }); // also setSet, addSet, removeSet
```

- `'carry'` moves each affected constraint's remembered state by the rigid
  turn of its deepest re-posed ancestor, so the chain keeps its pose relative
  to the arm and goes on swinging from there (the switch itself moves the
  sleeve 0 relative to the arm; gravity then re-settles it in the turned pose,
  which is physics and not the switch).
- `'reset'` restarts each affected constraint at the new pose, as a physics
  `reset` key does: the chain snaps straight along its bones (17 units on the
  same raise) and settles from there.
- Absent, nothing changes: today's behaviour, frame for frame. This stays the
  default.

`'carry'` is recommended: on `drape` it moves the sleeve 0 relative to the arm
at the switch and 0 at the deactivation, where `'reset'` moves it 17 units at
the switch and 118 at the deactivation (no option: 297 and 298).

A constraint is affected when its bone is a bone whose drawn rotation the call
adds, removes or changes, or a descendant of one; every other chain is not
touched. The option does nothing before `play` (the setup pose carries no
physics state) and nothing when no physics hangs under a re-posed bone. Three limits:

- Carry moves the positions and direction the constraint remembers; a
  constraint with `x`/`y` keeps its translation offsets along the world axes,
  unturned.
- A drawn bone nested under a carried chain reads its new world from the
  chain's state before the carry.
- A later `seek` replays from the start with the sets then active, as it
  always has, so it does not reproduce a carried switch.

**Easing a drawn set in and out** (#174). A drawn set snaps its bones to the
drawn angles in one frame. `ease` turns them there over a duration instead,
and swaps the attachments halfway, the way an alternate drawing takes over
at a middle angle:

```ts
player.setSets(['wave_r'], { ease: 0.5 });   // also setSet, addSet, removeSet
player.setSets([], { ease: 0.5 });           // and back
```

- **The curve.** Each bone whose drawn rotation the call adds, removes or
  changes turns from what it shows to its new local rotation along the
  shorter way: `start + shortestΔ(start, end) · smoothstep(u)`, with
  `u = elapsed / ease`. Going on, the start is the clip's value at the time
  (it moves with the clip) and the end the drawn local; going off, the start
  is the drawn local and the end the clip's value. So the progress from start
  to end never leaves `[0, 1]` and never turns back, while the clip plays
  underneath. On `@rig-c/parts`' public wind example with its gesture set
  (`wave_r`, 0.5 s), it is 0 to 1 and non-decreasing on every frame, on and
  off; on a clip that holds the arm still, the sleeve's world angle goes
  −119.32° → −110° and back with no overshoot.
- **The swap.** The held pose draws the attachments it showed until the frame
  whose `u` is nearest ½, then the set's (a tie goes to the later frame; the
  next step is predicted from the current one, so a constant `dt` lands on
  the nearest frame). On the wind example at `frame(1/60)`, 0.5 s swaps on
  frame 15 and 0.25 s on frame 8. `activeSets`, `set` and `slotIdentity().sets`
  name the call's sets from the call on; `slotIdentity().slots` reports what
  the pose draws, so before the swap it shows the previous attachments.
- **The end.** On the frame the elapsed time reaches `ease`, the player is in
  exactly the instant switch's state: from then on every bone matches an
  instant switch made at the same frame (0° measured) and the slot identity
  too.
- **Time.** The elapsed time is the player's step (`dt × timeScale`): a
  paused player, or a step of 0, holds the ease where it is. Before `play`
  there is nothing to step and the switch is instant; so is a call that
  re-poses no bone. A `seek` or a skin change lands an ease in flight at
  once.
- **A call during an ease** starts a new one from the angles shown (no jump:
  reversing a 0.5 s ease at 0.3 makes no frame-to-frame step larger than the
  ease's own), and the attachment swap starts again from what is drawn. A
  call without `ease` during an ease lands it at once.
- `ease: 0`, or no `ease`, is the instant switch, frame for frame. Anything
  but a finite number at or above 0 is refused by name before anything
  changes.

With physics: `ease` and `physics: 'carry'` carry the chains under the eased
bones on every eased frame — before each step, the turn the frame's blend
makes is read as #173's switch is (a trial pose at the previous time) and
the chains are moved by it — so the ease's own turn is not read as motion.
`physics: 'reset'` with `ease` restarts them once, at the call. On `drape`
(0.5 s raise, sleeve tips in the arm's frame): the ease alone moves the
sleeve up to 30 units a frame relative to the arm (the chain reads the turn
as motion), ease + carry at most 3.9 on the `idle` clip (its idle ranges are
1.5 hanging and 4.2 raised) and 2.3 on `shift` (0.85 and 0.07), where
gravity re-settles the chain in the turning arm's frame (with gravity at 0,
0.83 against 0.84).

`sets.json` keys are read strictly. Besides `slots`, `hides` and `drawn`, a
set may carry `drawnLength`, `registration`, `threshold` and `focus`, which
parts writes and which place nothing under `check --set`: play reads past them
by name (validating `focus`, when present, as `[x, y]` of two finite numbers)
and gives them no meaning. Any other key, on a set or on the document (which
takes `spec`, `sets` and `threshold`), is refused by name rather than ignored.

To switch one driver's set while another stays — a new viseme while a gesture
holds — name the new list in one call (`setSets(['viseme_a', 'gesture_chin'])`)
or `removeSet` then `addSet`; the first re-poses once, the second twice.

### Slot identity snapshot (`slotIdentity()`)

To inspect which attachment key, owning skin and visibility state each slot
holds on the current frame — for a parts explorer or review overlay — without
`seek`, `repose`, or restarting physics (#144):

```ts
const snap = player.slotIdentity();
// {
//   generation: number,              // matches player.generation and player.posedFrame().generation
//   set: string | null,              // the one active set (player.set); null when none or several
//   sets: readonly string[],         // every active set (player.activeSets), sets.json order
//   skin: string | null,             // active skin name (player.skin ?? null)
//   slots: readonly [                // every slot in posed draw order (z = 0 .. slots.length - 1)
//     {
//       slot: string,
//       z: number,
//       attachment: string | null,   // resolved attachment key when drawn, null when not drawn
//       skin: string | null,         // skin owning the resolved attachment ('default' or named skin), or null
//       reason: 'hidden' | 'no-attachment' | 'timeline-null' | 'set-hide' | null,
//     },
//     ...
//   ],
// }
```

Every slot in the posed draw order (`z = 0 .. slots.length - 1`, hidden and null
ones included) appears in `snap.slots`:

- Drawn slots (`reason: null`) appear in the same `z` order as
  `player.posedFrame().order`, naming the resolved attachment key (`attachment`)
  and the skin that owns it (`skin`).
- Non-drawn slots report `attachment: null`, `skin: null`, and why they are
  absent from `posedFrame().order`:
  - `'set-hide'` — hidden by an active attachment set (`set.hides` or a
    `<base>_still` companion of a slot the set covers or hides).
  - `'timeline-null'` — cleared by an active attachment timeline key (`null`).
  - `'no-attachment'` — no attachment in the setup pose or under the active skin
    (or a non-drawable attachment kind such as clipping/boundingbox/path/point).
  - `'hidden'` — filtered out by `player.slots` or on an inactive bone under the
    current skin.
- `snap.generation` ticks monotonically with `player.generation` and
  `player.posedFrame().generation` whenever the held pose, active set, active
  skin or slot filter changes. The returned snapshot is frozen and cached per
  generation, so reading it repeatedly on a held pose is allocation-free and
  mutates no pixel or physics state.

### Several tracks

A base on track 0, a layer over it, a one-shot played once and mixed back out —
rig-c's live tracks (`openTracks`), whose mixing is the Spine runtime's
`AnimationState` held at tolerance 0:

```ts
player.play('idle');                                        // track 0, as always
player.play('smile', { track: 1, loop: false, mix: 0.2 });  // held at its end, mixed in over 0.2 s
player.play('wave', { track: 2, loop: false, mix: 0.1 });   // a one-shot…
player.queueClear(2, { mix: 0.1 });                         // …mixed back out over its last 0.1 s
player.queue('idle_b', { track: 0, mix: 0.3 });             // after the current idle cycle completes
player.clear(1, { mix: 0.2 });                              // the layer gone, the base showing through
player.entry(2);                                            // { animation, loop, trackTime, animationTime, duration, alpha, additive } | null
player.play('blink', { track: 3, alpha: 0.6 });            // the same clip at a weight…
player.setAlpha(3, 0.85);                                   // …changed while it plays
player.play('breath', { track: 4, additive: true });        // adds to what the tracks below posed
```

**Weight and additive layers** (rig-c 2.39.0, the runtime's `TrackEntry.alpha` and
`additive`): `alpha` (0..1, default 1) multiplies every timeline the entry applies;
`setAlpha(track, alpha)` changes the current entry's weight from the next pose and
re-poses the held pose. It does not touch events — an entry fires at any alpha, 0
included, and one mixing out fires none — or attachments: the current entry keeps
its attachments at any alpha, one mixing out keeps none. `additive: true`, fixed
when the entry is set or queued, adds the entry's keyed bone and deform values to
what the tracks below posed instead of replacing them, so a layer keying the same
bone channels as an idle does not cover its motion; a rotation is added as it
stands, with no shortest-angle wrap, and an additive entry mixing out fades with its
alpha and is never held. Colour, attachment and event timelines apply as on a
replacing entry. A weight below 1 or an additive entry composes, as a mix does.

`play(name)` keeps meaning what it meant: a plain play on track 0 runs on rig-c's
single live track, which poses everything the core poses. The first call that
composes — a `mix`, a `track` above 0, a `queue`, a `clear` — moves the player onto
the tracks, carrying the single track over by **replay** (its animation set, pose 0
taken, stepped to its time in `seekStep` increments — one pose per step played, so
on a stage that idled a while that is one long frame; the core offers no hand-over
of a live track's state). To never pay it, stand the player on the tracks from the
start: `new RigPlayer(root, assets, { tracks: true })`. Pick the single track for a
rig whose animations key what the tracks do not mix (below); pick the tracks for
layering. Either way, after the first `mix`, `track` above 0, `queue` or `clear`,
`seek` and `skin` are refused by name, since the player cannot replay a composition
to a time — step it forward instead.
Every entry mixes from the setup pose each step, so `adjust` writes still last one
pose. **What the tracks do not mix**, in rig-c's words at `play`/`queue`: an
animation keying a constraint (ik, transform, path, physics, slider), a sequence,
the draw order, or a path's deform is refused when it is set on the tracks — it
plays on the single track only. `'event'` carries `track`; a one-shot that is
mixing out fires nothing. `'complete'` is per track, the player's rule: a looping
entry each cycle, a held one when it reaches its duration, and an entry that is
replaced — by `play`, or by the queued entry that starts at its completion less the
mix — completes no more than it fires.

### Adjusting bones

A per-pose write to bone locals — a breath's scale, a look's rotation, a mouth
driven while the body holds still:

```ts
const player = new RigPlayer(root, assets, {
  adjust: (bones) => { bones.bone('mouth').scaleY = 1 + openness; },
});
player.adjust = null;   // or set it later; setting it re-poses the held pose at once
```

The function runs once per pose, after the animation's timelines and before the
world transforms, constraints and physics — `rig-c/core`'s `openTrack({ adjust })`,
which rig-c holds to the Spine runtime at tolerance 0. **A write lasts one
pose.** The core poses every step from the setup pose, so a value you want held
is written again each pose and nothing compounds; a 0.8 caller that multiplied a
channel on a skeleton it kept between frames writes the value it wants, every
pose. It runs on every pose the animation is applied to, the first one after
`play` included, and `seek` and a `mode` change keep it.

A paused player and a zero step re-pose nothing, so a change the function would
make is not seen until the next step — unless you ask: setting `player.adjust`
re-poses the held pose at the same track time, and `player.repose()` does the
same for a function whose own state changed (the mouth above), without stepping,
firing events or drawing. A non-finite value, a bone the document does not have,
or an error the function throws refuses that step in the core's words, and the
track is reopened by the next `play` or `seek`.

The callback also receives a `BoneAdjustContext` from the core:

```ts
player.adjust = (bones, ctx) => {
  bones.bone('head').rotation = 12 * (ctx.trackTime ?? 0);
};
```

`ctx.trackTime` is the **current track-0 entry's unwrapped seconds**, starting at
0 for each new entry. Loops do not wrap it, and a nonlooping entry keeps counting
past its duration. `ctx.animation` names that entry. Without a track-0 entry both
are null; an explicit empty entry has **numeric trackTime and null animation**.
Upper tracks supply no fallback. `ctx.globalTime` is the core walk's running sum
of steps in seconds, so it can differ from a new entry's time. Neither clock is
wall time, wrapped animation time, nor the physics clock's small lead. Unary
callbacks remain compatible. The hook runs once after composition, including a
crossfade, rather than once for each contributing entry.

Seek evaluates its replay times (`seekStep` plus any final remainder), independent
of the currently displayed player time. Exact cache hits may reuse a pose without
calling the hook. A continuous walk and seek are bit-identical for an **unchanged
patch and matched history**: the same animation, environment, adjustment, reset
and step partition. Closed-over callback state still needs `repose()` or the
adjust setter to invalidate cached poses. Pause, zero advance and renderer mode
changes add no evaluations; explicit `repose()` keeps the same context time.

### Live physics parameters

```ts
player.play('hang');
player.setPhysicsParameters('link_1_phys', { damping: 0.4, wind: 8 });
player.readPhysicsParameters('link_1_phys'); // { override, effective }
player.clearPhysicsParameters('link_1_phys');
```

`setPhysicsParameters(name, patch)` forwards a per-player patch of `strength`,
`damping`, `inertia`, `wind`, `gravity`, and `mix` to the core. Omitted fields keep
their standing override. Values are runtime scalars with no clamping, conversion,
new clock or solver. The core applies them **after authored/keyed values and
sliders, before the integrator**. Unknown constraints, a non-physics constraint,
unknown fields and non-finite/non-number values are refused atomically by name.
These methods require a live track: before `play`/`queue`, set, read and clear
refuse with `no live track` instead of creating one. The model and other players
sharing its assets are untouched.

`PhysicsParameterRead` contains detached readonly snapshots: `override` is the
pending patch or null; `effective` is the six values from the last active
evaluation, or null until evaluated. An inactive constraint can retain its last
active values within that live core instance. Setting or clearing changes no
pose, time or physics state, and **does not evaluate**: effective keeps the last
values until a normal evaluation (or an explicitly requested `repose()`). Clear
removes the patch; authored keys resume at the next evaluation. It preserves
integrated history and does not instantly undo the motion caused by old values.

The player retains the **current standing patch** across new play, seek, skin
replay and promotion to composed tracks. Like `environment()`, it records no
historical changes. **After a mid-run patch change, a backward seek recomputes the
past interval with the patch standing now**, under the current environment; it
does not reproduce the old trajectory across that change. New single tracks and
new composed tracks first evaluate their ordinary authored first pose, then
receive the standing patch as pending, with no extra adjustment callback. At
seek time 0, effective can therefore still be the initial authored value while
override already reports the patch. The next normal core evaluation uses it.
Changing entries on existing composed tracks follows that core instance's
lifetime. Existing seek/skin restrictions after composition remain unchanged.

Set/clear invalidate seek caches without re-posing. Seek snapshots retain the
public effective read alongside their held pose, so backward and exact cache
hits report that pose's evaluation rather than the frontier's latest evaluation.
Readback itself never advances, evaluates or resets physics.

### One load, several players

One `loadModel` backs any number of players: the regions are cut once, and
every player draws from the one `regionImages` map. A player owns none of it —
disposing a player leaves the bitmaps alive for the others — so there is exactly
one `assets.dispose()`, after the last player is gone:

```ts
const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });
const a = new RigPlayer(rootA, assets);
const b = new RigPlayer(rootB, assets, { skin: 'winter' });

a.dispose();
b.dispose();
assets.dispose();
```

A document is one rig. Two rigs whose builds share page images load as two
documents; the images are fetched by URL, so a page both name at the same URL
is loaded once by the browser — but each load cuts its own regions and owns its
own blob URLs.

### Loading it yourself

`loadModel` is a convenience over two calls the package exports: read the
document, load its pages, and cut the regions with `unpackRegions`, which takes
the document's `pages` section — `{ name, width, height, pma, regions: [{ name,
x, y, width, height, degrees }] }` per page — and a map of page images keyed by
those names. Use it when the page images do not come from a URL (`resolvePage`
on `loadModel` covers the ones that come from another URL), and pair it with
`revokeRegions` on unload.

A region the packer stored turned (`degrees: 90`) is cut upright again, and
which way round that is comes from the UVs a runtime assigns such a region,
not from the cut: its corners carry `(u2, v2), (u, v2), (u, v), (u2, v)` in the
order BL, UL, UR, BR, so the artwork's top-left corner sits at the packed rect's
bottom-left and unpacking it is a clockwise turn. Every release up to 0.7.0
turned it the other way and drew rotated rigid parts 180° round (#49).

`unpackRegions` mints one blob URL per region; `revokeRegions` is its
counterpart. It only frees URLs `unpackRegions` created, so a map you built
yourself and page images reused by the whole-page pass-through survive it — and
calling it twice is a no-op. Load once for the page's lifetime and you can
ignore it; load and unload repeatedly without it and you leak an atlas per
cycle.

### Loading for the canvas mode only, and `data:` regions

The region cut makes the rigid tier's bitmaps, which only the DOM mode draws.
`loadModel({ regions })` says what to do about it:

- `'blob'` (default) — `blob:` URLs the load owns; `assets.dispose()` frees them.
- `'data'` — `data:` URLs instead, for a content policy or a snapshot that does
  not carry `blob:`. The same PNG bytes, inline; nothing is minted, so there is
  nothing to free, and the base64 lives as long as the map does.
- `'none'` — no cut: the pages load, `assets.regionImages` is empty, and the
  load is for the canvas mode. A DOM-mode player opened on it — `new RigPlayer`
  without `mode: 'canvas'`, or `player.mode = 'dom'` — is refused by name, and
  a refused mode change leaves the player as it was.

`assets.regions` records the choice. `unpackRegions` takes the same thing as
`{ encoding: 'blob' | 'data' }`.

### Pages that ship at another resolution

A page image may ship at a resolution its document does not declare — a
half-resolution texture build, or an @2x variant, with the page's `width` and
`height` left as the build wrote them. Nothing here needs a flag for that. A
region's bounds are read **relative to the declared page size** and scaled onto
the image's natural size, which is how the page UVs the mesh tier samples with
are derived too (`u = x / page.width`), so both tiers land on the same pixels at
any resolution.

Each unpacked bitmap comes out at the **native resolution of the pixels it was
cut from** — half-resolution pages cost a quarter of the cut pixels, and
nothing is upscaled back — while `RegionImage.width`/`height` stay in **atlas
units**. Those two numbers are the `<img>` layout box and the denominator of
its CSS matrix, so the rig poses identically and the browser scales the
smaller bitmap into the same box, the way a GPU samples a smaller texture
through the same UVs. Ship one build and swap the images per device if you
like (`resolvePage`).

### Premultiplied pages (`pma`)

A page's `pma` flag in the document's `pages` section — the build copies it from
the atlas's `pma: true` line — says its RGB is already multiplied by its alpha,
and nothing is asked of you: each tier is handed the page in the convention it
actually consumes. The `webgl` mesh backend uploads the texels unconverted (its
blend already expects premultiplied source — lossless). The DOM and canvas2d
tiers cannot: an `<img>` and `drawImage` composite straight alpha by definition,
so they read a straight-alpha derivation of the page —
`rgb = round(rgb * 255 / a)`, computed once and shared by the region cuts and
the mesh raster. Without it every semi-transparent texel is multiplied by its
alpha a second time and draws darker than it was authored: soft edges, soft
shadows, glows.

What it costs: **one page-sized canvas per premultiplied page image**
(width × height × 4 bytes — 1 MiB for a 1024×256 page, 16 MiB for a 2048×2048
one), alive as long as the page image is and released with it; the cache is
weak, so there is nothing to free by hand. A page without the flag derives
nothing. The division is 8-bit and starts from a canvas read, which has itself
quantized a premultiplied texel, so a very transparent texel can land a few
levels off — exact at alpha 0 and 255, within one level of 255 above alpha 128,
and a little more below that, by an amount that belongs to the browser's canvas
rather than to this package. It is invisible wherever the texel is: a texel at
alpha 11 is ~4% opaque. The `webgl` backend, having no such step, is exact.

One consequence worth knowing if your build is one part per page: a whole-page
region on a premultiplied page is **cut** rather than handed through, because
the page's own URL holds premultiplied pixels (see below).

### What unloading frees

`revokeRegions()` — and `assets.dispose()`, which calls it — frees the blob URLs
`unpackRegions` minted, and nothing else (a `regions: 'data'` or `'none'` load
minted none, so it frees nothing). The page images are held by
`assets.pageImages` and by every player drawing from them, so a page is
released once you drop the assets and every player is disposed. With the
`webgl` mesh backend the shared blitter also uploads each page image on first
use, but that GL texture is not the module's forever: every renderer drawing
the page holds a reference to it, `player.dispose()` hands those back, and the
texture is deleted once the last renderer using that page is disposed — a later
frame that needs the page uploads it again. The cache is keyed weakly by the
page image, so a renderer dropped without `dispose()` costs GPU memory until
the context is lost, but never keeps the image itself alive.

A rig with meshes samples its page bitmaps every frame, so their decoded form
stays in use: a floor on the order of `page width × page height × 4` bytes per
page. A rigid-only rig draws nothing from the pages after `unpackRegions`, and
what a merely reachable, undrawn image costs is up to the browser, not
measurable from script.

Unload in this order:

1. `player.dispose()`, for every player using the assets.
2. `assets.dispose()` (or `revokeRegions(regionImages)`).
3. Drop your references to the assets.

### One part per page

`rigc build` writes one page per part by default — each part PNG is its own
page, its one region covering it — and `rigc build --pack` arranges the parts
onto shared pages instead. Both play here, unchanged:

- Regions that cover their whole page are handed straight through by
  `unpackRegions` instead of being cut and re-encoded — at any image resolution,
  since covering the page is a statement about the declared size. Load cost for
  this shape is just the image loads. The exception is a page marked `pma`: its
  URL holds premultiplied pixels, which an `<img>` would composite as straight
  alpha, so those regions are cut from the straight-alpha derivation like any
  other (and the blob is revoked by `revokeRegions` like any other).
- A packed build cuts every region from its page once, at load, and its meshes
  sample the shared page through page UVs.

### Runtime knobs and what they cost

- `player.mode` / `new RigPlayer(root, assets, { mode })` — `'dom'` (default)
  or `'canvas'`. Changing it disposes the current renderer (elements removed,
  GPU pages handed back) and creates the other over the same root and assets;
  `pixelRatio` and `clipping` carry over and the held pose is redrawn at once.
  `player.renderer` is then a `CanvasRenderer`, whose knobs are `pixelRatio`,
  `syncPixelRatio()`, `clipping`, `viewport` and `backend`. What each mode costs, as counters:
  - **dom** — one element per drawn slot, one style write per changed slot,
    and the mesh tier's rasters (the knobs below).
  - **canvas** — one canvas element per player and, per frame that changed,
    one pass over every slot: `drawCalls` (one per run of one page under one
    blend), `blendFlushes` (runs a blend change ended), `trianglesDrawn`,
    `blits` (one), or `framesReused` (one) when the record did not change and
    nothing is drawn. It never creates a WebGL context of its own, so any number
    of players stays under the browser's ~16-context cap (20 players, one
    context — `tests/canvas-mode.spec.ts`). The canvas covers a rect of the
    root's coordinates that grows (never shrinks) to what the frames draw —
    `canvasReallocCount` settles at zero — or a fixed `renderer.viewport` (world
    units, Y up) when you set one. Blends are composed inside that canvas, which
    starts transparent: an additive slot adds onto the slots under it and is
    then composited onto the page normally, where the DOM tier's
    `plus-lighter` adds onto the page itself. Where WebGL is unavailable or the
    context is lost, the frame is drawn with canvas2d on the same canvas so it
    never draws nothing — **alpha tint only, RGB and dark tint unsupported
    there** — and that fallback is **not the measured path** (`backendActive`
    says which ran).

- `renderer.pixelRatio` — mesh-canvas backing pixels per CSS pixel (defaults to
  `devicePixelRatio`; if you scale the root element, fold that scale in so the
  raster matches the screen: `devicePixelRatio * rootScale`). **Writing it
  reallocates every mesh canvas backing store on the next frame**, and each
  reallocation recreates a GPU surface — the cost that took real Safari to ~3 fps
  when it happened per frame. Each canvas is then sized from what the new ratio
  needs, in both directions: lowering the ratio gives the backing pixels back
  (the backing is grow-only *within* a ratio, not across a change of one). Set
  it when a layout settles, never per frame:
  debounce resize drags and quantize the value instead of tracking it
  continuously. `renderer.canvasReallocCount` is the check — it must fall back to
  zero within a second or two.
- `renderer.syncPixelRatio()` — measures the root's effective on-screen scale
  and sets `pixelRatio` to `devicePixelRatio × scale`, returning the ratio now
  in effect. It appends a hidden 100 px box to the root, reads its box once and
  removes it (the root itself is usually 0×0), so it is **one forced layout per
  call** — which is exactly why the renderer never calls it for you: there is no
  per-frame layout read anywhere in this library. Call it when a zoom or a
  layout *settles* (gesture end, debounced resize), not during the drag. A
  change under 0.1% is ignored, so layout jitter cannot churn GPU surfaces, and
  a root that is not laid out (a `display: none` ancestor) leaves the ratio
  alone. Under an ancestor rotation the measured box is inflated and the ratio
  errs high — oversampling costs pixels, undersampling costs picture.
- `renderer.meshBackingPixels` — allocated mesh-canvas backing pixels
  (Σ width × height), computed on demand. This is what `pixelRatio` moves
  quadratically, and the cheapest way to see an oversampling stage; the demo
  prints it in the stats line as `backing N Mpx`.
- `renderer.meshBackend` — `'webgl'` (default since 1.9) or `'canvas2d'`; same
  output, and on macOS Safari webgl holds 58–60 fps where canvas2d reads 2–26
  (see Measured above). Falls back to canvas2d automatically when WebGL is
  unavailable or the shared context is lost; `meshBackendActive` says which drew. Switching re-rasters every
  mesh once (no reallocation), so it is fine to expose as a user setting.

  On WebGL context loss (`webglcontextlost`), a player instance falls back to
  `canvas2d` for the rest of its life and never attempts a restore (#193): the
  shared context does not request restoration and ignores
  `webglcontextrestored`, so the very next frame draws on `canvas2d`
  (`meshBackendActive` in `dom` mode, `backendActive` in `canvas` mode) and
  stays there.
- `renderer.triangleExpand` — how far (canvas px) each triangle edge's clip is
  moved outward to close antialiased mesh seams (default 0.5). Also re-rasters every mesh once when changed.
- `renderer.meshSourceRect` — what a canvas2d mesh triangle is drawn from:
  `'page'` (the whole page) or `'triangle'` (a sub-rect covering its clip). Both
  draw the same picture; the default is `'triangle'` on Linux WebKit, which
  garbles whole-page draws, and `'page'` elsewhere, because macOS Safari ran the
  sub-rect 12–15% slower (#25). Also on `CanvasRenderer` for its canvas2d
  fallback. Re-rasters every mesh once when changed.
- `renderer.clipping` — apply the clips the frame carries (default `true`).
  Which slots a clip covers is decided where the frame is made — the player's
  adapter walks the draw order the way the runtime's draw loop does (one clip in
  force at a time, a second one met while one is in force ignored, the end slot
  inside its own clip). What the renderer writes is one CSS `clip-path` per
  element a clip covers, in that
  element's own local frame; nothing reaches the raster backends, and a clip is
  not part of the mesh dirty signature, so a mesh that held still keeps reusing
  its raster under a moving clip. **Writes happen on change only**: each
  clip-path is cached exactly as `transform` is, coordinates are quantized to
  1/1000 of a local unit so float jitter cannot defeat that cache, and a static
  polygon over a static pose therefore costs **zero style writes per frame after
  the first** — `renderer.clipWriteCount` is the check, alongside
  `clipCount` (clips applied) and `clipSkipCount` (clips in the frame not
  applied: switched off, or a degenerate polygon; a clip the runtime itself
  ignores never reaches the frame). **The whole-skeleton fast path**: when one
  clip covers every slot of the frame, one `clip-path` goes on the root instead
  of one per element. The root is *your* element, so its inline `clip-path` is **borrowed,
  not taken** — saved on the first write and put back verbatim when the clip
  stops covering the frame, when `clipping` goes `false`, and by `dispose()`.
  Per-element clip-paths and the root clip-path are never both in force for the
  same clip. Two things to know about that path: the polygon is written in the
  root's **border box** frame, which is where absolutely-positioned slot elements
  start too *unless the root has a CSS border* (a border would offset the
  whole-skeleton clip by its width — keep borders off the render root, which is
  the normal shape for a 0×0 origin element); and an inverse clip never takes it,
  because its CSS form needs an outer ring around a box and the root has none.
  One further consequence of that path: a `clip-path` other than `none` makes an
  element a stacking context (CSS Masking), so a whole-skeleton clip isolates
  `mix-blend-mode` slots from backdrops *outside* the root — which a root
  carrying a `transform` (the usual pan/zoom stage) already does. Per-element
  clips do not change blending, since a blended slot is its own stacking context
  either way. Setting `clipping = false` removes every clip-path this renderer
  wrote.

**A zoomable stage.** The mesh tier rasters at `world × pixelRatio` in the
root's own coordinates, and it cannot see a CSS transform above the root — so
the most natural pan/zoom stage, `transform: scale(zoom)` on an ancestor, makes
it oversample by `1/zoom²` in backing pixels until the zoom is folded in. The
picture stays correct throughout, which is what makes this easy to ship: only
the allocation and the frame rate move. Call `syncPixelRatio()` when the zoom
settles, or set `pixelRatio = devicePixelRatio * zoom` yourself. Measured
on-device (Chromium, dpr 2, stage under `scale(0.25)`, ~2.2 M CSS px on screen):

| scene | `pixelRatio` | `meshBackingPixels` | fps |
| --- | --- | --- | --- |
| 57 meshes | `devicePixelRatio` (2) | 139.1 Mpx | 14–21 |
| 57 meshes | `dpr × zoom` (0.5) | 9.1 Mpx | 61 |
| 92 meshes | `devicePixelRatio` (2) | 141.1 Mpx | 36–39 |
| 92 meshes | `dpr × zoom` (0.5) | 9.1 Mpx | 60–61 |

