# Load-profile findings: #203

The default load path is DOM with blob regions and a WebGL mesh backend. Its largest additional warm-load phase on the packed spineboy/raptor fixtures is region PNG encoding and callback drain. Neither candidate tested in this investigation improved total load, so no library source change is retained.

## Protocol and current-head control

N=12 per rig/mode/cache/arm, alternating paired arm order; fresh browser context for cold, second asset load in that context for warm, with a new player/renderer. Baseline source is fetched from origin at v1.19.0 (`06d6cf6264236689a7c6358e002a3e414b653709`). All 13 source modules matched before A/A. The earlier stage-1 source pin predates renderer/player changes and cannot be reused as a current-head A/A.

Chromium 151.0.7922.34 on Linux, SwiftShader; Node 24.21.0 and Bun 1.4.4; rig-c 2.74.0; isolated spine-pixi-v8 4.3.13 / PixiJS 8.22.0. Exclusive timed runs. These are CPU/submission and software-GPU-path readings, not physical-device or display latency. Module imports precede t0. Worker startup and bitmap transfer, when tested, stay inside t0.

The repaired load-only optimizer configuration prevents a missing optional sets.json fallback from triggering late optimization of the normal benchmark’s spine-webgl dependency and removing chunks during a sample. Missing/duplicate instrumentation boundaries are refused.

Every table uses p50 (IQR), ms, unless stated otherwise. Nested phases overlap; PNG and page-load spans use envelopes, synchronous child spans use summed CPU submission time. Paint opportunity and GL drain follow submitMs.

### Current-head warm A/A totals

| Case | Baseline | Same-source arm | Official | Paired same-source − baseline |
| --- | ---: | ---: | ---: | ---: |
| spineboy/canvas | 30.2 (2.1) | 30.3 (3.2) | 9.8 (1.9) | -0.6 (4.1) |
| spineboy/dom | 46.5 (4.2) | 46.2 (2.4) | 9.0 (1.0) | -1.3 (5.6) |
| raptor/canvas | 37.2 (4.6) | 33.4 (6.0) | 11.4 (3.5) | -1.4 (4.6) |
| raptor/dom | 62.2 (6.5) | 62.7 (5.8) | 11.0 (1.4) | -1.5 (5.7) |
| wind-wave/canvas | 29.3 (1.1) | 29.6 (1.6) | 15.9 (0.8) | 0.3 (2.6) |
| wind-wave/dom | 28.1 (1.5) | 29.3 (2.3) | 16.3 (1.4) | 1.2 (1.7) |

## Region-cut subdivision

| Default DOM case / arm | Region cuts | Region draw, summed | PNG wait envelope | Final encode drain tail |
| --- | ---: | ---: | ---: | ---: |
| spineboy/dom / A | 18.0 (1.5) | 0.8 (0.3) | 17.7 (1.5) | 16.3 (1.5) |
| spineboy/dom / A2 | 17.6 (1.7) | 0.6 (0.4) | 17.3 (1.8) | 16.0 (1.7) |
| raptor/dom / A | 26.0 (2.1) | 0.9 (0.2) | 25.8 (2.1) | 23.5 (2.2) |
| raptor/dom / A2 | 26.9 (5.6) | 1.0 (0.3) | 26.6 (5.7) | 24.3 (5.6) |
| wind-wave/dom / A | 0.1 (0.1) | no calls | no calls | no calls |
| wind-wave/dom / A2 | 0.0 (0.1) | no calls | no calls | no calls |

Final encode drain tail is the last encode callback end minus the last encode request start; it includes that request’s submission and overlaps the PNG envelope. It is not a sum of concurrent waits. Its controls cover staggered completions, parallel waits (whose sum would be wrong), no encodes and zero duration.

Both packed atlases state pma:false: page unpremultiplication/readback/arithmetic/writeback had no calls. Spineboy cuts 40 regions (194,742 pixels); raptor cuts 38 (442,917 pixels). The per-region-page wind-wave control passes its pages through and starts no PNG encoder. The second JSON parse is about 1 ms, not the dominant phase.

## Rejected candidates

### Link only the first render mode’s blitter (stage 1, #205)

The first candidate reduced cold shader link calls from two to one and preserved paired frames, but did not improve total load. The two N=12 runs recorded the following raptor DOM cold paired total deltas (candidate minus baseline):

| Run | Paired total delta p50 (IQR), ms |
| --- | ---: |
| 1 | +9.1 (13.6) |
| 2 | +5.9 (14.3) |

A lower link-call count did not establish a load gain. This earlier comparison used the stage-1 source pin; it is retained as a rejected experiment, not combined with the current-head A/A. See [PR #205](https://github.com/rig-c/play/pull/205).

### Worker PNG encoding (stage 2)

One native worker per load encoded the region PNGs while preserving the ready map and keeping startup/bitmap preparation/transfer within the load clock. The first N=12 A/B had no total-load gain:

| DOM case | Cache | Baseline total | Worker total | Official total | Paired worker − baseline |
| --- | --- | ---: | ---: | ---: | ---: |
| spineboy/dom | cold | 84.5 (2.2) | 86.9 (6.6) | 44.9 (1.7) | +2.8 (6.3) |
| spineboy/dom | warm | 45.7 (1.8) | 48.5 (1.5) | 8.9 (0.6) | +2.7 (1.8) |
| raptor/dom | cold | 101.6 (4.0) | 104.6 (6.0) | 49.3 (2.7) | +2.0 (6.7) |
| raptor/dom | warm | 61.1 (7.7) | 64.8 (3.0) | 10.8 (0.6) | +3.7 (7.1) |

| Warm DOM case | Baseline cuts | Worker cuts | Worker startup envelope | Bitmap preparation envelope | Transfer submission, summed |
| --- | ---: | ---: | ---: | ---: | ---: |
| spineboy/dom | 17.5 (0.7) | 20.7 (0.9) | 3.6 (0.3) | 0.1 (0.0) | 0.1 (0.1) |
| raptor/dom | 24.6 (3.2) | 28.6 (2.1) | 4.6 (0.3) | 0.1 (0.0) | 0.1 (0.1) |

The hypothesis was at least 8 ms off raptor’s region cuts. It failed: moving the work did not remove its drain, and startup added cost. Canvas loads and pass-through wind-wave had no worker spans. The candidate was rejected after this result; all library sources were restored byte-for-byte.

The actual-browser dry-run checked first PosedFrame, three RawPoses with signed zero preserved, and decoded pixels of every returned region image: all agreed. Timed runs checked paired frames only. Correctness did not establish a load gain.

## Why deferring the map is not this cut

`DomRenderer.render` dispatches by slot kind. WebGL meshes sample `pageImages`, but `renderRegion` immediately reads `regionImages.get(slot.region).url` into `<img src>`, regardless of mesh backend. The first matching frames contain 10 rigid regions on spineboy and 21 on raptor. `loadModel` awaits all cuts and returns a complete `Map<string, RegionImage>` whose `url` is a string. Deferring those URLs would change both that API and the first DOM picture.

The adapter renderers read atlas pages directly; the site’s player reaches the rigid map through RigPlayer/DomRenderer. Their absence of direct map access does not make the default DOM first-frame URLs unused.

Removing the encoding work by rendering rigid slots from the atlas is the separate [#213](https://github.com/rig-c/play/issues/213). It is not implemented here. See [the load-profile method](../docs/BENCHMARK.md#load-to-first-draw-development-harness) for reproduction commands and timing boundaries.
