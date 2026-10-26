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


## Atlas-backed rigid tier: #213

The follow-up keeps `regions: 'blob'` as the default and adds an explicit
`regions: 'atlas'` path. It paints a native-resolution per-region canvas on
first use, directly from the page, using the cut's same source rectangle,
clockwise restoration and shared straight-alpha derivation. It does not encode
a region PNG, mint a region URL or start idle encoding. Its ready URL map is
empty; `atlasRegions` supplies the separate descriptor contract.

The default was not changed because direct comparisons with the image tier
found browser-composited filtering differences. The native pixel producer
matched the decoded ready regions exactly on Chromium and macOS WebKit; Linux
WebKit's matching-readback control is detailed below. Coverage includes PMA,
blob/data page URLs, half-resolution and rotated artwork. All mesh-only
captures were byte-identical. Composited strict counts are reported alongside
the existing mode-parity metric; the latter's limits were not widened.
The hard checker in named/tilt exceeds the existing test-rig bound at scale
0.4. This is an explicit opt-in caveat, not a passed default-path parity gate.

Two backing policies were compared over all 46 browser/case rows. Native
backing exceeded the existing bounds on three rows: named/tilt on both
browsers, and WebKit cloth/hang under wind [-1, 0] (1.50841%). High-quality,
screen-sized backing rounded upward into ×1.25 bands exceeded on only the two
named rows (3.25028% Chromium, 3.26093% WebKit), with lower WebKit mismatch on
the figure, portrait, look and sets cases. Native backing improved the named
Chromium row (1.79244%) but reduced the margin elsewhere and added the cloth
failure. It was rejected in favour of the banded candidate. This is the
measured tradeoff, not a claim of pixel identity. Both policies reused every
repeated identical frame; scale-band crossings in the retained policy repaint.
No steady-state timing claim is made.

The load harness compares the explicit atlas candidate with the immutable
v1.19.0 blob baseline. Visible-region canvas drawing stays inside first-draw
submission. No region-cuts/PNG span means no calls, not a synthetic zero sample.
It separately records visible-image decode readiness after queue drain and the
following two-rAF paint opportunity; neither is a physical display timestamp.

### Opt-in load comparison

N=12 paired samples per case/cache/arm, alternating order, on the same
Chromium 151.0.7922.34 Linux software-GPU protocol as above. Current-head A/A
was collected before source edits; all 13 baseline source modules matched its
v1.19.0 origin pin. The opt-in run matched the source hashes of its final
Chromium/WebKit raster table. Units below are p50 (IQR), ms. Paired differences
are reduced pair by pair, not differences of the displayed medians. The blob
totals in this run differ from the earlier A/A (raptor warm 73.6 versus 63.6
ms); compare the paired deltas within each run, never subtract across tables.

| Case | Cache | Blob submit | Atlas submit | Official | Paired atlas − blob | Ready delta | Paint-opportunity delta |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| spineboy/dom | cold | 93.4 (13.3) | 72.7 (11.6) | 51.9 (6.9) | -17.9 (4.9) | -25.3 (5.8) | -44.4 (8.1) |
| spineboy/dom | warm | 58.8 (5.7) | 33.3 (6.5) | 9.9 (2.2) | -24.9 (5.7) | -30.7 (5.4) | -50.6 (10.2) |
| raptor/dom | cold | 105.4 (9.4) | 75.9 (7.3) | 50.6 (4.8) | -29.5 (16.5) | -41.0 (17.8) | -47.7 (19.9) |
| raptor/dom | warm | 73.6 (4.7) | 38.7 (5.8) | 11.0 (1.8) | -35.4 (6.5) | -49.0 (5.8) | -57.5 (6.3) |
| wind-wave/dom | cold | 70.1 (4.1) | 73.3 (14.0) | 70.1 (5.3) | 3.2 (11.0) | -1.8 (10.8) | -13.4 (15.4) |
| wind-wave/dom | warm | 33.7 (2.8) | 31.1 (5.2) | 16.3 (1.6) | -2.6 (3.4) | -5.7 (3.7) | -3.4 (8.6) |

