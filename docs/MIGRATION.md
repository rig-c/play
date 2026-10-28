# Migrating to @rig-c/play

Moved from the README unchanged (#182): the 1.8 → 1.9 mesh backend default, and
the `spine-html` 0.8 → 1.0 guide.

## Adding live-frame consumers

`posedFrame()` keeps its detached snapshot contract. Existing callers may retain
it across `advance()` calls. There is no migration that turns that snapshot into
a volatile view.

For a consumer that draws immediately, borrow the runtime buffers instead:

```ts
player.advance(dt);
renderer.render(player.liveFrame());
```

The built-in DOM and canvas renderers accept this view as well as `PosedFrame`.
Custom renderers read attachment indices from `drawOrder[0..count)`, then use
that attachment's vertex offset/count and static UV/index/page metadata. Tint
is indexed by setup slot, `slotIndex * 4`. Do not save the live frame, its nested
buffers or attachment views for a later pose. Development stale-view checks
refuse those reads; production reuses the same buffers without per-borrow
leases. Call `posedFrame()` when retaining data is required.

Selection is automatic for covered models and animations; inspect `player.poser`
for the named oracle fallback. Unsupported tracks, sets and adjustments preserve
the old semantics on that path. Covered events reach the existing listener API, including when a listener
re-enters the player. Supported skin switches preserve wrapped animation time.
No event waiver or silent feature drop is used.
The oracle live view may allocate; development diagnostic leases also allocate.
Neither is evidence for the production runtime's allocation bar. The raw view's
oracle `placeholder` is `null`, not a display-name guess.

## Coming from 1.8: meshes draw through WebGL by default

From 1.9 the element mode rasterizes its meshes through the one shared WebGL
context unless told otherwise (`DomRenderer.meshBackend` defaults to `'webgl'`,
#109). The picture is the same within the parity suite's bounds, the API is
unchanged, and canvas2d is still drawn wherever WebGL is unavailable or the
context is lost. What a caller can notice:

- The page holds one more WebGL context (one for every mesh of every player, not
  one per player). A page already near the browser's cap of about 16 live
  contexts can lose its oldest one when this one is created.
- `meshBackendActive` reads `'webgl'` where it read `'canvas2d'`.
- Frame cost moves from the page to the GPU blit (see *Measured*).

To keep 1.8's raster, set it back, up front or on a live player:

```ts
const player = new RigPlayer(root, assets, { meshBackend: 'canvas2d' });
// or, on a renderer you hold:
renderer.meshBackend = 'canvas2d';
```

The canvas mode was already webgl by default and does not change.

## Coming from spine-html 0.8

This is not a drop-in upgrade. 0.8 drew a Spine export (`.json` or `.skel`, plus its
`.atlas`) that `@esotericsoftware/spine-core` parsed and posed: the caller built the
`Skeleton` and the `AnimationState`, advanced them each frame, and handed the skeleton to
`renderer.render(skeleton)`. 1.0 loads one file, the `skeleton.model.json` that
`rigc build` writes, poses it through `rig-c/core` (bundled into the package, with no peer
dependency), and `RigPlayer` owns the track, so the caller's frame is `player.frame(dt)`.
A Spine export is refused by name before anything is fetched: the data has to be a rigc
build, and this package declares no loader for anything else.

What did not move: a positioned root element is still the rig's origin (Y up) with its
layout and scaling left to the caller, the DOM tier keeps its knobs under a new class
name, and unloading is still elements first, bitmaps second.

### 0.8 → 1.0

| 0.8.0 (`spine-html`) | 1.x (`@rig-c/play`, formerly `rig-play`) | Note |
| --- | --- | --- |
| `npm i spine-html @esotericsoftware/spine-core` | `npm i @rig-c/play`, and `npm i -D @rig-c/core` for the build tool | 0.8 declared spine-core as a peer dependency (`>=4.0.0 <4.4.0`). 1.0.0 declares no dependencies and no peer dependencies. |
| `loadSkeletonAssets(options)` | `loadModel(options)` | One URL instead of two. The `.atlas` and `skeleton.json` a build writes beside the document are not fetched. |
| `LoadSkeletonAssetsOptions.atlasUrl`, `skeletonUrl` | `LoadModelOptions.modelUrl` | |
| `resolvePage(pageName, atlasUrl)` | `resolvePage(pageName, modelUrl)` | The default now resolves a page name against the model URL's directory. |
| `crossOrigin`, `fetch` | `crossOrigin`, `fetch` | Unchanged. |
| `scale` (`LoadSkeletonAssetsOptions`, `LoadSkeletonJsonOptions`) | none | See below. |
| `SkeletonAssets` | `ModelAssets` | |
| `SkeletonAssets.data` | `ModelAssets.document`, `animations`, `skins`, `stage`, `spec` | `document` is opaque (`ModelDocument`); the player poses it. What a caller used to read off the skeleton data is stated as `animations` (name and duration), `skins` (names) and `stage` (the stage the build declared, or null). |
| `SkeletonAssets.atlas` | `ModelAssets.pageImages` | The page images, keyed by page name. There is no atlas object; where each region sits is in the document's `pages` section. |
| `SkeletonAssets.regionImages` | `ModelAssets.regionImages` | Same `Map<string, RegionImage>`. |
| `SkeletonAssets.dispose()`, `AtlasAssets.dispose()` | `ModelAssets.dispose()` | Same contract: frees the blob URLs the load minted, idempotent, called after the players are disposed. |
| `loadAtlasAssets` + `loadSkeletonJson` (one atlas, several skeletons) | none | One `loadModel` backs any number of `RigPlayer`s of the same rig. Two rigs are two loads, and each cuts its own regions. See below. |
| `loadSkeletonBinary` from `spine-html/binary` | none | 1.0.0 has one entry point. A `.skel` URL is refused by name. |
| `unpackRegions(atlas, pageImages)` | `unpackRegions(pages, pageImages)` | The first argument is the document's `pages` section (`readonly PageLayout[]`) instead of a `TextureAtlas`. |
| `revokeRegions(images)` | `revokeRegions(images)` | Unchanged. |
| `RegionImage` | `RegionImage` | Unchanged (`url`, `width`, `height`, in atlas units). |
| `DomTexture` | none | Not exported; there is no atlas page to attach a texture to. |
| `new Skeleton(assets.data)` and `new AnimationState(new AnimationStateData(assets.data))` | `new RigPlayer(root, assets, options?)` | The player holds the pose and the track. |
| `state.setAnimation(0, 'walk', true)` | `player.play('walk', { loop: true })` | `loop` defaults to true. `play` opens the animation at its first pose with the physics reset there. `player.current` names what is playing. |
| `skeleton.findSlot('x').attachment = null` to hide a slot, or a second skeleton with slots emptied | `RigPlayerOptions.slots`, `player.slots`, `player.posedFrame(slots)` | A draw filter since 1.6.0 — the pose is the whole rig's; a clipping slot left out does not clip. See *Drawing some slots only*. |
| `state.setAnimation(1, 'smile', false)` with a mix, `addAnimation`, `setEmptyAnimation`, `addEmptyAnimation`, `getCurrent(track)`, `entry.alpha`, `entry.additive` | `player.play(name, { track, loop, mix, alpha, additive })`, `player.queue(name, { track, loop, mix, delay, alpha, additive })`, `player.clear(track, { mix })`, `player.queueClear(track, { mix, delay })`, `player.setAlpha(track, alpha)`, `player.entry(track)` | Since 1.5.0, rig-c's live tracks: the runtime's mixing at tolerance 0. Constraint, sequence, draw-order and path-deform timelines are not mixed and are refused on the tracks. See *Several tracks*. |
| `state.update(delta)`, `state.apply(skeleton)`, `skeleton.update(delta)`, `skeleton.updateWorldTransform(Physics.update)`, `renderer.render(skeleton)` | `player.frame(dt)` | Or `player.advance(dt)` then `player.draw()`, to time the two apart. |
| time scale (the caller's own, on the spine-core side) | `player.timeScale` | Multiplies every step. 0 holds the pose without re-posing it; a negative value is not stepped. |
| holding a pose (the caller stopped advancing) | `player.pause()`, `player.resume()` | `frame` keeps drawing the held pose. |
| moving to a time (the caller's own, on the spine-core side) | `player.seek(time)`, `RigPlayerOptions.seekStep`, `player.time` | A seek reopens the animation and steps forward in `seekStep` increments (1/60 s by default). Events and completes crossed on the way are not fired. |
| events (the caller's own listener on the spine-core side) | `player.on('event', listener)`, `player.on('complete', listener)` | `'event'` hands a `RigEvent` (`name`, `time`, `int`, `float`, `string`, `track`); `'complete'` hands `{ animation, track }`. `on` returns a function that removes the listener. |
| skin (set by the caller on its `Skeleton`) | `RigPlayerOptions.skin`, `player.skin` | A constructor option, and settable on a live player since 1.4.0: the pose re-resolves under the new skin and the track keeps its animation, loop and time (reopened and stepped there, as `seek` does). The names are in `ModelAssets.skins`. Without it the rig is posed with no skin set. |
| `SpineHtmlRenderer` | `DomRenderer`, reached as `player.renderer` | In `mode: 'dom'`, the default. `mode: 'canvas'` is new and makes `player.renderer` a `CanvasRenderer`. |
| `new SpineHtmlRenderer(root, regionImages)` | `new DomRenderer(root, regionImages, pages?)` | Only for drawing your own frames; `RigPlayer` constructs its renderer. `pages` is the page-image map the mesh tier samples (`ModelAssets.pageImages`). A hand-built `regionImages` map is still accepted. |
| `renderer.render(skeleton)` | `renderer.render(frame)` | Takes a `PosedFrame`, not a skeleton. `player.posedFrame()` returns the one the player would draw. |
| `renderer.pixelRatio` | `player.renderer.pixelRatio` | On both renderers. Carried over when `player.mode` changes. |
| `renderer.syncPixelRatio()` | `player.renderer.syncPixelRatio()` | On both renderers, the same meaning and the same deadband (since 1.3.0; before it, DOM mode only). |
| `renderer.meshBackingPixels` | `DomRenderer.meshBackingPixels` | DOM mode only. |
| `renderer.meshBackend`, `meshBackendActive`, type `MeshBackend` | `DomRenderer.meshBackend`, `meshBackendActive`, type `MeshBackend` | Same values; the default is `'webgl'` since 1.9 (`'canvas2d'` before). Also settable up front as `RigPlayerOptions.meshBackend`. |
| `renderer.triangleExpand` | `DomRenderer.triangleExpand` | Same default (0.5). |
| `renderer.clipping` | `player.renderer.clipping` | On both renderers. Carried over when `player.mode` changes. |
| `clipCount`, `clipSkipCount`, `clipWriteCount` | same names on `DomRenderer` | `clipSkipCount` counts less than it did: a second clip met while one is in force, and a clip on an inactive bone, no longer reach the frame, so they are not counted. |
| `meshCount`, `meshReuseCount`, `canvasReallocCount`, `triangleCount` | same names on `DomRenderer` | |
| tint: skeleton × slot × attachment colour | `player.color` × slot × attachment | `player.color` is `[r, g, b, a]` and takes the place of the skeleton's colour. The product arrives as `tint` on each `PosedSlot`. |
| dark (two-colour) tint: unsupported | `DomRenderer`: unsupported. `CanvasRenderer`: drawn | Carried as `dark` on a `PosedSlot`. The canvas mode's canvas2d fallback draws alpha only. |
| `renderer.dispose()` | `player.dispose()` | Then `assets.dispose()`, as before. `DomRenderer.dispose()` and `CanvasRenderer.dispose()` exist for a renderer you constructed yourself. |
| `skeleton.findBone('head').worldX`, `.worldY`, `.a` … `.d` | `player.bone('head')` | `{ x, y, a, b, c, d, rotationX, rotationY, scaleX, scaleY, active }`, the core's world transform for the pose the player holds (the setup pose before `play`). An unknown name is refused by name. Since 1.1.0. |
| `bone.scaleY = …` on a `Skeleton` between `state.apply` and `updateWorldTransform` | `RigPlayerOptions.adjust`, `player.adjust`, `player.repose()` | A function `(bones, ctx)` called once per pose with the pose's bone locals and current-entry context (unary callbacks remain valid) (`bones.bone('mouth').scaleY = v`). A write lasts one pose: the core poses every step from the setup pose, so write the value you want, every pose — nothing compounds. See *Adjusting bones*. Since 1.2.0. |
| `skeleton.getBounds(offset, size)` | `player.bounds()` | `{ x, y, width, height }` or null, world units, Y up: the box of every drawn region's corners and mesh's vertices, a slot under a clip counted inside the clip's own box. `ModelAssets.stage` remains the declared framing, not this box. Since 1.1.0. |
| live named physics constraint tuning | `player.setPhysicsParameters(name, patch)`, `readPhysicsParameters(name)`, `clearPhysicsParameters(name)` | Six scalar fields, per-player pending patch plus last evaluated effective values. Clear resumes authored values without resetting history. Replay uses the current standing patch, with no historical journal. See *Live physics parameters*. |
| named setup mesh geometry | `readSetupMesh(assets, { slot, attachment, skin? })` | Detached full-double world x/y (Y up), triangles and hull for any named mesh/linked mesh, including non-setup selections; no player/time mutation. Selected geometry includes setup-slider deform; unselected geometry is stored geometry through unchanged setup matrices. See the measured official-runtime distinction under *Reading the pose*. |

### No counterpart in 1.0.0

Things a 0.8 caller could do because it held the spine-core objects, or through a 0.8
export, for which 1.0.0 declares nothing:

- **A Spine export as input.** `loadSkeletonJson`, `loadSkeletonBinary`, `loadAtlasAssets`,
  the `spine-html/binary` entry and `DomTexture` have no counterpart, and neither does
  choosing which spine-core generation reads the data. `loadModel` reads a compiled model
  document and nothing else.
- **Scaling the skeleton as it is read.** `LoadModelOptions` declares no `scale`. Scaling
  the root element is still the caller's.
- **One unpacked atlas shared by different skeletons.** A document is one rig, and each
  `loadModel` cuts its own regions and owns its own blob URLs. Sharing is per rig: one
  load, several players.
- **Changing one slot from code** (its attachment, its colour). `RigPlayer` declares only
  the whole-rig `color`. The frame record is a plain object, so a caller that draws its
  own frames through `DomRenderer.render` or `CanvasRenderer.render` decides what is in
  it.
- **Choosing how physics is stepped each frame.** 0.8's loop passed `Physics.update`
  itself; 1.0.0 declares no physics option. `play` and `seek` reset physics at the
  animation's first pose and every step advances it.
- **Track callbacks other than the two declared.** `on` accepts `'event'` and
  `'complete'`.

Knobs on `DomRenderer` that `CanvasRenderer` does not declare:

- `meshBackend` and `meshBackendActive`. The canvas mode has its own pair, `backend` and
  `backendActive` (type `CanvasBackend`, `'webgl'` by default).
- `triangleExpand`, `meshBackingPixels`, `clipWriteCount`, `meshCount`, `meshReuseCount`,
  `triangleCount`. The canvas mode's counters are `drawCalls`, `blendFlushes`,
  `trianglesDrawn`, `framesReused` and `blits`.

Both declare `pixelRatio`, `clipping`, `clipCount`, `clipSkipCount`, `canvasReallocCount`,
`render` and `dispose`. Only `pixelRatio` and `clipping` carry over when `player.mode`
changes.

### Before and after

0.8.0:

```ts
import { Skeleton, AnimationState, AnimationStateData, Physics } from '@esotericsoftware/spine-core';
import { loadSkeletonAssets, SpineHtmlRenderer } from 'spine-html';
const assets = await loadSkeletonAssets({ atlasUrl: '/hero/hero.atlas', skeletonUrl: '/hero/hero.json' });
const skeleton = new Skeleton(assets.data);
const state = new AnimationState(new AnimationStateData(assets.data));
state.setAnimation(0, 'walk', true);
const renderer = new SpineHtmlRenderer(rootElement, assets.regionImages);
function frame(delta: number) {
  state.update(delta);
  state.apply(skeleton);
  skeleton.update(delta);
  skeleton.updateWorldTransform(Physics.update);
  renderer.render(skeleton);
}
renderer.dispose(); assets.dispose(); // on unload
```

1.0.0:

```ts
import { loadModel, RigPlayer } from '@rig-c/play';
const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });
const player = new RigPlayer(rootElement, assets);
player.play('walk', { loop: true });
function frame(delta: number) {
  player.frame(delta);
}
player.dispose(); assets.dispose(); // on unload
```

