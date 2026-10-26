# Third-party notices

## Spine Runtimes

**The published package links nothing from Esoteric Software.** An install of
`@rig-c/play` (or of `rig-play` or `spine-html`, the same files under the names the
package shipped as before) carries one JavaScript module, `dist/index.js`, plus type
declarations, and that module bundles two things: the renderer, and
`rig-c/core` (MIT), rigc's own posing core, which poses the compiled model
document `rigc build` writes. No part of the
[Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes) is in it,
imported by it, or required beside it.

**Development tooling uses the official Spine WebGL runtime.** Issue #39
reintroduces `@esotericsoftware/spine-webgl` 4.3.13 as a pinned devDependency,
with its matching `@esotericsoftware/spine-core` dependency, for the independent
pixel oracle and comparison/benchmark tooling. These are licensed under the
[Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license),
updated April 5, 2025, copyright 2013–2025 Esoteric Software LLC; they are not
covered by this project's MIT licence. Their licence and copyright notices
apply to use and redistribution of that tooling. The earlier removal in #63
remains the history of the production player: no runtime is added back to its
public API or published library. `tests/package.spec.ts` checks the exact
development exception and the runtime-free shipped code and declarations.

The optional load-to-first-draw harness uses `spine-pixi-v8` 4.3.13 with PixiJS
8.22.0 in the separate private `bench/oracle` install. The same upstream Spine
Runtime licence applies to that development reference. It is outside production
source and the library package.

One thing in this repository is Spine data, and it is worth stating where it
sits. `rigc build`, which `scripts/fetch-assets.sh` runs to make the fixtures,
writes **Spine skeleton data** (`skeleton.json` and `skeleton.atlas`) beside
each model document, into the gitignored `public/rigs/`. The development oracle
and comparison tooling read that paired export independently of the model
reader. These generated files are neither committed nor published in the package.

### What that means, as a chain of facts

@rig-c/play's own code is MIT (see `LICENSE`). The following is a restatement of
Esoteric Software's terms, not a licence term of this project:

1. rigc writes two things side by side: the model document this package plays,
   and Spine skeleton data.
2. A product that plays that Spine data with **a Spine Runtime** has integrated
   the Spine Runtimes, licensed under the
   [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license).
3. That licence permits integration **under the terms and conditions of
   Section 2 of the
   [Spine Editor License Agreement](https://esotericsoftware.com/spine-editor-license)**,
   or otherwise **provided that each user of the Products obtains their own
   Spine Editor license** and any redistribution of the Products includes the
   licence and copyright notice — the two routes, in its words.
4. Playing the model document with this package integrates no Spine runtime,
   because the package links none.

> **What a consumer does with rigc's Spine-format output is governed by
> Esoteric Software's terms**, not by this package — @rig-c/play neither adds those
> terms nor removes them.

## Example assets

`scripts/fetch-assets.sh` builds rigc's gallery rigs (procedural art), this
repository's test rigs under `tests/rigs/` (parts painted by
`tests/rigs/make_parts.ts`), and the public parts-built wind-wave fixture.

The optional `scripts/fetch-load-assets.sh` additionally fetches the upstream
spineboy and raptor examples at a fixed spine-runtimes revision for the load
comparison, verifies each input's SHA-256, and keeps each example's upstream
`license.txt` beside its images. These inputs live under gitignored
`public/bench/`; neither the assets nor the development runtime are included
in the npm library package. Their upstream notices remain with the fixtures.