“Submit” is the existing load-through-first-draw submission clock, including
visible rigid canvas painting. “Ready delta” adds queue drain and visible-image
decode readiness. The final delta includes the following two-rAF paint
opportunity. These are distinct clocks, not physical display latency; the
preceding A/A did not separately record image decoding. The exclusive pool
was held, but a separate Windows load snapshot showed non-WSL activity, so no
whole-machine-idle claim is made.

The atlas arm had no region-cuts or region-PNG encoder calls in any sample.
Its warm first-frame rigid raster submission was 0.8 (0.1) ms on spineboy,
1.2 (0.1) ms on raptor and 0.9 (0.2) ms on wind-wave. This work remains inside
the measured submit clock. The warm packed-atlas gains exceed the preceding
A/A variation; wind-wave's cold submit delta is positive and noisy, so there
is no uniform gain claim. All paired PosedFrames agreed; the browser dry-run
also checked native region pixels, signed-zero-preserving RawPoses and the
explicit blob/data ready maps outside the timed interval. The named filtering
caveat is the reason this improvement is opt-in rather than the default.

### Linux WebKit native-readback control

The first full suite recorded 487 passed, 13 failed and 2 existing skips.
Eleven failures were strict direct native readback comparisons on Linux
WebKit, not composited parity-limit failures; two were the missing new public
export in the package test's exhaustive expectation, subsequently corrected.
Mesh-only captures still differed by zero screen pixels.

The bounded control used (a) the native canvas read directly, (b) that SAME
canvas encoded to PNG, decoded and read, and (c) the old ready URL decoded and
read. On Linux WebKit, (b) and (c) agreed at every channel on every control rig;
(a) differed only in RGB with 0 < alpha < 255. Alpha, opaque RGB and alpha-zero
RGB were unchanged. Repeating the native producer was also exact. Chromium
and macOS WebKit had direct equality. Thus the strict Linux test compares the
same PNG readback representation, with zero tolerance; it does not widen the
native-pixel limit or encode anything in the production atlas path.

| Linux WebKit input | Direct differing channels | Peak RGB delta | Peak delta × alpha / 255 | Same-path differing channels |
| --- | ---: | ---: | ---: | ---: |
| figure-packed | 45122 | 42 | 1.33333 | 0 |
| figure-packed (PMA flag control) | 34073 | 14 | 1.67843 | 0 |
| flex-packed | 4941 | 42 | 1.49020 | 0 |
| sets-packed | 28041 | 42 | 1.67843 | 0 |
| look-packed | 12414 | 42 | 1.67843 | 0 |
| turned | 0 | 0 | 0.00000 | 0 |
| named | 0 | 0 | 0.00000 | 0 |

The PMA-flag row isolates the producer/readback path on identical input bytes;
it is not an independently painted PMA fixture. The suite's PMA artwork and
composited comparisons remain separate. Signed RGB-delta histograms below
are `PNG readback − direct canvas read`, grouped by alpha bucket for the
straight figure control (zero bins included):

```json
{
  "opaque": {
    "0": 446223
  },
  "translucent": {
    "0": 61042,
    "-42": 176,
    "-28": 96,
    "-23": 200,
    "-21": 340,
    "-19": 1556,
    "-10": 403,
    "-8": 618,
    "-7": 3642,
    "-18": 124,
    "-5": 1167,
    "-4": 6622,
    "-3": 8622,
    "-2": 14544,
    "-12": 84,
    "-11": 252,
    "-1": 3959,
    "-6": 1733,
    "-13": 156,
    "-14": 192,
    "-9": 440,
    "-36": 152,
    "-15": 44
  },
  "transparent": {
    "0": 43620
  }
}
```

One exact pixel tuple (figure `arm_lo`, x=19, y=1): direct RGBA
`[76,48,28,37]`; SAME-canvas PNG roundtrip and ready URL both `[76,41,28,37]`.
The green-channel difference is 7 × 37 / 255 = 1.01569 equivalent
premultiplied levels. Across the controls the maximum was 1.67843, with both
serialized representations still exactly equal. A single-rounding bound of
one level would therefore misclassify this readback difference; the write,
read and encode roundings must be distinguished. These are observed browser
representation differences, not different region selection, rotation or alpha.
