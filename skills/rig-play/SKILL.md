---
name: rig-play
description: Play a rig built by rigc (skeleton.model.json) on a web page with @rig-c/play — as plain DOM (<img> for rigid slots posed by CSS matrix(), small per-part canvases for deforming meshes) or as one <canvas> per player, with multi-track playback, attachment sets, wind and gravity physics, bone adjustments and live-frame borrowing. Use when the request puts a compiled rig into the DOM or a standalone page canvas, or integrates a custom consumer over LiveFrame or PosedFrame. Not for authoring or compiling a rig (use rigc or rig-parts), retargeting a pose sequence (use rig-pose), or drawing inside PixiJS, Phaser or Three.js (use the rig-pixi, rig-phaser or rig-three skill).
license: MIT
compatibility: Browser ES2022 runtime (DOM and Canvas2D/WebGL). The canonical npm package is @rig-c/play (npm i @rig-c/play; rig-play is the convenience install name, spine-html is the legacy install name). Loads skeleton.model.json written by rigc build (@rig-c/core); bundles its own posing core and links no Esoteric Software runtime.
---

# @rig-c/play — playing a built rig on a web page

Load this when a built rig (`skeleton.model.json` and its page images from
`rigc build`, authored under `--profile rig-play`) goes **onto a web page as DOM
elements or a standalone canvas**, or when a custom renderer consumes
`player.liveFrame()` or `player.posedFrame()`. Every rule below is owned by
[docs/REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md);
this file says when to open it and when an engine adapter is the better route.

## When an engine adapter is the better route

- **The page already runs PixiJS 8, Phaser 4.2+ or Three.js.** Do not stack a
  separate DOM root or second `<canvas>` over an engine canvas: use
  [`@rig-c/pixi`](https://github.com/rig-c/adapters/tree/main/packages/pixi) (`rig-pixi` skill),
  [`@rig-c/phaser`](https://github.com/rig-c/adapters/tree/main/packages/phaser) (`rig-phaser` skill) or
  [`@rig-c/three`](https://github.com/rig-c/adapters/tree/main/packages/three) (`rig-three` skill) so the rig draws
  inside the host's scene graph, camera, draw order and WebGL context while
  posing through `@rig-c/play`.
- **High-count meshed grids.** Where many meshed instances are drawn together,
  batched WebGL draw calls lead DOM/per-player canvas modes; use a host WebGL
  adapter or check the scene tradeoffs in [docs/BENCHMARK.md](https://github.com/rig-c/play/blob/main/docs/BENCHMARK.md#measured).

## Non-negotiables

- **Load `skeleton.model.json`, never a Spine export.** `loadModel` reads
  `rigc-compiled/*` (with `pages`) emitted by `rigc build` and refuses
  `skeleton.json`, `.skel` and `rigc-compiled/1` by name before fetching —
  [REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#status).
- **Layout, Y-up origin and `syncPixelRatio()` belong to the caller.** The root
  element is the rig's world origin (`Y` grows upward); after scaling the root
  or container in CSS, call `player.renderer.syncPixelRatio()` so mesh canvases
  raster at screen size rather than `1 / scale²` —
  [README.md](https://github.com/rig-c/play/blob/main/README.md#a-minimal-page) and
  [REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#runtime-knobs-and-what-they-cost).
- **Respect `LiveFrame` lease lifetime.** `player.liveFrame()` is a borrowed
  buffer valid only until the next pose mutation (`frame`, `seek`, `play`,
  `setAttachmentSet`, physics or bone adjust); call `player.posedFrame()` when a
  detached snapshot must survive later mutations —
  [REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#borrowing-a-live-frame).
- **Dispose player before assets.** Call `player.dispose()` first to remove DOM
  elements and release shared WebGL page-texture references, then
  `assets.dispose()` (or `revokeRegions`) once no player draws from those assets
  so cut region blob URLs are freed —
  [REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#what-unloading-frees).

## What this will not do

- Compile, gate or edit a rig (build with `rigc build --profile rig-play` first).
- Load Spine `skeleton.json` or `.skel` exports, or link any `@esotericsoftware/*` runtime.
- Render two-colour dark tint (`rgb2`) in DOM mode or the canvas2d fallback (supported on `CanvasRenderer`'s WebGL path; [REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#status)).
- Re-measure CSS scale per frame (`syncPixelRatio()` forces a layout read and is caller-invoked only).

## Read, in this order

1. [README.md](https://github.com/rig-c/play/blob/main/README.md#install) —
   `loadModel` + `RigPlayer`, fitting `assets.stage ?? player.bounds()` to a
   container, `syncPixelRatio()` and cleanup (`node_modules/@rig-c/play/README.md` in an install).
2. [docs/REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md) —
   [what ships and what is measured](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#status),
   [wind, gravity and dragging](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#wind-gravity-and-dragging-the-rig),
   [borrowing a live frame](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#borrowing-a-live-frame),
   [attachment sets (`sets.json`)](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#attachment-sets-setsjson),
   [several tracks](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#several-tracks),
   [adjusting bones](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#adjusting-bones),
   [live physics parameters](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#live-physics-parameters),
   [what unloading frees](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#what-unloading-frees) and
   [runtime knobs](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md#runtime-knobs-and-what-they-cost).
3. [docs/MIGRATION.md](https://github.com/rig-c/play/blob/main/docs/MIGRATION.md) and
   [docs/BENCHMARK.md](https://github.com/rig-c/play/blob/main/docs/BENCHMARK.md).

`docs/` lives in the GitHub repository and is not packed into `node_modules/@rig-c/play`;
the installed package carries `README.md` and the exact TypeScript declarations
under `node_modules/@rig-c/play/dist/*.d.ts`.
