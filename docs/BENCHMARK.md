# Benchmarking @rig-c/play

Moved from the README unchanged (#182). The standing comparison table itself is
the README's [*Measured*](../README.md#measured); what follows it there — where
each side wins and loses, the Safari mesh-backend readings and the 0.x numbers —
is here, then the benchmark that produces the table.


Where each side wins and loses on that table:

- **High-count meshed grids (`36` and `64 meshed rigs animating`) — `official` wins**: batching
  all 64 skeletons into one WebGL canvas holds `59.99 fps` (`5,632 triangles` in `1 draw call`),
  while `canvas` mode drops to `53.99 fps` (per-player `drawImage` blits from the shared WebGL
  context) and `dom` mode drops to `48.28 fps` at 36 rigs and `29.07 fps` at 64 rigs (per-part
  mesh canvas blits + DOM compositing). Up to 16 animating meshed rigs all three hold `60 fps`.
- **Held poses (`1`, `16`, `64 held poses`) — `dom` and `canvas` skip rasterization**: both
  modes reuse their rasters (`0 triangles`, `0 draw calls`), while `official` redraws
  `88` / `1,408` / `5,632 triangles` every frame.
- **Rigid-heavy grids (`64 rigid rigs animating`) — `dom` and batched `official` hold `60 fps`**:
  `dom` updates `<img>` CSS transforms (`0 triangles`, `59.89 fps`), whereas `canvas` pays 64
  per-player `drawImage` blits (`42.00 fps`).
- **Many independent players on one page (`20 small players`) — `dom` and `canvas` draw all 20;
  `official` loses 4 to the browser's 16-context WebGL cap**: both `@rig-c/play` modes share at
  most one WebGL context across the page, while mounting 20 independent `spine-webgl` players
  evicts 4 contexts (`16/20 drawn players`, `16/20 live contexts`).

**The element mode's mesh backend is `'webgl'` by default since 1.9 (#109)**, read off
macOS Safari on 2026-10-13 (1.8.2, gallery rig `look-packed`: 4 meshes, 464
triangles, `sweep`; the demo's stats line after a 30 s settle; the Mac was also
serving the builds, so absolute fps is low and only the comparison is the point —
readings verbatim on #25):

| macOS Safari | 1 rig | 10 rigs (4,640 triangles) |
| --- | --: | --: |
| canvas2d mesh backend | 21–26 fps | 2–3 fps |
| webgl mesh backend | 60 fps | 58 fps |

Nothing is claimed here for mobile browsers: no phone or tablet has been measured
on the 1.x line.

The numbers below are older: measured on the 0.x line, on the spineboy exports it then played (PoC, Apple silicon —
headless and on-device numbers are labeled, they do **not** substitute for each other).
The renderer tiers they describe carried over; they have not been re-measured since the
player moved to rigc's model (#60):

- Rigid only (spineboy-ess), headless Chromium: 10 skeletons / 180 slot images at
  **~0.03 ms skeleton math + ~0.22 ms DOM writes per frame** — about 1.5% of a
  60 fps frame budget. On-device Safari: 10 rigid skeletons hold **60 fps**.
- With meshes (spineboy-pro), headless Chromium: 1 skeleton = **~0.05 ms + ~0.5 ms
  render** (8 mesh canvases, 323 triangles); 10 running skeletons = **~3.5 ms/frame**
  total, smooth.
- Dirty-skip: 10 *static* skeletons (pose held) = **~0.4 ms/frame** headless and
  **~0.6 ms** on-device Safari — unchanged meshes reuse their raster, so idle or
  held parts cost nothing anywhere.
- Real Safari (on-device), canvas2d mesh backend: in-callback JS stays **~4–5
  ms/frame** for 10 running meshed skeletons — but the rAF rate tells the real
  story: **meshed ×1 = 37 fps, meshed ×10 = 3–4 fps** (rigid-only ×10 = 60 fps).
  The cost lives outside the frame callback, in the compositor/GPU process:
  Safari antialiases canvas2d **clip paths**, so every triangle pays for an AA
  mask. Chromium doesn't antialias clips and stays smooth. This is what the
  optional WebGL mesh backend (below) removes.
- Real Safari (on-device), **webgl mesh backend**: meshed ×1 holds **60 fps**
  (vs 37 on canvas2d), and the meshed ×10 stress scene jumps **3–4 → 45 fps** —
  80 mesh canvases / 3230 triangles redrawn every frame (0 reused, the worst
  case), in-callback JS ~5.8 ms at dpr=1. The per-triangle clip-AA tax is gone;
  the remaining gap to 60 is the blit/compositing cost of a 10-skeleton stress
  scene, not a per-triangle cost.
- Headless-WebKit numbers are a **software rasterizer** and measured up to 28×
  off real Safari in both directions — useful for visual regression only, never
  as Safari perf evidence.

## Benchmark: DOM, canvas and official WebGL

```bash
bun run bench:dev     # the page, for a person to watch (and for Safari)
bun run bench         # drives it in a headed Chromium and writes a report
bun run bench --headless # counters only; all timing fields are null
```

`bench/` is a separate vite project — not part of the library, and not part of
what `bun run build` emits — that compares DOM, whole-canvas and the independent
official WebGL reader, each with its own stats line. The paired JSON hash must
match the model before an official comparison can publish readings.
Scenes by query string: `?scene=mesh` (`portrait-packed` turning its head, the
deform tier working every frame), `?scene=held` (the same pose frozen, where
unchanged meshes reuse their raster and an unchanged frame is reused),
`?scene=rigid` (`walk-packed`, region attachments only) and
`?scene=many&count=N` independent players; `?rig=` and `?model=` name another
build. All four take `&count=N` up to 64 (a page limit, so that a cell stays
something you can see), laid out on one grid whose per-rig scale shrinks with
the column count, so a step up in count adds rigs rather than cropping the ones
already there.

**The comparison uses the same framing.** All paths place rigs with one derivation and
clip each to the same rect — the pane for a grid, the rig's own cell for `many`
— with `overflow: hidden` on a box, the way a page embeds a player, and then
*check* it: each side reports `origin Δpx`, the largest gap between where the
grid puts a rig and where that side drew it, and the report table carries it per
row. (`contain: layout paint` is deliberately not used: paint containment clips
to the same edge `overflow: hidden` does, and what it adds past the clip — a
stacking context, a containing block, an independent formatting context —
changes how one side is composited and buys the comparison nothing.) Production
modes retain the package's shared WebGL context. Official grid scenes batch
all skeletons through one context; only `many` uses independent contexts.
Official surviving contexts and drawn players are counted separately from
requested players. Production survival counters are null where its public
API cannot measure them, rather than treating requested counts as survivors.

`scripts/bench.mjs` walks `bench/scenes.json`, opens each scene in a **headed**
Chromium (a hidden page throttles `requestAnimationFrame`, so a headless
reading would be the browser's power policy rather than either mode's cost),
runs a fixed number of frames per mode — one at a time, because rAF has a single
cadence per document — and writes JSON plus a markdown table with the
conditions attached: browser version, device pixel ratio, window size, GPU
string, and the load average before and after. A software or unidentified GPU
invalidates a headed timing report. Over a load threshold it stamps the
whole report `INVALID: load average too high` and exits non-zero, because a
benchmark on a busy machine measures the machine. `--corpus <dir>` points it at
local rigc builds that never enter this repository. `--headless` instead steps
fixed frames and records counters only: FPS, pose/render timing and GPU fields
are null, with “측정 불가: 헤드리스” in JSON and the table. The official
additive-batching and drawing-buffer settings are recorded as conditions.

> **Performance numbers pending.** Counter reports establish the instrument,
> not a performance comparison. A timing reading taken on
> a loaded machine, a CI runner or a headless browser would not be worth
> printing. The table will be taken the way every other number in this README
> was: the stats lines read on a real device, on a quiet machine, per scene
> and per engine — including Safari, which stays manual because no automation
> preserves what is being measured there. Until then the instrument exists and
> the measurement does not.

The server is part of the test: a run tests whatever is being served on its
port. Two checkouts of this repository on one machine (a worktree, a second
clone) default to the same port 4321 and reuse an existing server, so the
second run quietly tests the first one's build — green, and about the wrong
tree. Give each concurrent checkout its own port with `TEST_PORT`
(`TEST_PORT=4333 bun run test`); setting it also disables server reuse, so a
busy port fails the run instead of being borrowed. Unset, nothing changes:
port 4321, reuse unless `CI`.

Standing rule: **headless numbers are never Safari performance evidence** —
nothing in the suite asserts timing, and headless-WebKit fps/ms readings do
not transfer (software rasterizer, measured up to 28× off real Safari). The
perf oracle is the demo's stats line on a real device.

